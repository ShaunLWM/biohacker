import type { VmRunner } from "./types.js";
import type { VmReservation } from "./types.js";

import type { ManagedVm } from "./types.js";
import type { VmTerminationReason } from "@biohacker/shared";

const SSH_PRIVATE_KEY_PLACEHOLDER = `-----BEGIN OPENSSH PRIVATE KEY-----
mock-runner-placeholder
-----END OPENSSH PRIVATE KEY-----`;

export class MockRunner implements VmRunner {
	constructor(private readonly host: string) {}

	async reconcile() {}

	async create(reservation: VmReservation): Promise<ManagedVm> {
		return {
			record: {
				id: reservation.id,
				state: "running",
				host: this.host,
				sshPort: reservation.sshPort,
				username: "ubuntu",
				privateKey: SSH_PRIVATE_KEY_PLACEHOLDER,
				createdAt: reservation.createdAt,
				expiresAt: reservation.expiresAt,
				lastReason: null,
			},
			runtime: {
				kind: "mock",
			},
		};
	}

	async shutdown(_instance: ManagedVm, _reason: VmTerminationReason) {}
}
