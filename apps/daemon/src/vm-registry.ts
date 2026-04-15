import { randomUUID } from "node:crypto";

import type { DaemonConfig } from "./config.js";
import type { ManagedVm, VmReservation } from "./types.js";

export class VmRegistry {
	readonly #items = new Map<string, ManagedVm>();
	readonly #pending = new Map<string, VmReservation>();
	#nextPort: number;

	constructor(private readonly config: DaemonConfig) {
		this.#nextPort = config.SSH_PORT_RANGE_START;
	}

	count() {
		return this.#items.size + this.#pending.size;
	}

	list() {
		return Array.from(this.#items.values())
			.map((item) => item.record)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	get(id: string) {
		return this.#items.get(id) ?? null;
	}

	createReservation(templateId: VmReservation["templateId"]): VmReservation {
		const now = new Date();
		const reservation: VmReservation = {
			id: randomUUID(),
			templateId,
			sshPort: this.#allocatePort(),
			createdAt: now.toISOString(),
			expiresAt: new Date(
				now.getTime() + this.config.VM_TTL_MINUTES * 60 * 1000,
			).toISOString(),
		};

		this.#pending.set(reservation.id, reservation);

		return reservation;
	}

	add(instance: ManagedVm) {
		this.#pending.delete(instance.record.id);
		this.#items.set(instance.record.id, instance);
	}

	remove(id: string) {
		const current = this.#items.get(id) ?? null;
		this.#items.delete(id);
		return current;
	}

	releaseReservation(id: string) {
		this.#pending.delete(id);
	}

	expired(now = new Date()) {
		return Array.from(this.#items.values()).filter(
			(item) => new Date(item.record.expiresAt).getTime() <= now.getTime(),
		);
	}

	#allocatePort() {
		const start = this.config.SSH_PORT_RANGE_START;
		const end = this.config.SSH_PORT_RANGE_END;
		const span = end - start + 1;
		const reservedPorts = new Set<number>();

		for (const item of this.#items.values()) {
			reservedPorts.add(item.record.sshPort);
		}

		for (const reservation of this.#pending.values()) {
			reservedPorts.add(reservation.sshPort);
		}

		for (let index = 0; index < span; index += 1) {
			const candidate = this.#nextPort + index;
			const port = candidate > end ? start + (candidate - end - 1) : candidate;

			if (!reservedPorts.has(port)) {
				this.#nextPort = port === end ? start : port + 1;
				return port;
			}
		}

		throw new Error("No SSH ports available in configured range");
	}
}
