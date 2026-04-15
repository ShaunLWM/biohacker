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

async function readSshBanner(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<string | null> {
	return await new Promise((resolve) => {
		const socket = new Socket();
		let settled = false;
		let buffer = "";

		const finish = (value: string | null) => {
			if (settled) {
				return;
			}

			settled = true;
			socket.destroy();
			resolve(value);
		};

		socket.setTimeout(timeoutMs);
		socket.once("connect", () => {
			// Wait for the SSH server banner instead of treating a bare TCP accept
			// as success. This avoids returning ready while socket activation or
			// sshd startup is still failing inside the guest.
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newlineIndex = buffer.indexOf("\n");

			if (newlineIndex === -1) {
				return;
			}

			finish(buffer.slice(0, newlineIndex).trim());
		});
		socket.once("timeout", () => finish(null));
		socket.once("error", () => finish(null));
		socket.once("close", () => finish(null));
		socket.connect(port, host);
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
		const banner = await readSshBanner(host, port, 1_500);

		if (banner?.startsWith("SSH-")) {
			return;
		}

		await sleep(1_000);
	}

	throw new Error(`Timed out waiting for SSH banner on ${host}:${port}`);
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
