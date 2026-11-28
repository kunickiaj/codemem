import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useState } from "preact/hooks";
import { state } from "../../../lib/state";
import type { UiSyncAttentionItem, UiTeamSyncPrimaryStatus } from "../view-model";
import { type SyncActionFeedback, SyncInlineFeedback } from "./sync-inline-feedback";

export interface TeamSyncPendingJoinRequest {
	displayName: string;
	requestId: string;
}

type TeamSyncPanelProps = {
	actionItems: UiSyncAttentionItem[];
	actionableCount: number;
	children?: ComponentChildren;
	joinRequestsMount: HTMLElement | null;
	onApproveJoinRequest: (request: TeamSyncPendingJoinRequest) => Promise<SyncActionFeedback | null>;
	onAttentionAction: (item: UiSyncAttentionItem) => Promise<void>;
	onDenyJoinRequest: (request: TeamSyncPendingJoinRequest) => Promise<SyncActionFeedback | null>;
	pendingJoinRequests: TeamSyncPendingJoinRequest[];
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

function PendingJoinRequestRow({
	request,
	onApprove,
	onDeny,
}: {
	request: TeamSyncPendingJoinRequest;
	onApprove: (request: TeamSyncPendingJoinRequest) => Promise<SyncActionFeedback | null>;
	onDeny: (request: TeamSyncPendingJoinRequest) => Promise<SyncActionFeedback | null>;
}) {
	const [busyAction, setBusyAction] = useState<"approve" | "deny" | null>(null);
	const [feedback, setFeedback] = useState<SyncActionFeedback | null>(null);
	const [approveLabel, setApproveLabel] = useState("Approve");
	const [denyLabel, setDenyLabel] = useState("Deny");

	return (
		<div className="actor-row">
			<div className="actor-details">
				<div className="actor-title" title={request.requestId || undefined}>
					{request.displayName}
				</div>
			</div>
			<div className="actor-actions">
				<button
					type="button"
					className="settings-button"
					aria-label={`${approveLabel} join request from ${request.displayName}`}
					disabled={busyAction !== null}
					onClick={async () => {
						setBusyAction("approve");
						setApproveLabel("Approving…");
						try {
							setFeedback((await onApprove(request)) || null);
							setApproveLabel("Approve");
						} catch {
							setApproveLabel("Retry");
						} finally {
							setBusyAction(null);
						}
					}}
				>
					{approveLabel}
				</button>
				<button
					type="button"
					className="settings-button"
					aria-label={`${denyLabel} join request from ${request.displayName}`}
					disabled={busyAction !== null}
					onClick={async () => {
						setBusyAction("deny");
						setDenyLabel("Denying…");
						try {
							setFeedback((await onDeny(request)) || null);
							setDenyLabel("Deny");
						} catch {
							setDenyLabel("Retry");
						} finally {
							setBusyAction(null);
						}
					}}
				>
					{denyLabel}
				</button>
			</div>
			<SyncInlineFeedback feedback={feedback} />
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

function PendingRequestsPortal({
	mount,
	requests,
	onApprove,
	onDeny,
}: {
	mount: HTMLElement | null;
	requests: TeamSyncPendingJoinRequest[];
	onApprove: (request: TeamSyncPendingJoinRequest) => Promise<SyncActionFeedback | null>;
	onDeny: (request: TeamSyncPendingJoinRequest) => Promise<SyncActionFeedback | null>;
}) {
	if (!mount || (!requests.length && !state.syncJoinRequestsFeedback)) return null;
	return createPortal(
		<>
			<SectionHeading count={requests.length || undefined} label="Join requests to review" />
			<SyncInlineFeedback feedback={state.syncJoinRequestsFeedback} />
			{requests.map((request) => (
				<PendingJoinRequestRow
					key={request.requestId}
					request={request}
					onApprove={onApprove}
					onDeny={onDeny}
				/>
			))}
		</>,
		mount,
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
			<PendingRequestsPortal
				mount={props.joinRequestsMount}
				requests={props.pendingJoinRequests}
				onApprove={props.onApproveJoinRequest}
				onDeny={props.onDenyJoinRequest}
			/>
		</>
	);
}
