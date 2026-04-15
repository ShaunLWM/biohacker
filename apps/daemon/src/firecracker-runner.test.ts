import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DaemonConfig } from "./config.js";
import { FirecrackerRunner } from "./firecracker-runner.js";
import type { FirecrackerRuntime } from "./types.js";

function createConfig(instanceBaseDir: string): DaemonConfig {
	return {
		DAEMON_HOST: "127.0.0.1",
		DAEMON_PORT: 4000,
		RUNNER_MODE: "firecracker",
		VM_TTL_MINUTES: 60,
		MAX_ACTIVE_VMS: 10,
		VM_VCPU_COUNT: 2,
		VM_MEMORY_MIB: 2048,
		SSH_BOOT_TIMEOUT_MS: 120_000,
		PRESERVE_FAILED_VM_STATE: false,
		HOST_PUBLIC_IP: "203.0.113.10",
		HOST_INTERFACE: "eth0",
		GUEST_NETWORK_BASE: "172.29.0.0",
		SSH_PORT_RANGE_START: 2200,
		SSH_PORT_RANGE_END: 2299,
		INSTANCE_BASE_DIR: instanceBaseDir,
		BASE_IMAGE_PATH: "/tmp/biohacker-tests/base.raw",
		KERNEL_IMAGE_PATH: "/tmp/biohacker-tests/vmlinux.bin",
		FIRECRACKER_BIN: "/tmp/biohacker-tests/firecracker",
		JAILER_BIN: "/tmp/biohacker-tests/jailer",
	};
}

test("reconcile migrates legacy runtime metadata before restoring a live VM", async () => {
	const tempDir = await mkdtemp(
		join(tmpdir(), "biohacker-firecracker-runner-"),
	);

	try {
		const instanceId = "vm-legacy";
		const instanceDir = join(tempDir, instanceId);
		const metadataPath = join(instanceDir, "runtime.json");
		const createdAt = new Date("2099-04-15T00:00:00.000Z");
		const expiresAt = "2099-04-15T01:00:00.000Z";

		await mkdir(instanceDir, { recursive: true });
		await writeFile(
			metadataPath,
			JSON.stringify(
				{
					sshPort: 2207,
					firecrackerPid: 4242,
					tapName: "tapvmlegacy",
					subnetCidr: "172.29.7.0/30",
					hostTapIp: "172.29.7.1",
					guestIp: "172.29.7.2",
					guestMac: "06:00:ac:1d:07:02",
					apiSocketPath: join(instanceDir, "firecracker.socket"),
					instanceDir,
					writableRootfsPath: join(instanceDir, "rootfs.raw"),
					seedImagePath: join(instanceDir, "seed.img"),
					sshPrivateKeyPath: join(instanceDir, "id_ed25519"),
					sshPublicKeyPath: join(instanceDir, "id_ed25519.pub"),
					userDataPath: join(instanceDir, "user-data"),
					metaDataPath: join(instanceDir, "meta-data"),
					networkConfigPath: join(instanceDir, "network-config"),
					stdoutLogPath: join(instanceDir, "firecracker.stdout.log"),
					stderrLogPath: join(instanceDir, "firecracker.stderr.log"),
					metadataPath,
				},
				null,
				2,
			),
			"utf8",
		);
		await utimes(metadataPath, createdAt, createdAt);

		const runner = new FirecrackerRunner(createConfig(tempDir), {
			info() {},
			warn() {},
			error() {},
		} as never);
		(
			runner as unknown as {
				isProcessAlive(pid: number): Promise<boolean>;
			}
		).isProcessAlive = async () => true;

		const restored = await runner.reconcile();
		const persistedRuntime = JSON.parse(
			await readFile(metadataPath, "utf8"),
		) as FirecrackerRuntime;

		assert.equal(restored.length, 1);
		assert.deepEqual(restored[0]?.record, {
			id: instanceId,
			templateId: "weak-ssh",
			state: "running",
			host: "203.0.113.10",
			sshPort: 2207,
			username: "student",
			createdAt: createdAt.toISOString(),
			expiresAt,
			lastReason: null,
		});
		assert.equal(persistedRuntime.id, instanceId);
		assert.equal(persistedRuntime.templateId, "weak-ssh");
		assert.equal(persistedRuntime.username, "student");
		assert.equal(persistedRuntime.createdAt, createdAt.toISOString());
		assert.equal(persistedRuntime.expiresAt, expiresAt);
		assert.equal(
			"seedImagePath" in
				(persistedRuntime as FirecrackerRuntime & { seedImagePath?: string }),
			false,
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
