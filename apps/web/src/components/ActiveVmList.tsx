import type { VmRecord } from "@biohacker/shared";
import { labTemplates } from "@biohacker/shared";

type Props = {
	vms: VmRecord[];
	isLoading: boolean;
	shuttingDownId: string | null;
	onShutdown: (id: string) => void;
};

export default function ActiveVmList({
	vms,
	isLoading,
	shuttingDownId,
	onShutdown,
}: Props) {
	return (
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

			{isLoading ? (
				<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
					Loading VM state...
				</p>
			) : vms.length === 0 ? (
				<p className="m-0 max-w-xl text-sm text-[var(--sea-ink-soft)]">
					No active lab instances. Create one to receive SSH details from the
					daemon.
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
										onShutdown(vm.id);
									}}
									disabled={shuttingDownId === vm.id}
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
	);
}
