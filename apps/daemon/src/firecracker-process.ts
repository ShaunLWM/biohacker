import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { access } from "node:fs/promises";
import { Socket } from "node:net";
import {
	putBootSource,
	putDrive,
	putMachineConfig,
	putNetworkInterface,
	startInstance,
} from "./firecracker-api.js";

function sleep(durationMs: number) {
	return new Promise((resolve) => {
		setTimeout(resolve, durationMs);
	});
}

async function waitForSocket(socketPath: string, pid: number): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < 15_000) {
		if (!(await isProcessAlive(pid))) {
			throw new Error(
				`Firecracker process ${pid} exited before the API socket became ready`,
			);
		}

		try {
			await access(socketPath, constants.R_OK | constants.W_OK);
			return;
		} catch {
			await sleep(200);
		}
	}

	throw new Error("Timed out waiting for Firecracker API socket");
}

export async function launchFirecracker(
	firecrackerBin: string,
	apiSocketPath: string,
	stdoutLogPath: string,
	stderrLogPath: string,
): Promise<number> {
	const stdoutFd = openSync(stdoutLogPath, "a");
	const stderrFd = openSync(stderrLogPath, "a");
	const child = spawn(firecrackerBin, ["--api-sock", apiSocketPath], {
		stdio: ["ignore", stdoutFd, stderrFd],
	});
	closeSync(stdoutFd);
	closeSync(stderrFd);

	if (!child.pid) {
		throw new Error("Failed to start the Firecracker process");
	}

	child.unref();

	await waitForSocket(apiSocketPath, child.pid);
	return child.pid;
}

export async function configureMicroVm(
	apiSocketPath: string,
	writableRootfsPath: string,
	tapName: string,
	guestMac: string,
	vmConfig: { vcpuCount: number; memoryMib: number; kernelImagePath: string },
): Promise<void> {
	await putMachineConfig(apiSocketPath, {
		vcpu_count: vmConfig.vcpuCount,
		mem_size_mib: vmConfig.memoryMib,
		smt: false,
	});
	await putBootSource(apiSocketPath, {
		kernel_image_path: vmConfig.kernelImagePath,
		boot_args: "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw",
	});
	await putDrive(apiSocketPath, "rootfs", {
		path_on_host: writableRootfsPath,
		is_root_device: true,
		is_read_only: false,
	});
	await putNetworkInterface(apiSocketPath, "eth0", {
		host_dev_name: tapName,
		guest_mac: guestMac,
	});
	await startInstance(apiSocketPath);
}

export async function waitForSsh(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
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

		await sleep(1_000);
	}

	throw new Error(
		`Timed out waiting for SSH to become available on ${host}:${port}`,
	);
}

export async function waitForProcessExit(
	pid: number,
	timeoutMs: number,
): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		if (!(await isProcessAlive(pid))) {
			return;
		}

		await sleep(500);
	}

	if (await isProcessAlive(pid)) {
		process.kill(pid, "SIGKILL");
	}
}

export async function isProcessAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
