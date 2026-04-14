import {
  type HealthResponse,
  healthResponseSchema,
  type ListVmsResponse,
  listVmsResponseSchema,
  type VmRecord,
} from "@biohacker/shared";
import Fastify from "fastify";

import { exists, loadConfig } from "./config.js";
import { VmRegistry } from "./vm-registry.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const registry = new VmRegistry(config);

const ttlSweepHandle = setInterval(() => {
  const expired = registry.collectExpired();

  if (expired.length > 0) {
    app.log.info(
      { ids: expired.map((item) => item.id) },
      "Expired VMs removed by TTL sweeper",
    );
  }
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

  if (config.RUNNER_MODE !== "mock") {
    return reply.code(501).send({
      message:
        "Firecracker runner wiring is not implemented yet. Use RUNNER_MODE=mock for UI development.",
    });
  }

  return registry.create();
});

app.post("/v1/vms/:id/shutdown", async (request, reply) => {
  const params = request.params as { id: string };
  const vm = registry.shutdown(params.id, "user");

  if (!vm) {
    return reply.code(404).send({ message: "VM not found" });
  }

  return vm;
});

const close = async () => {
  clearInterval(ttlSweepHandle);
  await app.close();
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ host: config.DAEMON_HOST, port: config.DAEMON_PORT });
