import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";
import type { DaemonConfig } from "./config.js";
import type { ManagedVm, VmCreationResult, VmRunner } from "./types.js";

function createConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
	return {
		DAEMON_HOST: "127.0.0.1",
		DAEMON_PORT: 4000,
		RUNNER_MODE: "mock",
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
		INSTANCE_BASE_DIR: "/tmp/biohacker-tests/instances",
		BASE_IMAGE_PATH: "/tmp/biohacker-tests/base.raw",
		KERNEL_IMAGE_PATH: "/tmp/biohacker-tests/vmlinux.bin",
		FIRECRACKER_BIN: "/tmp/biohacker-tests/firecracker",
		JAILER_BIN: "/tmp/biohacker-tests/jailer",
		...overrides,
	};
}

function createManagedVm(id: string): ManagedVm {
	return {
		record: {
			id,
			templateId: "weak-ssh",
			state: "running",
			host: "203.0.113.10",
			sshPort: 2200,
			username: "student",
			createdAt: "2026-04-15T00:00:00.000Z",
			expiresAt: "2026-04-15T01:00:00.000Z",
			lastReason: null,
		},
		runtime: {
			kind: "mock",
		},
	};
}

test("create returns one-time lab details, but list and shutdown never expose secrets", async () => {
	const createdVm = createManagedVm("a0000000-0000-4000-8000-000000000001");
	const shutdownCalls: string[] = [];
	const runner: VmRunner = {
		async reconcile() {
			return [];
		},
		async create(): Promise<VmCreationResult> {
			return {
				instance: createdVm,
				launchInstructions: [
					"Objective: crack the weak SSH password for the student account.",
				],
				secret: {
					kind: "none",
				},
			};
		},
		async shutdown(instance) {
			shutdownCalls.push(instance.record.id);
		},
	};
	const { app } = await buildApp(createConfig(), runner);

	try {
		const createResponse = await app.inject({
			method: "POST",
			url: "/v1/vms",
			payload: {
				templateId: "weak-ssh",
			},
		});
		assert.equal(createResponse.statusCode, 200);
		assert.equal(createResponse.json().templateId, "weak-ssh");
		assert.deepEqual(createResponse.json().launchInstructions, [
			"Objective: crack the weak SSH password for the student account.",
		]);
		assert.deepEqual(createResponse.json().secret, { kind: "none" });

		const listResponse = await app.inject({
			method: "GET",
			url: "/v1/vms",
		});
		assert.equal(listResponse.statusCode, 200);
		assert.deepEqual(listResponse.json(), {
			items: [createdVm.record],
		});

		const shutdownResponse = await app.inject({
			method: "POST",
			url: `/v1/vms/${createdVm.record.id}/shutdown`,
		});
		assert.equal(shutdownResponse.statusCode, 200);
		assert.equal(shutdownResponse.json().secret, undefined);
		assert.deepEqual(shutdownCalls, [createdVm.record.id]);
	} finally {
		await app.close();
	}
});

test("create rejects an empty payload because the lab template is required", async () => {
	const runner: VmRunner = {
		async reconcile() {
			return [];
		},
		async create() {
			throw new Error("not used");
		},
		async shutdown() {},
	};
	const { app } = await buildApp(createConfig(), runner);

	try {
		const response = await app.inject({
			method: "POST",
			url: "/v1/vms",
			payload: {},
		});
		assert.equal(response.statusCode, 400);
	} finally {
		await app.close();
	}
});

test("reconcile restores active VMs into the registry", async () => {
	const restoredVm = createManagedVm("vm-restored");
	const runner: VmRunner = {
		async reconcile() {
			return [restoredVm];
		},
		async create() {
			throw new Error("not used");
		},
		async shutdown() {},
	};
	const { app } = await buildApp(createConfig(), runner);

	try {
		const listResponse = await app.inject({
			method: "GET",
			url: "/v1/vms",
		});
		assert.equal(listResponse.statusCode, 200);
		assert.deepEqual(listResponse.json(), {
			items: [restoredVm.record],
		});
	} finally {
		await app.close();
	}
});
