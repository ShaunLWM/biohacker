import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { VmTerminationReason } from "@biohacker/shared";
import type { FastifyBaseLogger } from "fastify";
import { runCommand } from "./command.js";
import type { DaemonConfig } from "./config.js";
import { sendCtrlAltDel } from "./firecracker-api.js";
import {
	allocateNetwork,
	cleanupNetwork,
	configureIptables,
	configureTap,
} from "./firecracker-network.js";
import {
	configureMicroVm,
	isProcessAlive,
	launchFirecracker,
	waitForProcessExit,
	waitForSsh,
} from "./firecracker-process.js";
import { cloneBaseImage, customizeRootfs } from "./firecracker-rootfs.js";
import {
	createManagedVm,
	createRuntimePaths,
	persistRuntime,
	readPersistedRuntime,
} from "./firecracker-runtime-schema.js";
import { ensureDir, removePath } from "./fs-utils.js";
import { getDaemonLabTemplate } from "./lab-templates.js";
import type {
	FirecrackerRuntime,
	ManagedVm,
	VmCreationResult,
	VmReservation,
	VmRunner,
} from "./types.js";

export class FirecrackerRunner implements VmRunner {
	constructor(
		private readonly config: DaemonConfig,
		private readonly logger: FastifyBaseLogger,
	) {}

	protected isProcessAlive = isProcessAlive;

	async reconcile(): Promise<ManagedVm[]> {
		await ensureDir(this.config.INSTANCE_BASE_DIR);
		const entries = await readdir(this.config.INSTANCE_BASE_DIR, {
			withFileTypes: true,
		});
		const restored: ManagedVm[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			const instanceDir = join(this.config.INSTANCE_BASE_DIR, entry.name);
			const metadataPath = join(instanceDir, "runtime.json");

			try {
				const { runtime, migratedFromLegacy } = await readPersistedRuntime(
					instanceDir,
					metadataPath,
					this.config,
				);
				const managedVm = createManagedVm(runtime, this.config.HOST_PUBLIC_IP);

				if (
					runtime.firecrackerPid <= 0 ||
					!(await this.isProcessAlive(runtime.firecrackerPid))
				) {
					this.logger.warn(
						{ instanceDir, pid: runtime.firecrackerPid, id: runtime.id },
						"Cleaning up abandoned Firecracker instance from a previous daemon run",
					);
					await this.cleanupRuntime(runtime);
					continue;
				}

				if (new Date(runtime.expiresAt).getTime() <= Date.now()) {
					this.logger.warn(
						{ id: runtime.id, expiresAt: runtime.expiresAt },
						"Cleaning up expired Firecracker instance during daemon startup",
					);
					await this.cleanupRuntime(runtime);
					continue;
				}

				if (migratedFromLegacy) {
					await persistRuntime(runtime);
					this.logger.info(
						{ id: runtime.id, metadataPath },
						"Migrated legacy Firecracker runtime metadata during daemon startup",
					);
				}

				restored.push(managedVm);
			} catch {
				await removePath(instanceDir);
			}
		}

		return restored;
	}

	async create(reservation: VmReservation): Promise<VmCreationResult> {
		const network = allocateNetwork(
			this.config.GUEST_NETWORK_BASE,
			this.config.SSH_PORT_RANGE_START,
			reservation.sshPort,
		);
		const instanceDir = join(this.config.INSTANCE_BASE_DIR, reservation.id);
		const runtime = createRuntimePaths(instanceDir, reservation, network);
		let step = "create-instance-dir";

		await ensureDir(instanceDir);
		await runCommand("chmod", ["700", instanceDir]);
		this.logger.info(
			{
				id: reservation.id,
				sshPort: reservation.sshPort,
				guestIp: runtime.guestIp,
				tapName: runtime.tapName,
			},
			"Creating Firecracker VM",
		);

		try {
			step = "persist-runtime-initial";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await persistRuntime(runtime);
			step = "clone-base-image";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await cloneBaseImage(
				this.config.BASE_IMAGE_PATH,
				runtime.writableRootfsPath,
			);
			step = "customize-rootfs";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await customizeRootfs(runtime);
			step = "configure-tap";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await configureTap(runtime.tapName, runtime.hostTapIp);
			step = "configure-iptables";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await configureIptables(
				runtime.tapName,
				this.config.HOST_INTERFACE,
				this.config.HOST_PUBLIC_IP,
				runtime.subnetCidr,
				runtime.guestIp,
				reservation.sshPort,
			);

			step = "launch-firecracker";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			const pid = await launchFirecracker(
				this.config.FIRECRACKER_BIN,
				runtime.apiSocketPath,
				runtime.stdoutLogPath,
				runtime.stderrLogPath,
			);
			runtime.firecrackerPid = pid;
			step = "persist-runtime";
			this.logger.info({ id: reservation.id, step, pid }, "VM create step");
			await persistRuntime(runtime);

			step = "configure-microvm";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await configureMicroVm(
				runtime.apiSocketPath,
				runtime.writableRootfsPath,
				runtime.tapName,
				runtime.guestMac,
				{
					vcpuCount: this.config.VM_VCPU_COUNT,
					memoryMib: this.config.VM_MEMORY_MIB,
					kernelImagePath: this.config.KERNEL_IMAGE_PATH,
				},
			);
			step = "wait-for-ssh";
			this.logger.info(
				{ id: reservation.id, step, guestIp: runtime.guestIp },
				"VM create step",
			);
			await waitForSsh(
				this.config.HOST_PUBLIC_IP,
				reservation.sshPort,
				this.config.SSH_BOOT_TIMEOUT_MS,
			);
			this.logger.info(
				{
					id: reservation.id,
					sshPort: reservation.sshPort,
					guestIp: runtime.guestIp,
				},
				"Firecracker VM is ready for SSH",
			);

			return {
				instance: createManagedVm(runtime, this.config.HOST_PUBLIC_IP),
				launchInstructions: getDaemonLabTemplate(
					runtime.templateId,
				).launchInstructions({ username: runtime.username }),
				secret: getDaemonLabTemplate(runtime.templateId).createSecret(),
			};
		} catch (error) {
			this.logger.error(
				{ err: error, id: reservation.id, step },
				"VM create step failed",
			);

			if (this.config.PRESERVE_FAILED_VM_STATE) {
				this.logger.warn(
					{
						id: reservation.id,
						instanceDir: runtime.instanceDir,
						pid: runtime.firecrackerPid,
						tapName: runtime.tapName,
						guestIp: runtime.guestIp,
						sshPort: runtime.sshPort,
					},
					"Preserving failed VM state for debugging",
				);
			} else {
				await this.cleanupRuntime(runtime);
			}

			throw error;
		}
	}

	async shutdown(instance: ManagedVm, _reason: VmTerminationReason) {
		if (instance.runtime.kind !== "firecracker") {
			return;
		}

		const runtime = instance.runtime;
		this.logger.info(
			{ id: instance.record.id, sshPort: instance.record.sshPort },
			"Shutting down Firecracker VM",
		);

		try {
			await sendCtrlAltDel(runtime.apiSocketPath);
		} catch {
			// Fall back to process termination below.
		}

		await waitForProcessExit(runtime.firecrackerPid, 10_000);
		await this.cleanupRuntime(runtime);
	}

	private async cleanupRuntime(runtime: FirecrackerRuntime) {
		this.logger.info(
			{
				sshPort: runtime.sshPort,
				tapName: runtime.tapName,
				guestIp: runtime.guestIp,
			},
			"Cleaning up Firecracker runtime resources",
		);

		if (
			runtime.firecrackerPid > 0 &&
			(await this.isProcessAlive(runtime.firecrackerPid))
		) {
			try {
				process.kill(runtime.firecrackerPid, "SIGTERM");
			} catch {
				// ignore
			}

			await waitForProcessExit(runtime.firecrackerPid, 5_000);
		}

		await cleanupNetwork(
			runtime.tapName,
			this.config.HOST_INTERFACE,
			this.config.HOST_PUBLIC_IP,
			runtime.subnetCidr,
			runtime.guestIp,
			runtime.sshPort,
		);
		await removePath(runtime.instanceDir);
	}
}
