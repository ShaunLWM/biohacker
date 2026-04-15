import { createFileRoute } from "@tanstack/react-router";

const INTERNAL_DAEMON_URL =
	process.env.DAEMON_INTERNAL_URL ?? "http://127.0.0.1:4000";

const MAX_BODY_BYTES = 4096;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isAllowedPath(pathname: string, method: string): boolean {
	if (pathname === "/health" && method === "GET") return true;
	if (pathname === "/v1/vms" && (method === "GET" || method === "POST"))
		return true;
	if (method === "POST") {
		const shutdownMatch = pathname.match(/^\/v1\/vms\/([^/]+)\/shutdown$/);
		if (shutdownMatch) return UUID_PATTERN.test(shutdownMatch[1] ?? "");
	}
	return false;
}

async function proxyToDaemon(request: Request) {
	const incomingUrl = new URL(request.url);
	const daemonPath =
		incomingUrl.pathname.replace(/^\/api\/control/, "") || "/";

	if (!isAllowedPath(daemonPath, request.method)) {
		return new Response(JSON.stringify({ message: "Not found" }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	}

	const contentLength = request.headers.get("content-length");
	if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
		return new Response(
			JSON.stringify({ message: "Request body too large" }),
			{
				status: 413,
				headers: { "content-type": "application/json" },
			},
		);
	}

	const targetUrl = new URL(
		`${daemonPath}${incomingUrl.search}`,
		INTERNAL_DAEMON_URL,
	);
	const requestText =
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: await request.text();

	if (requestText !== undefined && requestText.length > MAX_BODY_BYTES) {
		return new Response(
			JSON.stringify({ message: "Request body too large" }),
			{
				status: 413,
				headers: { "content-type": "application/json" },
			},
		);
	}

	const body = requestText && requestText.length > 0 ? requestText : undefined;
	const headers = new Headers();
	const incomingContentType = request.headers.get("content-type");

	if (body !== undefined && incomingContentType) {
		headers.set("content-type", incomingContentType);
	}

	const response = await fetch(targetUrl, {
		method: request.method,
		headers,
		body,
	});
	const responseHeaders = new Headers();
	const responseContentType = response.headers.get("content-type");

	if (responseContentType) {
		responseHeaders.set("content-type", responseContentType);
	}

	return new Response(await response.text(), {
		status: response.status,
		headers: responseHeaders,
	});
}

export const Route = createFileRoute("/api/control/$")({
	server: {
		handlers: {
			GET: ({ request }) => proxyToDaemon(request),
			POST: ({ request }) => proxyToDaemon(request),
		},
	},
});
