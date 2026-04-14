import { randomUUID } from "node:crypto";

import type { VmRecord, VmTerminationReason } from "@biohacker/shared";

import type { DaemonConfig } from "./config.js";

const SSH_PRIVATE_KEY_PLACEHOLDER = `-----BEGIN OPENSSH PRIVATE KEY-----
mock-runner-placeholder
-----END OPENSSH PRIVATE KEY-----`;

export class VmRegistry {
	readonly #items = new Map<string, VmRecord>();
	#nextPort: number;

	constructor(private readonly config: DaemonConfig) {
		this.#nextPort = config.SSH_PORT_RANGE_START;
	}

	list() {
		return Array.from(this.#items.values()).sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		);
	}

	count() {
		return this.#items.size;
	}

	create() {
		const now = new Date();
		const expiresAt = new Date(
			now.getTime() + this.config.VM_TTL_MINUTES * 60 * 1000,
		);
		const item: VmRecord = {
			id: randomUUID(),
			state: "running",
			host: this.config.HOST_PUBLIC_IP,
			sshPort: this.#allocatePort(),
			username: "ubuntu",
			privateKey: SSH_PRIVATE_KEY_PLACEHOLDER,
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			lastReason: null,
		};

		this.#items.set(item.id, item);
		return item;
	}

	shutdown(id: string, reason: VmTerminationReason) {
		const current = this.#items.get(id);

		if (!current) {
			return null;
		}

		const updated: VmRecord = {
			...current,
			state: "deleted",
			lastReason: reason,
		};

		this.#items.delete(id);

		return updated;
	}

	collectExpired(now = new Date()) {
		const expired = this.list().filter(
			(item) => new Date(item.expiresAt).getTime() <= now.getTime(),
		);

		for (const item of expired) {
			this.shutdown(item.id, "expired");
		}

		return expired;
	}

	#allocatePort() {
		const start = this.config.SSH_PORT_RANGE_START;
		const end = this.config.SSH_PORT_RANGE_END;
		const span = end - start + 1;

		for (let index = 0; index < span; index += 1) {
			const candidate = this.#nextPort + index;
			const port = candidate > end ? start + (candidate - end - 1) : candidate;
			const inUse = this.list().some((item) => item.sshPort === port);

			if (!inUse) {
				this.#nextPort = port === end ? start : port + 1;
				return port;
			}
		}

		throw new Error("No SSH ports available in configured range");
	}
}
