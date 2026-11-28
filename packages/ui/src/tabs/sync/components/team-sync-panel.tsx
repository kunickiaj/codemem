import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { UiSyncAttentionItem, UiTeamSyncPrimaryStatus } from "../view-model";

type TeamSyncPanelProps = {
	actionItems: UiSyncAttentionItem[];
	actionableCount: number;
	children?: ComponentChildren;
	onAttentionAction: (item: UiSyncAttentionItem) => Promise<void>;
	presenceStatus: string;
	primaryStatus: UiTeamSyncPrimaryStatus;
};

function SectionHeading({ count, label }: { count?: number; label: string }) {
	return (
		<div className="sync-section-heading">
			<div className="sync-action-text sync-section-label">{label}</div>
			{count ? <span className="badge actor-badge sync-section-count">{count}</span> : null}
		</div>
	);
}

function AttentionRow({
	item,
	onAction,
}: {
	item: UiSyncAttentionItem;
	onAction: (item: UiSyncAttentionItem) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);

	return (
		<div className="sync-action">
			<div className="sync-action-text">
				{item.title}
				<span className="sync-action-guidance">{item.summary}</span>
			</div>
			<button
				type="button"
				className="settings-button"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					try {
						await onAction(item);
					} finally {
						setBusy(false);
					}
				}}
			>
				{item.actionLabel || "Review"}
			</button>
		</div>
	);
}

function ActionContent(props: TeamSyncPanelProps) {
	const hasAttentionItems = props.actionItems.length > 0;
	const hasOtherActionableWork = props.actionableCount > props.actionItems.length;
	const { primaryStatus } = props;

	return (
		<>
			{hasAttentionItems ? <SectionHeading label="Needs attention" /> : null}
			{primaryStatus.nextAction ? (
				<div className="sync-action" data-primary-sync-state={primaryStatus.state}>
					<div className="sync-action-text">
						{primaryStatus.nextActionTitle ?? primaryStatus.badgeLabel}
						<span className="sync-action-guidance">{primaryStatus.nextAction}</span>
					</div>
				</div>
			) : null}
			{hasAttentionItems
				? props.actionItems.map((item) => (
						<AttentionRow key={item.id} item={item} onAction={props.onAttentionAction} />
					))
				: null}
			{!hasAttentionItems && !hasOtherActionableWork && props.primaryStatus.state === "healthy" ? (
				<div className="sync-action">
					<div className="sync-action-text">No urgent team work right now.</div>
				</div>
			) : null}
		</>
	);
}

function TeamActionsContent({ children }: { children?: ComponentChildren }) {
	if (!children) return null;
	return (
		<>
			<SectionHeading label="Add devices & teammates" />
			{children}
		</>
	);
}

export function TeamSyncPanel(props: TeamSyncPanelProps) {
	// The Team status > Overview portal is intentionally NOT rendered here:
	// its data is already surfaced by the header presence chip ("Online"
	// / "Offline") and the "Needs attention" section above. See
	// docs/plans/2026-04-23-sync-tab-redesign.md (Q3). Status summary props
	// stay on the panel so the header chip derivation still works.
	return (
		<>
			<ActionContent {...props} />
			<TeamActionsContent>{props.children}</TeamActionsContent>
		</>
	);
}
