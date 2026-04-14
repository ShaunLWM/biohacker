import {
	type CreateVmResponse,
	type HealthResponse,
	type ListVmsResponse,
	createVmResponseSchema,
	healthResponseSchema,
	listVmsResponseSchema,
	vmRecordSchema,
} from "@biohacker/shared";

async function request<T>(
	input: string,
	init: RequestInit,
	parse: (value: unknown) => T,
) {
	const response = await fetch(`/api/control${input}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	});

	const body = await response.json().catch(() => null);

	if (!response.ok) {
		throw new Error(
			typeof body?.message === "string"
				? body.message
				: `Request failed with status ${response.status}`,
		);
	}

	return parse(body);
}

export function getHealth() {
	return request("/health", { method: "GET" }, (value) =>
		healthResponseSchema.parse(value),
	);
}

export function listVms() {
	return request("/v1/vms", { method: "GET" }, (value) =>
		listVmsResponseSchema.parse(value),
	);
}

export function createVm() {
	return request("/v1/vms", { method: "POST" }, (value) =>
		createVmResponseSchema.parse(value),
	);
}

export function shutdownVm(id: string) {
	return request(`/v1/vms/${id}/shutdown`, { method: "POST" }, (value) =>
		vmRecordSchema.parse(value),
	);
}

export type { CreateVmResponse, HealthResponse, ListVmsResponse };
