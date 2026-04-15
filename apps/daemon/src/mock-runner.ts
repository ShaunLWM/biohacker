import type { VmTerminationReason } from "@biohacker/shared";
import { getDaemonLabTemplate } from "./lab-templates.js";
import type {
	ManagedVm,
	VmCreationResult,
	VmReservation,
	VmRunner,
} from "./types.js";

export class MockRunner implements VmRunner {
	constructor(private readonly host: string) {}

	async reconcile() {
		return [];
	}

	async create(reservation: VmReservation): Promise<VmCreationResult> {
		const template = getDaemonLabTemplate(reservation.templateId);

		return {
			instance: {
				record: {
					id: reservation.id,
					templateId: reservation.templateId,
					state: "running" as const,
					host: this.host,
					sshPort: reservation.sshPort,
					username: template.username,
					createdAt: reservation.createdAt,
					expiresAt: reservation.expiresAt,
					lastReason: null,
				},
				runtime: {
					kind: "mock" as const,
				},
			},
			launchInstructions: template.launchInstructions({
				username: template.username,
			}),
			secret: template.createSecret(),
		};
	}

	async shutdown(_instance: ManagedVm, _reason: VmTerminationReason) {}
}
