import {
	type LabTemplate,
	type LabTemplateId,
	labTemplates,
	type VmSecret,
} from "@biohacker/shared";

interface DaemonLabTemplate extends LabTemplate {
	weakPassword?: string;
	launchInstructions(input: { username: string }): string[];
	createSecret(): VmSecret;
}

const publicTemplatesById = new Map(
	labTemplates.map((item) => [item.id, item]),
);

const daemonTemplates: Record<LabTemplateId, DaemonLabTemplate> = {
	"weak-ssh": {
		...requirePublicTemplate("weak-ssh"),
		weakPassword: "password",
		launchInstructions(runtime) {
			return [
				"Objective: crack the weak SSH password for the student account.",
				"Authentication mode: password only. SSH key auth is disabled for this lab.",
				`Target account: ${runtime.username}`,
				"The weak password is intentionally not revealed by the control plane.",
			];
		},
		createSecret() {
			return { kind: "none" };
		},
	},
};

export function getDaemonLabTemplate(templateId: LabTemplateId) {
	return daemonTemplates[templateId];
}

function requirePublicTemplate(templateId: LabTemplateId) {
	const template = publicTemplatesById.get(templateId);

	if (!template) {
		throw new Error(`Unknown lab template: ${templateId}`);
	}

	return template;
}
