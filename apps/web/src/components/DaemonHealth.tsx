import type { HealthResponse } from "@biohacker/shared";

type Props = {
	health: HealthResponse | undefined;
};

export default function DaemonHealth({ health }: Props) {
	return (
		<article className="island-shell feature-card rise-in rounded-2xl p-5">
			<p className="island-kicker mb-2">Daemon health</p>
			<h2 className="m-0 text-2xl font-semibold text-[var(--sea-ink)]">
				{health?.status === "ok" ? "Ready for Firecracker" : "Degraded"}
			</h2>
			<p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
				Current runner mode: <strong>{health?.runnerMode ?? "loading"}</strong>
			</p>

			<div className="mt-5 grid gap-3">
				{[
					{
						label: "Firecracker binary",
						value: health?.checks.firecrackerBinary,
					},
					{ label: "Jailer binary", value: health?.checks.jailerBinary },
					{ label: "Kernel image", value: health?.checks.kernelImage },
					{ label: "Base image", value: health?.checks.baseImage },
				].map(({ label, value }) => (
					<div
						key={label}
						className="flex items-center justify-between rounded-2xl border border-[var(--line)] bg-white/55 px-4 py-3"
					>
						<span className="text-sm font-medium text-[var(--sea-ink)]">
							{label}
						</span>
						<span
							className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${
								value
									? "bg-[rgba(47,106,74,0.12)] text-[var(--palm)]"
									: "bg-[rgba(141,60,47,0.08)] text-[#8d3c2f]"
							}`}
						>
							{value ? "present" : "missing"}
						</span>
					</div>
				))}
			</div>

			<div className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
				<p className="island-kicker mb-2">Limits</p>
				<ul className="m-0 list-disc space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
					<li>Configured TTL: {health?.ttlMinutes ?? "..."} minutes</li>
					<li>Max active VMs: {health?.maxActiveVms ?? "..."}</li>
					<li>Shutdown removes writable state immediately</li>
				</ul>
			</div>
		</article>
	);
}
