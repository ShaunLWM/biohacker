import { createFileRoute } from "@tanstack/react-router";

const INTERNAL_DAEMON_URL =
	process.env.DAEMON_INTERNAL_URL ?? "http://127.0.0.1:4000";

async function proxyToDaemon(request: Request) {
	const incomingUrl = new URL(request.url);
	const daemonPath = incomingUrl.pathname.replace(/^\/api\/control/, "") || "/";
	const targetUrl = new URL(`${daemonPath}${incomingUrl.search}`, INTERNAL_DAEMON_URL);
	const body =
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: await request.text();

	const response = await fetch(targetUrl, {
		method: request.method,
		headers: {
			"content-type": request.headers.get("content-type") ?? "application/json",
		},
		body,
	});

	return new Response(await response.text(), {
		status: response.status,
		headers: {
			"content-type": response.headers.get("content-type") ?? "application/json",
		},
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
