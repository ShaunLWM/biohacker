import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { waitForSsh } from "./firecracker-process.js";

test("waitForSsh waits for an SSH banner instead of a bare TCP accept", async () => {
	let attempts = 0;
	const server = createServer((socket) => {
		attempts += 1;

		if (attempts < 3) {
			socket.destroy();
			return;
		}

		socket.write("SSH-2.0-OpenSSH_9.6\r\n");
		socket.end();
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => resolve());
		server.once("error", reject);
	});

	const address = server.address();

	try {
		if (!address || typeof address === "string") {
			throw new Error("Failed to resolve test server address");
		}

		await waitForSsh("127.0.0.1", address.port, 5_000);
		assert.equal(attempts, 3);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
});
