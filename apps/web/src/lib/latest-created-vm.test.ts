import assert from "node:assert/strict";
import test from "node:test";
import type { CreateVmResponse, VmRecord } from "@biohacker/shared";
import { reconcileLatestCreatedVm } from "./latest-created-vm.ts";

function createVmRecord(id: string): VmRecord {
	return {
		id,
		templateId: "weak-ssh",
		state: "running",
		host: "203.0.113.10",
		sshPort: 2200,
		username: "student",
		createdAt: "2026-04-15T00:00:00.000Z",
		expiresAt: "2026-04-15T01:00:00.000Z",
		lastReason: null,
	};
}

function createVmResponse(id: string): CreateVmResponse {
	return {
		...createVmRecord(id),
		launchInstructions: ["Use the SSH target to start the lab."],
		secret: { kind: "none" },
	};
}

test("keeps the one-time lab card until a newer VM list arrives", () => {
	const latestCreatedVm = createVmResponse("vm-created");

	assert.equal(
		reconcileLatestCreatedVm(latestCreatedVm, [], 1_000, 1_000),
		latestCreatedVm,
	);
});

test("preserves the one-time lab card when the newer VM list still contains the VM", () => {
	const latestCreatedVm = createVmResponse("vm-created");

	assert.equal(
		reconcileLatestCreatedVm(
			latestCreatedVm,
			[createVmRecord("vm-created")],
			2_000,
			1_000,
		),
		latestCreatedVm,
	);
});

test("clears the one-time lab card when a newer VM list no longer contains the VM", () => {
	const latestCreatedVm = createVmResponse("vm-created");

	assert.equal(
		reconcileLatestCreatedVm(
			latestCreatedVm,
			[createVmRecord("vm-other")],
			2_000,
			1_000,
		),
		null,
	);
});
