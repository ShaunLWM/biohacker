import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { basename, join } from "node:path";
import { labTemplates, type VmTerminationReason } from "@biohacker/shared";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { runCommand } from "./command.js";
import type { DaemonConfig } from "./config.js";
import {
	putBootSource,
	putDrive,
	putMachineConfig,
	putNetworkInterface,
	sendCtrlAltDel,
	startInstance,
} from "./firecracker-api.js";
import {
	ensureDir,
	readJsonFile,
	removePath,
	writeTextFile,
} from "./fs-utils.js";
import { getDaemonLabTemplate } from "./lab-templates.js";
import type {
	FirecrackerRuntime,
	ManagedVm,
	VmCreationResult,
	VmReservation,
	VmRunner,
} from "./types.js";

const DEFAULT_NAMESERVERS = ["1.1.1.1", "8.8.8.8"];

interface LegacyFirecrackerRuntime {
	sshPort: number;
	firecrackerPid: number;
	tapName: string;
	subnetCidr: string;
	hostTapIp: string;
	guestIp: string;
	guestMac: string;
	apiSocketPath: string;
	instanceDir: string;
	writableRootfsPath: string;
	stdoutLogPath: string;
	stderrLogPath: string;
	metadataPath?: string;
	[key: string]: unknown;
}

const firecrackerTemplateIdSchema = z.custom<FirecrackerRuntime["templateId"]>(
	(value): value is FirecrackerRuntime["templateId"] =>
		typeof value === "string" && labTemplates.some((item) => item.id === value),
);

const firecrackerRuntimeSchema: z.ZodType<FirecrackerRuntime> = z.object({
	kind: z.literal("firecracker"),
	id: z.string().min(1),
	templateId: firecrackerTemplateIdSchema,
	username: z.string().min(1),
	createdAt: z.string().datetime(),
	expiresAt: z.string().datetime(),
	sshPort: z.number().int().positive(),
	instanceDir: z.string().min(1),
	apiSocketPath: z.string().min(1),
	firecrackerPid: z.number().int(),
	tapName: z.string().min(1),
	subnetCidr: z.string().min(1),
	hostTapIp: z.string().min(1),
	guestIp: z.string().min(1),
	guestMac: z.string().min(1),
	writableRootfsPath: z.string().min(1),
	stdoutLogPath: z.string().min(1),
	stderrLogPath: z.string().min(1),
	metadataPath: z.string().min(1),
});

const legacyFirecrackerRuntimeSchema: z.ZodType<LegacyFirecrackerRuntime> = z
	.object({
		sshPort: z.number().int().positive(),
		firecrackerPid: z.number().int(),
		tapName: z.string().min(1),
		subnetCidr: z.string().min(1),
		hostTapIp: z.string().min(1),
		guestIp: z.string().min(1),
		guestMac: z.string().min(1),
		apiSocketPath: z.string().min(1),
		instanceDir: z.string().min(1),
		writableRootfsPath: z.string().min(1),
		stdoutLogPath: z.string().min(1),
		stderrLogPath: z.string().min(1),
		metadataPath: z.string().min(1).optional(),
	})
	.passthrough();

export class FirecrackerRunner implements VmRunner {
	constructor(
		private readonly config: DaemonConfig,
		private readonly logger: FastifyBaseLogger,
	) {}

	async reconcile() {
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
				await access(metadataPath, constants.R_OK);
				const { runtime, migratedFromLegacy } = await this.readPersistedRuntime(
					instanceDir,
					metadataPath,
				);
				const managedVm = this.createManagedVm(runtime);

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
					await this.persistRuntime(runtime);
				}

				restored.push(managedVm);
			} catch {
				await removePath(instanceDir);
			}
		}

		return restored;
	}

	async create(reservation: VmReservation): Promise<VmCreationResult> {
		const network = this.allocateNetwork(reservation.sshPort);
		const instanceDir = join(this.config.INSTANCE_BASE_DIR, reservation.id);
		const runtime = this.createRuntimePaths(instanceDir, reservation, network);
		let step = "create-instance-dir";

		await ensureDir(instanceDir);
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
			await this.persistRuntime(runtime);
			step = "clone-base-image";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.cloneBaseImage(runtime.writableRootfsPath);
			step = "customize-rootfs";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.customizeRootfs(runtime);
			step = "configure-tap";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.configureTap(runtime);
			step = "configure-iptables";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.configureIptables(runtime, reservation.sshPort);

			step = "launch-firecracker";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			const pid = await this.launchFirecracker(runtime);
			runtime.firecrackerPid = pid;
			step = "persist-runtime";
			this.logger.info({ id: reservation.id, step, pid }, "VM create step");
			await this.persistRuntime(runtime);

			step = "configure-microvm";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.configureMicroVm(runtime);
			step = "wait-for-ssh";
			this.logger.info(
				{ id: reservation.id, step, guestIp: runtime.guestIp },
				"VM create step",
			);
			await this.waitForSsh(this.config.HOST_PUBLIC_IP, reservation.sshPort);
			this.logger.info(
				{
					id: reservation.id,
					sshPort: reservation.sshPort,
					guestIp: runtime.guestIp,
				},
				"Firecracker VM is ready for SSH",
			);

			return {
				instance: this.createManagedVm(runtime),
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

		await this.waitForProcessExit(runtime.firecrackerPid, 10_000);
		await this.cleanupRuntime(runtime);
	}

	private allocateNetwork(sshPort: number) {
		const base = this.parseIpv4(this.config.GUEST_NETWORK_BASE);
		const index = sshPort - this.config.SSH_PORT_RANGE_START;
		const subnet = base + index * 4;
		const hostTapIp = this.formatIpv4(subnet + 1);
		const guestIp = this.formatIpv4(subnet + 2);
		const subnetCidr = `${this.formatIpv4(subnet)}/30`;
		const guestMac = this.guestMacFromIp(guestIp);

		return {
			hostTapIp,
			guestIp,
			subnetCidr,
			guestMac,
		};
	}

	private createRuntimePaths(
		instanceDir: string,
		reservation: VmReservation,
		network: {
			hostTapIp: string;
			guestIp: string;
			subnetCidr: string;
			guestMac: string;
		},
	): FirecrackerRuntime {
		const shortId = reservation.id.replace(/-/g, "").slice(0, 11);
		const template = getDaemonLabTemplate(reservation.templateId);

		return {
			kind: "firecracker",
			id: reservation.id,
			templateId: reservation.templateId,
			username: template.username,
			createdAt: reservation.createdAt,
			expiresAt: reservation.expiresAt,
			sshPort: reservation.sshPort,
			instanceDir,
			apiSocketPath: join(instanceDir, "firecracker.socket"),
			firecrackerPid: 0,
			tapName: `tap${shortId}`,
			subnetCidr: network.subnetCidr,
			hostTapIp: network.hostTapIp,
			guestIp: network.guestIp,
			guestMac: network.guestMac,
			writableRootfsPath: join(instanceDir, "rootfs.raw"),
			stdoutLogPath: join(instanceDir, "firecracker.stdout.log"),
			stderrLogPath: join(instanceDir, "firecracker.stderr.log"),
			metadataPath: join(instanceDir, "runtime.json"),
		};
	}

	private async cloneBaseImage(targetPath: string) {
		await runCommand("cp", [
			"--reflink=auto",
			"--sparse=always",
			this.config.BASE_IMAGE_PATH,
			targetPath,
		]);
	}

	private async customizeRootfs(runtime: FirecrackerRuntime) {
		const hostname = `biohacker-${basename(runtime.instanceDir)}`;
		const mountDir = join(runtime.instanceDir, "rootfs-mount");

		await ensureDir(mountDir);

		try {
			await runCommand("mount", [
				"-o",
				"loop",
				runtime.writableRootfsPath,
				mountDir,
			]);
			await this.writeRootfsConfig(mountDir, runtime, hostname);
		} finally {
			await runCommand("umount", [mountDir], { allowFailure: true });
			await removePath(mountDir);
		}
	}

	private async writeRootfsConfig(
		mountDir: string,
		runtime: FirecrackerRuntime,
		hostname: string,
	) {
		const template = getDaemonLabTemplate(runtime.templateId);
		const guestAccount = await this.ensureGuestAccount(
			mountDir,
			runtime.username,
		);
		const guestHome = join(mountDir, guestAccount.home.replace(/^\/+/, ""));
		const sshConfigDir = join(mountDir, "etc", "ssh", "sshd_config.d");

		await ensureDir(guestHome);
		await runCommand("chown", [
			`${guestAccount.uid}:${guestAccount.gid}`,
			guestHome,
		]);

		if (template.weakPassword) {
			await runCommand("chroot", [mountDir, "/usr/sbin/chpasswd"], {
				stdin: `${runtime.username}:${template.weakPassword}\n`,
			});
		}

		await writeTextFile(join(mountDir, "etc", "hostname"), `${hostname}\n`);
		await writeTextFile(
			join(mountDir, "etc", "hosts"),
			[
				"127.0.0.1 localhost",
				`127.0.1.1 ${hostname}`,
				"::1 localhost ip6-localhost ip6-loopback",
				"ff02::1 ip6-allnodes",
				"ff02::2 ip6-allrouters",
				"",
			].join("\n"),
		);
		await ensureDir(join(mountDir, "etc", "systemd", "network"));
		await writeTextFile(
			join(mountDir, "etc", "systemd", "network", "25-biohacker.network"),
			[
				"[Match]",
				`MACAddress=${runtime.guestMac}`,
				"",
				"[Network]",
				`Address=${runtime.guestIp}/30`,
				`Gateway=${runtime.hostTapIp}`,
				...DEFAULT_NAMESERVERS.map((item) => `DNS=${item}`),
				"LinkLocalAddressing=ipv6",
				"",
			].join("\n"),
		);
		await ensureDir(join(mountDir, "etc", "cloud", "cloud.cfg.d"));
		await writeTextFile(
			join(
				mountDir,
				"etc",
				"cloud",
				"cloud.cfg.d",
				"99-biohacker-disable-network-config.cfg",
			),
			"network: {config: disabled}\n",
		);
		await ensureDir(sshConfigDir);
		await writeTextFile(
			join(sshConfigDir, "25-biohacker-lab.conf"),
			[
				"PasswordAuthentication yes",
				"KbdInteractiveAuthentication no",
				"ChallengeResponseAuthentication no",
				"PubkeyAuthentication no",
				"PermitRootLogin no",
				"UsePAM yes",
				"AuthenticationMethods password",
				"",
			].join("\n"),
		);
	}

	private async ensureGuestAccount(mountDir: string, username: string) {
		const existing = await this.readGuestAccount(mountDir, username);

		if (existing) {
			return existing;
		}

		const userAddArgs = [
			mountDir,
			"/usr/sbin/useradd",
			"-m",
			"-s",
			"/bin/bash",
			"-U",
		];

		if (username === "ubuntu" && (await this.groupExists(mountDir, "sudo"))) {
			userAddArgs.push("-G", "sudo");
		}

		userAddArgs.push(username);

		await runCommand("chroot", userAddArgs);

		const created = await this.readGuestAccount(mountDir, username);

		if (!created) {
			throw new Error(`Failed to create guest user ${username}`);
		}

		return created;
	}

	private async groupExists(mountDir: string, groupName: string) {
		const groupPath = join(mountDir, "etc", "group");
		const groupContents = await readFile(groupPath, "utf8");
		return groupContents
			.split("\n")
			.some((line) => line.startsWith(`${groupName}:`));
	}

	private async readGuestAccount(mountDir: string, username: string) {
		const passwdPath = join(mountDir, "etc", "passwd");
		const passwdContents = await readFile(passwdPath, "utf8");
		const accountLine = passwdContents
			.split("\n")
			.find((line) => line.startsWith(`${username}:`));

		if (!accountLine) {
			return null;
		}

		const parts = accountLine.split(":");

		if (parts.length < 7) {
			throw new Error(`Guest passwd entry for ${username} is malformed`);
		}

		const uid = Number(parts[2]);
		const gid = Number(parts[3]);
		const home = parts[5];

		if (!Number.isInteger(uid) || !Number.isInteger(gid) || home.length === 0) {
			throw new Error(`Guest passwd entry for ${username} is incomplete`);
		}

		return { uid, gid, home };
	}

	private async configureTap(runtime: FirecrackerRuntime) {
		await runCommand("ip", [
			"tuntap",
			"add",
			"dev",
			runtime.tapName,
			"mode",
			"tap",
		]);
		await runCommand("ip", [
			"addr",
			"add",
			`${runtime.hostTapIp}/30`,
			"dev",
			runtime.tapName,
		]);
		await runCommand("ip", ["link", "set", "dev", runtime.tapName, "up"]);
	}

	private async configureIptables(
		runtime: FirecrackerRuntime,
		sshPort: number,
	) {
		await runCommand("iptables", [
			"-t",
			"nat",
			"-A",
			"PREROUTING",
			"-i",
			this.config.HOST_INTERFACE,
			"-p",
			"tcp",
			"--dport",
			String(sshPort),
			"-j",
			"DNAT",
			"--to-destination",
			`${runtime.guestIp}:22`,
		]);
		await runCommand("iptables", [
			"-t",
			"nat",
			"-A",
			"OUTPUT",
			"-d",
			this.config.HOST_PUBLIC_IP,
			"-p",
			"tcp",
			"--dport",
			String(sshPort),
			"-j",
			"DNAT",
			"--to-destination",
			`${runtime.guestIp}:22`,
		]);
		await runCommand("iptables", [
			"-t",
			"nat",
			"-A",
			"POSTROUTING",
			"-s",
			runtime.subnetCidr,
			"-o",
			this.config.HOST_INTERFACE,
			"-j",
			"MASQUERADE",
		]);
		await runCommand("iptables", [
			"-A",
			"FORWARD",
			"-i",
			runtime.tapName,
			"-o",
			this.config.HOST_INTERFACE,
			"-s",
			runtime.subnetCidr,
			"-j",
			"ACCEPT",
		]);
		await runCommand("iptables", [
			"-A",
			"FORWARD",
			"-i",
			this.config.HOST_INTERFACE,
			"-o",
			runtime.tapName,
			"-d",
			runtime.guestIp,
			"-j",
			"ACCEPT",
		]);
	}

	private async launchFirecracker(runtime: FirecrackerRuntime) {
		const stdoutFd = openSync(runtime.stdoutLogPath, "a");
		const stderrFd = openSync(runtime.stderrLogPath, "a");
		const child = spawn(
			this.config.FIRECRACKER_BIN,
			["--api-sock", runtime.apiSocketPath],
			{
				stdio: ["ignore", stdoutFd, stderrFd],
			},
		);
		closeSync(stdoutFd);
		closeSync(stderrFd);

		if (!child.pid) {
			throw new Error("Failed to start the Firecracker process");
		}

		child.unref();

		await this.waitForSocket(runtime.apiSocketPath, child.pid);
		return child.pid;
	}

	private async configureMicroVm(runtime: FirecrackerRuntime) {
		await putMachineConfig(runtime.apiSocketPath, {
			vcpu_count: this.config.VM_VCPU_COUNT,
			mem_size_mib: this.config.VM_MEMORY_MIB,
			smt: false,
		});
		await putBootSource(runtime.apiSocketPath, {
			kernel_image_path: this.config.KERNEL_IMAGE_PATH,
			boot_args: "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw",
		});
		await putDrive(runtime.apiSocketPath, "rootfs", {
			path_on_host: runtime.writableRootfsPath,
			is_root_device: true,
			is_read_only: false,
		});
		await putNetworkInterface(runtime.apiSocketPath, "eth0", {
			host_dev_name: runtime.tapName,
			guest_mac: runtime.guestMac,
		});
		await startInstance(runtime.apiSocketPath);
	}

	private async waitForSocket(socketPath: string, pid: number) {
		const startedAt = Date.now();

		while (Date.now() - startedAt < 15_000) {
			if (!(await this.isProcessAlive(pid))) {
				throw new Error(
					`Firecracker process ${pid} exited before the API socket became ready`,
				);
			}

			try {
				await access(socketPath, constants.R_OK | constants.W_OK);
				return;
			} catch {
				await this.sleep(200);
			}
		}

		throw new Error("Timed out waiting for Firecracker API socket");
	}

	private async waitForSsh(host: string, port: number) {
		const startedAt = Date.now();

		while (Date.now() - startedAt < this.config.SSH_BOOT_TIMEOUT_MS) {
			const reachable = await new Promise<boolean>((resolve) => {
				const socket = new Socket();
				socket.setTimeout(1_000);
				socket.once("connect", () => {
					socket.destroy();
					resolve(true);
				});
				socket.once("timeout", () => {
					socket.destroy();
					resolve(false);
				});
				socket.once("error", () => {
					socket.destroy();
					resolve(false);
				});
				socket.connect(port, host);
			});

			if (reachable) {
				return;
			}

			await this.sleep(1_000);
		}

		throw new Error(
			`Timed out waiting for SSH to become available on ${host}:${port}`,
		);
	}

	private async waitForProcessExit(pid: number, timeoutMs: number) {
		const startedAt = Date.now();

		while (Date.now() - startedAt < timeoutMs) {
			if (!(await this.isProcessAlive(pid))) {
				return;
			}

			await this.sleep(500);
		}

		if (await this.isProcessAlive(pid)) {
			process.kill(pid, "SIGKILL");
		}
	}

	private async isProcessAlive(pid: number) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private async readPersistedRuntime(
		instanceDir: string,
		metadataPath: string,
	): Promise<{
		runtime: FirecrackerRuntime;
		migratedFromLegacy: boolean;
	}> {
		const rawRuntime = await readJsonFile<unknown>(metadataPath);
		const currentRuntime = firecrackerRuntimeSchema.safeParse(rawRuntime);

		if (currentRuntime.success) {
			return {
				runtime: currentRuntime.data,
				migratedFromLegacy: false,
			};
		}

		const legacyRuntime = legacyFirecrackerRuntimeSchema.parse(rawRuntime);

		return {
			runtime: await this.migrateLegacyRuntime(
				instanceDir,
				metadataPath,
				legacyRuntime,
			),
			migratedFromLegacy: true,
		};
	}

	private async migrateLegacyRuntime(
		instanceDir: string,
		metadataPath: string,
		legacyRuntime: LegacyFirecrackerRuntime,
	): Promise<FirecrackerRuntime> {
		const metadataStats = await stat(metadataPath);
		const createdAt = this.inferLegacyCreatedAt(metadataStats);
		const expiresAt = new Date(
			new Date(createdAt).getTime() + this.config.VM_TTL_MINUTES * 60 * 1000,
		).toISOString();
		const templateId = this.getLegacyTemplateId();
		const template = getDaemonLabTemplate(templateId);
		const runtime: FirecrackerRuntime = {
			kind: "firecracker",
			id: basename(instanceDir),
			templateId,
			username: template.username,
			createdAt,
			expiresAt,
			sshPort: legacyRuntime.sshPort,
			instanceDir,
			apiSocketPath: legacyRuntime.apiSocketPath,
			firecrackerPid: legacyRuntime.firecrackerPid,
			tapName: legacyRuntime.tapName,
			subnetCidr: legacyRuntime.subnetCidr,
			hostTapIp: legacyRuntime.hostTapIp,
			guestIp: legacyRuntime.guestIp,
			guestMac: legacyRuntime.guestMac,
			writableRootfsPath: legacyRuntime.writableRootfsPath,
			stdoutLogPath: legacyRuntime.stdoutLogPath,
			stderrLogPath: legacyRuntime.stderrLogPath,
			metadataPath,
		};

		this.logger.info(
			{ id: runtime.id, metadataPath },
			"Migrated legacy Firecracker runtime metadata during daemon startup",
		);

		return runtime;
	}

	private inferLegacyCreatedAt(
		metadataStats: Awaited<ReturnType<typeof stat>>,
	) {
		const candidates = [
			metadataStats.mtimeMs,
			metadataStats.ctimeMs,
			metadataStats.birthtimeMs,
		]
			.map((value) => Number(value))
			.filter((value) => Number.isFinite(value) && value > 0);
		const createdAtMs = candidates[0] ?? Date.now();

		return new Date(createdAtMs).toISOString();
	}

	private getLegacyTemplateId() {
		if (labTemplates.length !== 1) {
			throw new Error(
				"Cannot restore legacy Firecracker metadata when multiple lab templates exist",
			);
		}

		return labTemplates[0].id;
	}

	private async persistRuntime(runtime: FirecrackerRuntime) {
		await writeFile(
			runtime.metadataPath,
			JSON.stringify(runtime, null, 2),
			"utf8",
		);
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

			await this.waitForProcessExit(runtime.firecrackerPid, 5_000);
		}

		await runCommand(
			"iptables",
			[
				"-t",
				"nat",
				"-D",
				"OUTPUT",
				"-d",
				this.config.HOST_PUBLIC_IP,
				"-p",
				"tcp",
				"--dport",
				String(runtime.sshPort),
				"-j",
				"DNAT",
				"--to-destination",
				`${runtime.guestIp}:22`,
			],
			{ allowFailure: true },
		);
		await runCommand(
			"iptables",
			[
				"-t",
				"nat",
				"-D",
				"PREROUTING",
				"-i",
				this.config.HOST_INTERFACE,
				"-p",
				"tcp",
				"--dport",
				String(runtime.sshPort),
				"-j",
				"DNAT",
				"--to-destination",
				`${runtime.guestIp}:22`,
			],
			{ allowFailure: true },
		);
		await runCommand(
			"iptables",
			[
				"-t",
				"nat",
				"-D",
				"POSTROUTING",
				"-s",
				runtime.subnetCidr,
				"-o",
				this.config.HOST_INTERFACE,
				"-j",
				"MASQUERADE",
			],
			{ allowFailure: true },
		);
		await runCommand(
			"iptables",
			[
				"-D",
				"FORWARD",
				"-i",
				runtime.tapName,
				"-o",
				this.config.HOST_INTERFACE,
				"-s",
				runtime.subnetCidr,
				"-j",
				"ACCEPT",
			],
			{ allowFailure: true },
		);
		await runCommand(
			"iptables",
			[
				"-D",
				"FORWARD",
				"-i",
				this.config.HOST_INTERFACE,
				"-o",
				runtime.tapName,
				"-d",
				runtime.guestIp,
				"-j",
				"ACCEPT",
			],
			{ allowFailure: true },
		);
		await runCommand("ip", ["link", "delete", "dev", runtime.tapName], {
			allowFailure: true,
		});
		await removePath(runtime.instanceDir);
	}

	private parseIpv4(value: string) {
		const parts = value.split(".").map((part) => Number(part));

		if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
			throw new Error(`Invalid IPv4 address: ${value}`);
		}

		return (
			((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
		);
	}

	private formatIpv4(value: number) {
		return [
			(value >>> 24) & 255,
			(value >>> 16) & 255,
			(value >>> 8) & 255,
			value & 255,
		].join(".");
	}

	private guestMacFromIp(ip: string) {
		const [a, b, c, d] = ip.split(".").map((part) => Number(part));
		return [0x06, 0x00, a, b, c, d]
			.map((part) => part.toString(16).padStart(2, "0"))
			.join(":");
	}

	private sleep(durationMs: number) {
		return new Promise((resolve) => {
			setTimeout(resolve, durationMs);
		});
	}

	private createManagedVm(runtime: FirecrackerRuntime): ManagedVm {
		return {
			record: {
				id: runtime.id,
				templateId: runtime.templateId,
				state: "running",
				host: this.config.HOST_PUBLIC_IP,
				sshPort: runtime.sshPort,
				username: runtime.username,
				createdAt: runtime.createdAt,
				expiresAt: runtime.expiresAt,
				lastReason: null,
			},
			runtime,
		};
	}
}
