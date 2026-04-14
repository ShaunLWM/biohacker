import { z } from "zod";

export const vmStateSchema = z.enum([
	"creating",
	"running",
	"shutting_down",
	"deleted",
	"failed",
]);

export type VmState = z.infer<typeof vmStateSchema>;

export const vmTerminationReasonSchema = z.enum([
	"user",
	"expired",
	"failed",
]);

export type VmTerminationReason = z.infer<typeof vmTerminationReasonSchema>;

export const vmRecordSchema = z.object({
	id: z.string().min(1),
	state: vmStateSchema,
	host: z.string().min(1),
	sshPort: z.number().int().positive(),
	username: z.string().min(1),
	privateKey: z.string().min(1),
	createdAt: z.string().datetime(),
	expiresAt: z.string().datetime(),
	lastReason: vmTerminationReasonSchema.nullable().default(null),
});

export type VmRecord = z.infer<typeof vmRecordSchema>;

export const createVmResponseSchema = vmRecordSchema;
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
