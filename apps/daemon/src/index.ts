import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await buildApp(config);

const close = async () => {
	await app.close();
};

process.on("SIGINT", () => {
	void close();
});
process.on("SIGTERM", () => {
	void close();
});

await app.listen({ host: config.DAEMON_HOST, port: config.DAEMON_PORT });
