import { closeSync, openSync } from "node:fs";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { Socket } from "node:net";

import type { FastifyBaseLogger } from "fastify";
import type { VmTerminationReason } from "@biohacker/shared";

import type { DaemonConfig } from "./config.js";
import { runCommand } from "./command.js";
import { ensureDir, readJsonFile, removePath, writeTextFile } from "./fs-utils.js";
import {
	putBootSource,
	putDrive,
	putMachineConfig,
	putNetworkInterface,
	sendCtrlAltDel,
	startInstance,
} from "./firecracker-api.js";
import type {
	FirecrackerRuntime,
	ManagedVm,
	VmReservation,
	VmRunner,
} from "./types.js";

interface PersistedRuntime {
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
	seedImagePath: string;
	sshPrivateKeyPath: string;
	sshPublicKeyPath: string;
	userDataPath: string;
	metaDataPath: string;
	networkConfigPath: string;
	stdoutLogPath: string;
	stderrLogPath: string;
	metadataPath: string;
}

const DEFAULT_NAMESERVERS = ["1.1.1.1", "8.8.8.8"];

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

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			const instanceDir = join(this.config.INSTANCE_BASE_DIR, entry.name);
			const metadataPath = join(instanceDir, "runtime.json");

			try {
				await access(metadataPath, constants.R_OK);
				const runtime = await readJsonFile<PersistedRuntime>(metadataPath);
				this.logger.warn(
					{ instanceDir, pid: runtime.firecrackerPid },
					"Cleaning up orphaned Firecracker instance from a previous daemon run",
				);
				await this.cleanupRuntime({
					kind: "firecracker",
					...runtime,
				});
			} catch {
				await removePath(instanceDir);
			}
		}
	}

	async create(reservation: VmReservation): Promise<ManagedVm> {
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
			step = "clone-base-image";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.cloneBaseImage(runtime.writableRootfsPath);
			step = "generate-ssh-keypair";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.generateSshKeypair(
				runtime.sshPrivateKeyPath,
				runtime.sshPublicKeyPath,
			);
			const publicKey = (await readFile(runtime.sshPublicKeyPath, "utf8")).trim();

			step = "write-cloud-init";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.writeCloudInitFiles(runtime, publicKey);
			step = "create-seed-image";
			this.logger.info({ id: reservation.id, step }, "VM create step");
			await this.createSeedImage(runtime);
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
			await this.waitForSsh(runtime.guestIp, 22);
			this.logger.info(
				{
					id: reservation.id,
					sshPort: reservation.sshPort,
					guestIp: runtime.guestIp,
				},
				"Firecracker VM is ready for SSH",
			);

			return {
				record: {
					id: reservation.id,
					state: "running",
					host: this.config.HOST_PUBLIC_IP,
					sshPort: reservation.sshPort,
					username: "ubuntu",
					privateKey: await readFile(runtime.sshPrivateKeyPath, "utf8"),
					createdAt: reservation.createdAt,
					expiresAt: reservation.expiresAt,
					lastReason: null,
				},
				runtime,
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

		return {
			kind: "firecracker",
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
			seedImagePath: join(instanceDir, "seed.img"),
			sshPrivateKeyPath: join(instanceDir, "id_ed25519"),
			sshPublicKeyPath: join(instanceDir, "id_ed25519.pub"),
			userDataPath: join(instanceDir, "user-data"),
			metaDataPath: join(instanceDir, "meta-data"),
			networkConfigPath: join(instanceDir, "network-config"),
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

	private async generateSshKeypair(
		privateKeyPath: string,
		publicKeyPath: string,
	) {
		await runCommand("ssh-keygen", [
			"-q",
			"-t",
			"ed25519",
			"-N",
			"",
			"-f",
			privateKeyPath,
		]);
		await runCommand("chmod", ["0600", privateKeyPath]);
		await runCommand("chmod", ["0644", publicKeyPath]);
	}

	private async writeCloudInitFiles(
		runtime: FirecrackerRuntime,
		publicKey: string,
	) {
		const hostname = `biohacker-${basename(runtime.instanceDir)}`;
		await writeTextFile(
			runtime.userDataPath,
			[
				"#cloud-config",
				`hostname: ${hostname}`,
				"manage_etc_hosts: true",
				"users:",
				"  - default",
				"  - name: ubuntu",
				"    sudo: ALL=(ALL) NOPASSWD:ALL",
				"    shell: /bin/bash",
				"    ssh_authorized_keys:",
				`      - ${publicKey}`,
				"ssh_pwauth: false",
				"disable_root: true",
				"preserve_hostname: false",
				"growpart:",
				"  mode: auto",
				"  devices: ['/']",
				"resize_rootfs: true",
				"",
			].join("\n"),
		);
		await writeTextFile(
			runtime.metaDataPath,
			[
				`instance-id: ${basename(runtime.instanceDir)}`,
				`local-hostname: ${hostname}`,
				"",
			].join("\n"),
		);
		await writeTextFile(
			runtime.networkConfigPath,
			[
				"version: 2",
				"ethernets:",
				"  eth0:",
				"    match:",
				`      macaddress: "${runtime.guestMac}"`,
				"    set-name: eth0",
				`    addresses: ["${runtime.guestIp}/30"]`,
				"    routes:",
				`      - to: default`,
				`        via: ${runtime.hostTapIp}`,
				"    nameservers:",
				`      addresses: [${DEFAULT_NAMESERVERS.map((item) => `"${item}"`).join(", ")}]`,
				"",
			].join("\n"),
		);
	}

	private async createSeedImage(runtime: FirecrackerRuntime) {
		await runCommand("cloud-localds", [
			"--network-config",
			runtime.networkConfigPath,
			runtime.seedImagePath,
			runtime.userDataPath,
			runtime.metaDataPath,
		]);
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
			boot_args:
				"console=ttyS0 reboot=k panic=1 pci=off nomodules root=/dev/vda rw",
		});
		await putDrive(runtime.apiSocketPath, "rootfs", {
			path_on_host: runtime.writableRootfsPath,
			is_root_device: true,
			is_read_only: false,
		});
		await putDrive(runtime.apiSocketPath, "seed", {
			path_on_host: runtime.seedImagePath,
			is_root_device: false,
			is_read_only: true,
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

	private async persistRuntime(runtime: FirecrackerRuntime) {
		await writeFile(
			runtime.metadataPath,
			JSON.stringify(
				{
					sshPort: runtime.sshPort,
					firecrackerPid: runtime.firecrackerPid,
					tapName: runtime.tapName,
					subnetCidr: runtime.subnetCidr,
					hostTapIp: runtime.hostTapIp,
					guestIp: runtime.guestIp,
					guestMac: runtime.guestMac,
					apiSocketPath: runtime.apiSocketPath,
					instanceDir: runtime.instanceDir,
					writableRootfsPath: runtime.writableRootfsPath,
					seedImagePath: runtime.seedImagePath,
					sshPrivateKeyPath: runtime.sshPrivateKeyPath,
					sshPublicKeyPath: runtime.sshPublicKeyPath,
					userDataPath: runtime.userDataPath,
					metaDataPath: runtime.metaDataPath,
					networkConfigPath: runtime.networkConfigPath,
					stdoutLogPath: runtime.stdoutLogPath,
					stderrLogPath: runtime.stderrLogPath,
					metadataPath: runtime.metadataPath,
				},
				null,
				2,
			),
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

		if (runtime.firecrackerPid > 0 && (await this.isProcessAlive(runtime.firecrackerPid))) {
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
		await runCommand(
			"ip",
			["link", "delete", "dev", runtime.tapName],
			{ allowFailure: true },
		);
		await removePath(runtime.instanceDir);
	}

	private parseIpv4(value: string) {
		const parts = value.split(".").map((part) => Number(part));

		if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
			throw new Error(`Invalid IPv4 address: ${value}`);
		}

		return (
			(parts[0] << 24) |
			(parts[1] << 16) |
			(parts[2] << 8) |
			parts[3]
		) >>> 0;
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
}
