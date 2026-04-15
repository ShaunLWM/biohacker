import { z } from "zod";

export const labTemplateIdSchema = z.enum(["weak-ssh"]);

export type LabTemplateId = z.infer<typeof labTemplateIdSchema>;

export const labAuthModeSchema = z.enum(["password", "key"]);

export type LabAuthMode = z.infer<typeof labAuthModeSchema>;

export const labTemplateSchema = z.object({
	id: labTemplateIdSchema,
	name: z.string().min(1),
	summary: z.string().min(1),
	objective: z.string().min(1),
	username: z.string().min(1),
	authMode: labAuthModeSchema,
});

export type LabTemplate = z.infer<typeof labTemplateSchema>;

export const labTemplates = labTemplateSchema.array().parse([
	{
		id: "weak-ssh",
		name: "Weak SSH Password",
		summary:
			"Ubuntu target with password-based SSH enabled and an intentionally weak credential to crack.",
		objective:
			"Find and crack the weak SSH password for the student account, then log in over SSH.",
		username: "student",
		authMode: "password",
	},
]);

export const vmStateSchema = z.enum([
	"creating",
	"running",
	"shutting_down",
	"deleted",
	"failed",
]);

export type VmState = z.infer<typeof vmStateSchema>;

export const vmTerminationReasonSchema = z.enum(["user", "expired", "failed"]);

export type VmTerminationReason = z.infer<typeof vmTerminationReasonSchema>;

export const vmRecordSchema = z.object({
	id: z.string().min(1),
	templateId: labTemplateIdSchema,
	state: vmStateSchema,
	host: z.string().min(1),
	sshPort: z.number().int().positive(),
	username: z.string().min(1),
	createdAt: z.string().datetime(),
	expiresAt: z.string().datetime(),
	lastReason: vmTerminationReasonSchema.nullable().default(null),
});

export type VmRecord = z.infer<typeof vmRecordSchema>;

export const createVmRequestSchema = z.object({
	templateId: labTemplateIdSchema,
});

export type CreateVmRequest = z.infer<typeof createVmRequestSchema>;

export const vmSecretSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }),
	z.object({
		kind: z.literal("password"),
		password: z.string().min(1),
	}),
	z.object({
		kind: z.literal("private-key"),
		privateKey: z.string().min(1),
	}),
]);

export type VmSecret = z.infer<typeof vmSecretSchema>;

export const createVmResponseSchema = vmRecordSchema.extend({
	launchInstructions: z.array(z.string()),
	secret: vmSecretSchema,
});
export type CreateVmResponse = z.infer<typeof createVmResponseSchema>;

export const listVmsResponseSchema = z.object({
	items: z.array(vmRecordSchema),
});

export type ListVmsResponse = z.infer<typeof listVmsResponseSchema>;

export const healthResponseSchema = z.object({
	status: z.enum(["ok", "degraded"]),
	runnerMode: z.enum(["mock", "firecracker"]),
	ttlMinutes: z.number().int().positive(),
	maxActiveVms: z.number().int().positive(),
	checks: z.object({
		firecrackerBinary: z.boolean(),
		jailerBinary: z.boolean(),
		kernelImage: z.boolean(),
		baseImage: z.boolean(),
	}),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
