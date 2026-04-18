import type { ComponentChildren } from "preact";

type SyncEmptyStateProps = {
	title: ComponentChildren;
	detail: ComponentChildren;
};

export function SyncEmptyState({ title, detail }: SyncEmptyStateProps) {
	return (
		<div className="sync-empty-state" role="status" aria-live="polite" aria-atomic="true">
			<strong>{title}</strong>
			<span>{detail}</span>
		</div>
	);
}
