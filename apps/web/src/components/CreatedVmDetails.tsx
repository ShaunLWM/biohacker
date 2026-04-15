import type { VmSecret } from "@biohacker/shared";
import { labTemplates } from "@biohacker/shared";
import type { CreateVmResponse } from "../lib/api";
import { buildSshCommand } from "../lib/ssh";

type Props = {
	vm: CreateVmResponse;
	onDismiss: () => void;
};

function SecretPanel({ secret }: { secret: VmSecret }) {
	switch (secret.kind) {
		case "password":
			return (
				<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
					<p className="island-kicker mb-2">Password</p>
					<pre className="m-0 overflow-x-auto text-xs leading-6 text-[var(--sea-ink-soft)]">
						<code>{secret.password}</code>
					</pre>
				</div>
			);
		case "none":
			return (
				<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
					<p className="island-kicker mb-2">Credential policy</p>
					<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
						This lab does not reveal credentials. Use the SSH target, your
						chosen tooling, and the stated objective to gain access.
					</p>
				</div>
			);
		case "private-key":
			return (
				<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
					<p className="island-kicker mb-2">Private key</p>
					<pre className="m-0 overflow-x-auto text-xs leading-6 text-[var(--sea-ink-soft)]">
						<code>{secret.privateKey}</code>
					</pre>
				</div>
			);
	}
}

export default function CreatedVmDetails({ vm, onDismiss }: Props) {
	const objective =
		labTemplates.find((item) => item.id === vm.templateId)?.objective ??
		"Use the target details below in your lab.";

	return (
		<div className="mt-6 rounded-[1.75rem] border border-[rgba(23,58,64,0.14)] bg-white/72 p-5 shadow-[0_20px_40px_rgba(23,58,64,0.08)]">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<p className="island-kicker mb-2">Lab ready</p>
					<p className="m-0 text-sm text-[var(--sea-ink-soft)]">{objective}</p>
				</div>
				<button
					type="button"
					onClick={onDismiss}
					className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--sea-ink-soft)] transition hover:-translate-y-0.5"
				>
					Dismiss
				</button>
			</div>
			<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
				<p className="island-kicker mb-2">SSH command</p>
				<pre className="m-0 overflow-x-auto text-xs leading-6 text-[var(--sea-ink-soft)]">
					<code>{buildSshCommand(vm)}</code>
				</pre>
			</div>
			<div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
				<p className="island-kicker mb-2">Launch notes</p>
				<ul className="m-0 list-disc space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
					{vm.launchInstructions.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			</div>
			<SecretPanel secret={vm.secret} />
		</div>
	);
}
