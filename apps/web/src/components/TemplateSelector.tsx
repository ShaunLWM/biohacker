import type { LabTemplateId } from "@biohacker/shared";
import { labTemplates } from "@biohacker/shared";

type Props = {
	selectedTemplateId: LabTemplateId;
	onSelect: (id: LabTemplateId) => void;
};

export default function TemplateSelector({
	selectedTemplateId,
	onSelect,
}: Props) {
	const selectedTemplate =
		labTemplates.find((item) => item.id === selectedTemplateId) ??
		labTemplates[0];

	return (
		<>
			<div className="mt-6 grid gap-3 sm:grid-cols-2">
				{labTemplates.map((template) => {
					const isSelected = template.id === selectedTemplateId;

					return (
						<button
							key={template.id}
							type="button"
							onClick={() => {
								onSelect(template.id);
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
		</>
	);
}
