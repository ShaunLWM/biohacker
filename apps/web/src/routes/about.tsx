import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
	component: About,
});

function About() {
	return (
		<main className="page-wrap px-4 py-12">
			<section className="island-shell rounded-2xl p-6 sm:p-8">
				<p className="island-kicker mb-2">Architecture</p>
				<h1 className="display-title mb-3 text-4xl font-bold text-[var(--sea-ink)] sm:text-5xl">
					One control plane, one host daemon, disposable Firecracker labs.
				</h1>
				<p className="m-0 max-w-3xl text-base leading-8 text-[var(--sea-ink-soft)]">
					The web app runs in Docker and exposes the user interface plus a
					same-origin proxy to the daemon. The privileged Node daemon stays on
					the Ubuntu host so it can access KVM, manage tap devices, and launch
					Firecracker microVMs with ephemeral writable disks.
				</p>
			</section>

			<section className="mt-8 grid gap-4 lg:grid-cols-3">
				{[
					{
						title: "apps/web",
						body: "TanStack Start frontend and proxy API. It owns the browser UX, polling, and mutation flow but does not need direct KVM access.",
					},
					{
						title: "apps/daemon",
						body: "Host-level Node daemon. It enforces TTL, allocates SSH ports, exposes health state, and will own the real Firecracker lifecycle.",
					},
					{
						title: "Host runtime",
						body: "Ubuntu 24.04 with Firecracker, jailer, kernel image, base rootfs, and per-instance state under /var/lib/biohacker.",
					},
				].map((item, index) => (
					<article
						key={item.title}
						className="island-shell feature-card rise-in rounded-2xl p-5"
						style={{ animationDelay: `${index * 80 + 40}ms` }}
					>
						<p className="island-kicker mb-2">{item.title}</p>
						<p className="m-0 text-sm leading-7 text-[var(--sea-ink-soft)]">
							{item.body}
						</p>
					</article>
				))}
			</section>

			<section className="island-shell mt-8 rounded-2xl p-6">
				<p className="island-kicker mb-2">Request flow</p>
				<ol className="m-0 list-decimal space-y-3 pl-5 text-sm leading-7 text-[var(--sea-ink-soft)]">
					<li>User clicks create in the web UI.</li>
					<li>The web app hits its own `/api/control` route.</li>
					<li>The proxy forwards the request privately to the daemon.</li>
					<li>The daemon allocates a VM, SSH port, TTL, and host artifacts.</li>
					<li>
						The frontend receives SSH details and renders them immediately.
					</li>
					<li>Shutdown or TTL expiry deletes the instance state outright.</li>
				</ol>
			</section>
		</main>
	);
}
