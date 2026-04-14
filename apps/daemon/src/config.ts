import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";

const envSchema = z.object({
	DAEMON_HOST: z.string().default("0.0.0.0"),
	DAEMON_PORT: z.coerce.number().int().positive().default(4000),
	RUNNER_MODE: z.enum(["mock", "firecracker"]).default("mock"),
	VM_TTL_MINUTES: z.coerce.number().int().positive().default(60),
	MAX_ACTIVE_VMS: z.coerce.number().int().positive().default(10),
	HOST_PUBLIC_IP: z.string().default("127.0.0.1"),
	HOST_INTERFACE: z.string().default("eth0"),
	SSH_PORT_RANGE_START: z.coerce.number().int().positive().default(2200),
	SSH_PORT_RANGE_END: z.coerce.number().int().positive().default(2299),
	INSTANCE_BASE_DIR: z.string().default("/var/lib/biohacker/instances"),
	BASE_IMAGE_PATH: z.string().default("/var/lib/biohacker/base-images/ubuntu-24.04.raw"),
	KERNEL_IMAGE_PATH: z.string().default("/opt/biohacker/firecracker/vmlinux.bin"),
	FIRECRACKER_BIN: z.string().default("/opt/biohacker/firecracker/firecracker"),
	JAILER_BIN: z.string().default("/opt/biohacker/firecracker/jailer"),
}).refine(
	(value) => value.SSH_PORT_RANGE_END >= value.SSH_PORT_RANGE_START,
	{
		message: "SSH_PORT_RANGE_END must be greater than or equal to SSH_PORT_RANGE_START",
		path: ["SSH_PORT_RANGE_END"],
	},
);

export type DaemonConfig = z.infer<typeof envSchema>;

export function loadConfig() {
	return envSchema.parse(process.env);
}

export async function exists(path: string) {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
