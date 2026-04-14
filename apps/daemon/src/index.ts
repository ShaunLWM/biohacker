import {
  type HealthResponse,
  healthResponseSchema,
  type ListVmsResponse,
  listVmsResponseSchema,
  type VmRecord,
} from "@biohacker/shared";
import Fastify from "fastify";

import { exists, loadConfig } from "./config.js";
import { FirecrackerRunner } from "./firecracker-runner.js";
import { MockRunner } from "./mock-runner.js";
import type { ManagedVm } from "./types.js";
import { VmRegistry } from "./vm-registry.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const registry = new VmRegistry(config);
const shuttingDown = new Set<string>();
const runner =
  config.RUNNER_MODE === "firecracker"
    ? new FirecrackerRunner(config, app.log)
    : new MockRunner(config.HOST_PUBLIC_IP);

await runner.reconcile();

async function shutdownVm(instance: ManagedVm, reason: "user" | "expired") {
  if (shuttingDown.has(instance.record.id)) {
    return false;
  }

  shuttingDown.add(instance.record.id);

  try {
    await runner.shutdown(instance, reason);
    registry.remove(instance.record.id);
    return true;
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

app.post("/v1/vms", async (_, reply): Promise<VmRecord> => {
  if (registry.count() >= config.MAX_ACTIVE_VMS) {
    return reply.code(409).send({
      message: "Maximum active VM limit reached",
    });
  }

  const reservation = registry.createReservation();

  try {
    const instance = await runner.create(reservation);
    registry.add(instance);
    return instance.record;
  } catch (error) {
    registry.releaseReservation(reservation.id);
    app.log.error({ err: error }, "Failed to create VM");
    return reply.code(500).send({
      message:
        error instanceof Error ? error.message : "Failed to create Firecracker VM",
    });
  }
});

app.post("/v1/vms/:id/shutdown", async (request, reply) => {
  const params = request.params as { id: string };
  const vm = registry.get(params.id);

  if (!vm) {
    return reply.code(404).send({ message: "VM not found" });
  }

  if (shuttingDown.has(vm.record.id)) {
    return reply.code(409).send({ message: "VM is already shutting down" });
  }

  try {
    await shutdownVm(vm, "user");

    return {
      ...vm.record,
      state: "deleted",
      lastReason: "user",
    };
  } catch (error) {
    app.log.error({ err: error, id: params.id }, "Failed to shut down VM");
    return reply.code(500).send({
      message:
        error instanceof Error ? error.message : "Failed to shut down VM",
    });
  }
});

const close = async () => {
  clearInterval(ttlSweepHandle);
  await app.close();
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ host: config.DAEMON_HOST, port: config.DAEMON_PORT });
