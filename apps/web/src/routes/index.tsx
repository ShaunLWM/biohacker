import { labTemplates } from "@biohacker/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CreateVmResponse } from "../lib/api";
import { createVm, getHealth, listVms, shutdownVm } from "../lib/api";
import { reconcileLatestCreatedVm } from "../lib/latest-created-vm";
import { buildSshCommand } from "../lib/ssh";

export const Route = createFileRoute("/")({ component: App });

function App() {
	const [selectedTemplateId, setSelectedTemplateId] = useState(
		labTemplates[0]?.id ?? "weak-ssh",
	);
	const [latestCreatedVm, setLatestCreatedVm] =
		useState<CreateVmResponse | null>(null);
	const [latestCreatedVmListBaseline, setLatestCreatedVmListBaseline] =
		useState(0);
	const queryClient = useQueryClient();
	const selectedTemplate =
		labTemplates.find((item) => item.id === selectedTemplateId) ??
		labTemplates[0];
	const healthQuery = useQuery({
		queryKey: ["daemon-health"],
		queryFn: getHealth,
		refetchInterval: 15000,
	});
	const vmListQuery = useQuery({
		queryKey: ["vms"],
		queryFn: listVms,
		refetchInterval: 5000,
	});
	const createVmMutation = useMutation({
		mutationFn: createVm,
		onSuccess: async (vm) => {
			setLatestCreatedVm(vm);
			setLatestCreatedVmListBaseline(vmListQuery.dataUpdatedAt);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vms"] }),
				queryClient.invalidateQueries({ queryKey: ["daemon-health"] }),
			]);
		},
	});
	const shutdownVmMutation = useMutation({
		mutationFn: shutdownVm,
		onSuccess: async (vm) => {
			if (latestCreatedVm?.id === vm.id) {
				setLatestCreatedVm(null);
				setLatestCreatedVmListBaseline(0);
			}
			await queryClient.invalidateQueries({ queryKey: ["vms"] });
		},
	});
	const vms = vmListQuery.data?.items ?? [];
	const health = healthQuery.data;
	const reconciledLatestCreatedVm = reconcileLatestCreatedVm(
		latestCreatedVm,
		vms,
		vmListQuery.dataUpdatedAt,
		latestCreatedVmListBaseline,
	);

	useEffect(() => {
		if (reconciledLatestCreatedVm === latestCreatedVm) {
			return;
		}

		setLatestCreatedVm(reconciledLatestCreatedVm);

		if (!reconciledLatestCreatedVm) {
			setLatestCreatedVmListBaseline(0);
		}
	}, [latestCreatedVm, reconciledLatestCreatedVm]);

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
				<div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
				<div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />
				<p className="island-kicker mb-3">Single-click ephemeral lab</p>
				<h1 className="display-title mb-5 max-w-3xl text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
					Launch a disposable Firecracker lab and practice against a real
					target.
				</h1>
				<p className="mb-8 max-w-2xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
					Each lab boots from a clean Ubuntu base image, exposes a single SSH
					target, and self-destructs on shutdown or TTL expiry.
				</p>
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						onClick={() => {
							createVmMutation.mutate({ templateId: selectedTemplateId });
						}}
						disabled={createVmMutation.isPending}
						className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)] disabled:cursor-not-allowed disabled:opacity-60"
					>
						{createVmMutation.isPending ? "Launching lab..." : "Launch lab"}
					</button>
					<a
						href="/about"
						className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] no-underline transition hover:-translate-y-0.5 hover:border-[rgba(23,58,64,0.35)]"
					>
						View host architecture
					</a>
				</div>
				<div className="mt-6 grid gap-3 sm:grid-cols-2">
					{labTemplates.map((template) => {
						const isSelected = template.id === selectedTemplateId;

						return (
							<button
								key={template.id}
								type="button"
								onClick={() => {
									setSelectedTemplateId(template.id);
								}}
								className={`rounded-[1.5rem] border p-4 text-left transition ${
									isSelected
										? "border-[rgba(50,143,151,0.45)] bg-[rgba(79,184,178,0.14)] shadow-[0_18px_36px_rgba(23,58,64,0.1)]"
										: "border-[var(--line)] bg-white/58 hover:-translate-y-0.5 hover:border-[rgba(23,58,64,0.28)]"
								}`}
							>
								<p className="island-kicker mb-2">{template.id}</p>
								<h2 className="m-0 text-lg font-semibold text-[var(--sea-ink)]">
									{template.name}
								</h2>
								<p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
									{template.summary}
								</p>
								<p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--sea-ink-soft)]">
									Auth: {template.authMode} · User: {template.username}
								</p>
							</button>
						);
					})}
				</div>
				{selectedTemplate ? (
					<div className="mt-4 rounded-[1.5rem] border border-[var(--line)] bg-white/55 p-4">
						<p className="island-kicker mb-2">Current objective</p>
						<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
							{selectedTemplate.objective}
						</p>
					</div>
				) : null}
				{createVmMutation.error ? (
					<p className="mt-4 text-sm font-semibold text-[#8d3c2f]">
						{createVmMutation.error.message}
					</p>
				) : null}

				{latestCreatedVm ? (
					<div className="mt-6 rounded-[1.75rem] border border-[rgba(23,58,64,0.14)] bg-white/72 p-5 shadow-[0_20px_40px_rgba(23,58,64,0.08)]">
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div>
								<p className="island-kicker mb-2">Lab ready</p>
								<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
									{labTemplates.find(
										(item) => item.id === latestCreatedVm.templateId,
									)?.objective ?? "Use the target details below in your lab."}
								</p>
							</div>
							<button
								type="button"
								onClick={() => {
									setLatestCreatedVm(null);
									setLatestCreatedVmListBaseline(0);
								}}
								className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--sea-ink-soft)] transition hover:-translate-y-0.5"
							>
								Dismiss
							</button>
						</div>
						<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
							<p className="island-kicker mb-2">SSH command</p>
							<pre className="m-0 overflow-x-auto text-xs leading-6 text-[var(--sea-ink-soft)]">
								<code>{buildSshCommand(latestCreatedVm)}</code>
							</pre>
						</div>
						<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
							<p className="island-kicker mb-2">Launch notes</p>
							<ul className="m-0 list-disc space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
								{latestCreatedVm.launchInstructions.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</div>
						{latestCreatedVm.secret.kind === "password" ? (
							<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
								<p className="island-kicker mb-2">Password</p>
								<pre className="m-0 overflow-x-auto text-xs leading-6 text-[var(--sea-ink-soft)]">
									<code>{latestCreatedVm.secret.password}</code>
								</pre>
							</div>
						) : null}
						{latestCreatedVm.secret.kind === "none" ? (
							<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
								<p className="island-kicker mb-2">Credential policy</p>
								<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
									This lab does not reveal credentials. Use the SSH target, your
									chosen tooling, and the stated objective to gain access.
								</p>
							</div>
						) : null}
						{latestCreatedVm.secret.kind === "private-key" ? (
							<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
								<p className="island-kicker mb-2">Private key</p>
								<pre className="m-0 overflow-x-auto text-xs leading-6 text-[var(--sea-ink-soft)]">
									<code>{latestCreatedVm.secret.privateKey}</code>
								</pre>
							</div>
						) : null}
					</div>
				) : null}
			</section>

			<section className="mt-8 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
				<article className="island-shell feature-card rise-in rounded-2xl p-5">
					<div className="mb-4 flex items-start justify-between gap-4">
						<div>
							<p className="island-kicker mb-2">Active VMs</p>
							<h2 className="m-0 text-2xl font-semibold text-[var(--sea-ink)]">
								{vms.length} running
							</h2>
						</div>
						<div className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--sea-ink-soft)]">
							Refreshes every 5s
						</div>
					</div>

					{vmListQuery.isLoading ? (
						<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
							Loading VM state...
						</p>
					) : vms.length === 0 ? (
						<p className="m-0 max-w-xl text-sm text-[var(--sea-ink-soft)]">
							No active lab instances. Create one to receive SSH details from
							the daemon.
						</p>
					) : (
						<div className="grid gap-4">
							{vms.map((vm) => (
								<article
									key={vm.id}
									className="rounded-[1.5rem] border border-[var(--line)] bg-white/55 p-5 shadow-[0_16px_30px_rgba(23,58,64,0.06)]"
								>
									<div className="flex flex-wrap items-start justify-between gap-3">
										<div>
											<p className="island-kicker mb-2">
												{labTemplates.find((item) => item.id === vm.templateId)
													?.name ?? vm.templateId}
											</p>
											<h3 className="m-0 text-xl font-semibold text-[var(--sea-ink)]">
												SSH {vm.username}@{vm.host}:{vm.sshPort}
											</h3>
										</div>
										<button
											type="button"
											onClick={() => {
												shutdownVmMutation.mutate(vm.id);
											}}
											disabled={shutdownVmMutation.isPending}
											className="rounded-full border border-[rgba(141,60,47,0.18)] bg-[rgba(141,60,47,0.08)] px-4 py-2 text-sm font-semibold text-[#8d3c2f] transition hover:-translate-y-0.5 hover:bg-[rgba(141,60,47,0.12)] disabled:cursor-not-allowed disabled:opacity-60"
										>
											Shutdown
										</button>
									</div>

									<dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
										<div>
											<dt className="island-kicker mb-1">Template</dt>
											<dd className="m-0 text-[var(--sea-ink-soft)]">
												{vm.templateId}
											</dd>
										</div>
										<div>
											<dt className="island-kicker mb-1">Created</dt>
											<dd className="m-0 text-[var(--sea-ink-soft)]">
												{new Date(vm.createdAt).toLocaleString()}
											</dd>
										</div>
										<div>
											<dt className="island-kicker mb-1">Expires</dt>
											<dd className="m-0 text-[var(--sea-ink-soft)]">
												{new Date(vm.expiresAt).toLocaleString()}
											</dd>
										</div>
									</dl>
								</article>
							))}
						</div>
					)}
				</article>

				<article className="island-shell feature-card rise-in rounded-2xl p-5">
					<p className="island-kicker mb-2">Daemon health</p>
					<h2 className="m-0 text-2xl font-semibold text-[var(--sea-ink)]">
						{health?.status === "ok" ? "Ready for Firecracker" : "Degraded"}
					</h2>
					<p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
						Current runner mode:{" "}
						<strong>{health?.runnerMode ?? "loading"}</strong>
					</p>

					<div className="mt-5 grid gap-3">
						{[
							{
								label: "Firecracker binary",
								value: health?.checks.firecrackerBinary,
							},
							{
								label: "Jailer binary",
								value: health?.checks.jailerBinary,
							},
							{
								label: "Kernel image",
								value: health?.checks.kernelImage,
							},
							{
								label: "Base image",
								value: health?.checks.baseImage,
							},
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
			</section>

			<section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{[
					[
						"Ephemeral By Default",
						"Each VM boots from a reusable base image and gets deleted on shutdown or expiry.",
					],
					[
						"SSH Over Host Port",
						"The frontend returns host IP and forwarded SSH port instead of exposing guest private addresses.",
					],
					[
						"Hybrid Deployment",
						"Compose owns the web stack while the daemon stays on the host for KVM and tap access.",
					],
					[
						"Multi-Host Ready Shape",
						"The v1 daemon is local only, but the control-plane contract leaves room for future workers.",
					],
				].map(([title, desc], index) => (
					<article
						key={title}
						className="island-shell feature-card rise-in rounded-2xl p-5"
						style={{ animationDelay: `${index * 90 + 80}ms` }}
					>
						<h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">
							{title}
						</h2>
						<p className="m-0 text-sm text-[var(--sea-ink-soft)]">{desc}</p>
					</article>
				))}
			</section>
		</main>
	);
}
