import type { LabTemplateId } from "@biohacker/shared";
import { labTemplates } from "@biohacker/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import ActiveVmList from "../components/ActiveVmList";
import CreatedVmDetails from "../components/CreatedVmDetails";
import DaemonHealth from "../components/DaemonHealth";
import TemplateSelector from "../components/TemplateSelector";
import type { CreateVmResponse } from "../lib/api";
import { createVm, getHealth, listVms, shutdownVm } from "../lib/api";
import { reconcileLatestCreatedVm } from "../lib/latest-created-vm";

export const Route = createFileRoute("/")({ component: App });

function App() {
	const [selectedTemplateId, setSelectedTemplateId] = useState<LabTemplateId>(
		labTemplates[0]?.id ?? "weak-ssh",
	);
	const [latestCreatedVm, setLatestCreatedVm] =
		useState<CreateVmResponse | null>(null);
	const [latestCreatedVmListBaseline, setLatestCreatedVmListBaseline] =
		useState(0);
	const queryClient = useQueryClient();

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
				<TemplateSelector
					selectedTemplateId={selectedTemplateId}
					onSelect={setSelectedTemplateId}
				/>
				{createVmMutation.error ? (
					<p className="mt-4 text-sm font-semibold text-[#8d3c2f]">
						{createVmMutation.error.message}
					</p>
				) : null}
				{latestCreatedVm ? (
					<CreatedVmDetails
						vm={latestCreatedVm}
						onDismiss={() => {
							setLatestCreatedVm(null);
							setLatestCreatedVmListBaseline(0);
						}}
					/>
				) : null}
			</section>

			<section className="mt-8 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
				<ActiveVmList
					vms={vms}
					isLoading={vmListQuery.isLoading}
					isShuttingDown={shutdownVmMutation.isPending}
					onShutdown={(id) => {
						shutdownVmMutation.mutate(id);
					}}
				/>
				<DaemonHealth health={healthQuery.data} />
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
