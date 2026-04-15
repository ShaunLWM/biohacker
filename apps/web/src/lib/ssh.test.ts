import assert from "node:assert/strict";
import test from "node:test";

import { buildSshCommand } from "./ssh.ts";

test("buildSshCommand renders the expected SSH invocation", () => {
	assert.equal(
		buildSshCommand({
			host: "203.0.113.10",
			sshPort: 2203,
			username: "ubuntu",
		}),
		"ssh -p 2203 ubuntu@203.0.113.10",
	);
});
