import {
	createVmRequestSchema,
	createVmResponseSchema,
	type HealthResponse,
	healthResponseSchema,
	type ListVmsResponse,
	listVmsResponseSchema,
} from "@biohacker/shared";
import Fastify from "fastify";
import { z } from "zod";
import type { DaemonConfig } from "./config.js";
import { FirecrackerRunner } from "./firecracker-runner.js";
import { exists } from "./fs-utils.js";
import { MockRunner } from "./mock-runner.js";
import type { ManagedVm, VmRunner } from "./types.js";
import { VmRegistry } from "./vm-registry.js";

export async function buildApp(
	config: DaemonConfig,
	runner: VmRunner | null = null,
) {
	const app = Fastify({ logger: true });
	const registry = new VmRegistry(config);
	const shuttingDown = new Set<string>();
	const activeRunner =
		runner ??
		(config.RUNNER_MODE === "firecracker"
			? new FirecrackerRunner(config, app.log)
			: new MockRunner(config.HOST_PUBLIC_IP));

	const restoredInstances = await activeRunner.reconcile();

	for (const instance of restoredInstances) {
		registry.add(instance);
	}

	type ShutdownResult =
		| { ok: true }
		| { ok: false; reason: "already-shutting-down" };

	async function shutdownVm(
		instance: ManagedVm,
		reason: "user" | "expired",
	): Promise<ShutdownResult> {
		if (shuttingDown.has(instance.record.id)) {
			return { ok: false, reason: "already-shutting-down" };
		}
		shuttingDown.add(instance.record.id);
		try {
			await activeRunner.shutdown(instance, reason);
			registry.remove(instance.record.id);
			return { ok: true };
		} finally {
			shuttingDown.delete(instance.record.id);
		}
	}

	const ttlSweepHandle = setInterval(() => {
		const expired = registry
			.expired()
			.filter((item) => !shuttingDown.has(item.record.id));

		void Promise.all(
			expired.map(async (item) => {
				try {
					await shutdownVm(item, "expired");
				} catch (error) {
					app.log.error(
						{ err: error, id: item.record.id },
						"Failed to clean up an expired VM",
					);
				}
			}),
		);
	}, 10_000);

	ttlSweepHandle.unref();

	app.get("/health", async (): Promise<HealthResponse> => {
		const checks = {
			firecrackerBinary: await exists(config.FIRECRACKER_BIN),
			jailerBinary: await exists(config.JAILER_BIN),
			kernelImage: await exists(config.KERNEL_IMAGE_PATH),
			baseImage: await exists(config.BASE_IMAGE_PATH),
		};

		const status =
			config.RUNNER_MODE === "mock"
				? "degraded"
				: Object.values(checks).every(Boolean)
					? "ok"
					: "degraded";

		return healthResponseSchema.parse({
			status,
			runnerMode: config.RUNNER_MODE,
			ttlMinutes: config.VM_TTL_MINUTES,
			maxActiveVms: config.MAX_ACTIVE_VMS,
			checks,
		});
	});

	app.get("/v1/vms", async (): Promise<ListVmsResponse> => {
		return listVmsResponseSchema.parse({ items: registry.list() });
	});

	app.post("/v1/vms", async (request, reply) => {
		if (registry.count() >= config.MAX_ACTIVE_VMS) {
			return reply.code(409).send({
				message: "Maximum active VM limit reached",
			});
		}

		const body = createVmRequestSchema.safeParse(request.body ?? {});

		if (!body.success) {
			return reply.code(400).send({
				message: body.error.issues[0]?.message ?? "Invalid VM create payload",
			});
		}

		const reservation = registry.createReservation(body.data.templateId);

		try {
			const created = await activeRunner.create(reservation);
			registry.add(created.instance);
			return createVmResponseSchema.parse({
				...created.instance.record,
				launchInstructions: created.launchInstructions,
				secret: created.secret,
			});
		} catch (error) {
			registry.releaseReservation(reservation.id);
			app.log.error({ err: error }, "Failed to create VM");
			return reply.code(500).send({
				message: "Failed to create Firecracker VM",
			});
		}
	});

	app.post("/v1/vms/:id/shutdown", async (request, reply) => {
		const paramsResult = z
			.object({ id: z.string().uuid() })
			.safeParse(request.params);
		if (!paramsResult.success) {
			return reply.code(400).send({ message: "Invalid VM ID" });
		}
		const vm = registry.get(paramsResult.data.id);

		if (!vm) {
			return reply.code(404).send({ message: "VM not found" });
		}

		try {
			const result = await shutdownVm(vm, "user");

			if (!result.ok) {
				switch (result.reason) {
					case "already-shutting-down":
						return reply
							.code(409)
							.send({ message: "VM is already shutting down" });
				}
			}

			return {
				...vm.record,
				state: "deleted",
				lastReason: "user",
			};
		} catch (error) {
			app.log.error(
				{ err: error, id: paramsResult.data.id },
				"Failed to shut down VM",
			);
			return reply.code(500).send({ message: "Failed to shut down VM" });
		}
	});

	app.addHook("onClose", async () => {
		clearInterval(ttlSweepHandle);
	});

	return { app, registry, runner: activeRunner };
}
