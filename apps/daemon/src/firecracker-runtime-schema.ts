import { stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { labTemplates, type VmRecord } from "@biohacker/shared";
import { z } from "zod";
import type { DaemonConfig } from "./config.js";
import type { NetworkAllocation } from "./firecracker-network.js";
import { readJsonFile } from "./fs-utils.js";
import { getDaemonLabTemplate } from "./lab-templates.js";
import type { FirecrackerRuntime, ManagedVm, VmReservation } from "./types.js";

interface LegacyFirecrackerRuntime {
	sshPort: number;
	firecrackerPid: number;
	tapName: string;
	subnetCidr: string;
	hostTapIp: string;
	guestIp: string;
	guestMac: string;
	apiSocketPath: string;
	instanceDir: string;
	writableRootfsPath: string;
	stdoutLogPath: string;
	stderrLogPath: string;
	metadataPath?: string;
	[key: string]: unknown;
}

const firecrackerTemplateIdSchema = z.custom<FirecrackerRuntime["templateId"]>(
	(value): value is FirecrackerRuntime["templateId"] =>
		typeof value === "string" && labTemplates.some((item) => item.id === value),
);

export const firecrackerRuntimeSchema: z.ZodType<FirecrackerRuntime> = z.object(
	{
		kind: z.literal("firecracker"),
		id: z.string().min(1),
		templateId: firecrackerTemplateIdSchema,
		username: z.string().min(1),
		createdAt: z.string().datetime(),
		expiresAt: z.string().datetime(),
		sshPort: z.number().int().positive(),
		instanceDir: z.string().min(1),
		apiSocketPath: z.string().min(1),
		firecrackerPid: z.number().int(),
		tapName: z.string().min(1),
		subnetCidr: z.string().min(1),
		hostTapIp: z.string().min(1),
		guestIp: z.string().min(1),
		guestMac: z.string().min(1),
		writableRootfsPath: z.string().min(1),
		stdoutLogPath: z.string().min(1),
		stderrLogPath: z.string().min(1),
		metadataPath: z.string().min(1),
	},
);

const legacyFirecrackerRuntimeSchema: z.ZodType<LegacyFirecrackerRuntime> = z
	.object({
		sshPort: z.number().int().positive(),
		firecrackerPid: z.number().int(),
		tapName: z.string().min(1),
		subnetCidr: z.string().min(1),
		hostTapIp: z.string().min(1),
		guestIp: z.string().min(1),
		guestMac: z.string().min(1),
		apiSocketPath: z.string().min(1),
		instanceDir: z.string().min(1),
		writableRootfsPath: z.string().min(1),
		stdoutLogPath: z.string().min(1),
		stderrLogPath: z.string().min(1),
		metadataPath: z.string().min(1).optional(),
	})
	.passthrough();

export function createRuntimePaths(
	instanceDir: string,
	reservation: VmReservation,
	network: NetworkAllocation,
): FirecrackerRuntime {
	const shortId = reservation.id.replace(/-/g, "").slice(0, 11);
	const template = getDaemonLabTemplate(reservation.templateId);

	return {
		kind: "firecracker",
		id: reservation.id,
		templateId: reservation.templateId,
		username: template.username,
		createdAt: reservation.createdAt,
		expiresAt: reservation.expiresAt,
		sshPort: reservation.sshPort,
		instanceDir,
		apiSocketPath: join(instanceDir, "firecracker.socket"),
		firecrackerPid: 0,
		tapName: `tap${shortId}`,
		subnetCidr: network.subnetCidr,
		hostTapIp: network.hostTapIp,
		guestIp: network.guestIp,
		guestMac: network.guestMac,
		writableRootfsPath: join(instanceDir, "rootfs.raw"),
		stdoutLogPath: join(instanceDir, "firecracker.stdout.log"),
		stderrLogPath: join(instanceDir, "firecracker.stderr.log"),
		metadataPath: join(instanceDir, "runtime.json"),
	};
}

export function createManagedVm(
	runtime: FirecrackerRuntime,
	hostPublicIp: string,
): ManagedVm {
	const record: VmRecord = {
		id: runtime.id,
		templateId: runtime.templateId,
		state: "running",
		host: hostPublicIp,
		sshPort: runtime.sshPort,
		username: runtime.username,
		createdAt: runtime.createdAt,
		expiresAt: runtime.expiresAt,
		lastReason: null,
	};

	return { record, runtime };
}

export async function persistRuntime(
	runtime: FirecrackerRuntime,
): Promise<void> {
	await writeFile(runtime.metadataPath, JSON.stringify(runtime, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function readPersistedRuntime(
	instanceDir: string,
	metadataPath: string,
	config: Pick<DaemonConfig, "VM_TTL_MINUTES">,
): Promise<{ runtime: FirecrackerRuntime; migratedFromLegacy: boolean }> {
	const rawRuntime = await readJsonFile<unknown>(metadataPath);
	const currentRuntime = firecrackerRuntimeSchema.safeParse(rawRuntime);

	if (currentRuntime.success) {
		return {
			runtime: currentRuntime.data,
			migratedFromLegacy: false,
		};
	}

	const legacyRuntime = legacyFirecrackerRuntimeSchema.parse(rawRuntime);

	return {
		runtime: await migrateLegacyRuntime(
			instanceDir,
			metadataPath,
			legacyRuntime,
			config,
		),
		migratedFromLegacy: true,
	};
}

async function migrateLegacyRuntime(
	instanceDir: string,
	metadataPath: string,
	legacyRuntime: LegacyFirecrackerRuntime,
	config: Pick<DaemonConfig, "VM_TTL_MINUTES">,
): Promise<FirecrackerRuntime> {
	const metadataStats = await stat(metadataPath);
	const createdAt = inferLegacyCreatedAt(metadataStats);
	const expiresAt = new Date(
		new Date(createdAt).getTime() + config.VM_TTL_MINUTES * 60 * 1000,
	).toISOString();
	const templateId = getLegacyTemplateId();
	const template = getDaemonLabTemplate(templateId);

	return {
		kind: "firecracker",
		id: basename(instanceDir),
		templateId,
		username: template.username,
		createdAt,
		expiresAt,
		sshPort: legacyRuntime.sshPort,
		instanceDir,
		apiSocketPath: legacyRuntime.apiSocketPath,
		firecrackerPid: legacyRuntime.firecrackerPid,
		tapName: legacyRuntime.tapName,
		subnetCidr: legacyRuntime.subnetCidr,
		hostTapIp: legacyRuntime.hostTapIp,
		guestIp: legacyRuntime.guestIp,
		guestMac: legacyRuntime.guestMac,
		writableRootfsPath: legacyRuntime.writableRootfsPath,
		stdoutLogPath: legacyRuntime.stdoutLogPath,
		stderrLogPath: legacyRuntime.stderrLogPath,
		metadataPath,
	};
}

function inferLegacyCreatedAt(metadataStats: Awaited<ReturnType<typeof stat>>) {
	const candidates = [
		metadataStats.mtimeMs,
		metadataStats.ctimeMs,
		metadataStats.birthtimeMs,
	]
		.map((value) => Number(value))
		.filter((value) => Number.isFinite(value) && value > 0);
	const createdAtMs = candidates[0] ?? Date.now();

	return new Date(createdAtMs).toISOString();
}

function getLegacyTemplateId() {
	if (labTemplates.length !== 1) {
		throw new Error(
			"Cannot restore legacy Firecracker metadata when multiple lab templates exist",
		);
	}

	return labTemplates[0].id;
}
