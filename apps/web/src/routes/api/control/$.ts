import { createFileRoute } from "@tanstack/react-router";

const INTERNAL_DAEMON_URL =
	process.env.DAEMON_INTERNAL_URL ?? "http://127.0.0.1:4000";

async function proxyToDaemon(request: Request) {
	const incomingUrl = new URL(request.url);
	const daemonPath = incomingUrl.pathname.replace(/^\/api\/control/, "") || "/";
	const targetUrl = new URL(`${daemonPath}${incomingUrl.search}`, INTERNAL_DAEMON_URL);
	const requestText =
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: await request.text();
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
