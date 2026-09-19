import { useLayoutEffect, useRef } from "preact/hooks";

type ExistingElementSlotProps = {
	element: HTMLElement | null;
	hidden?: boolean;
	restoreParent?: HTMLElement | null;
};

function ExistingElementSlot({
	element,
	hidden = false,
	restoreParent = null,
}: ExistingElementSlotProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);

	useLayoutEffect(() => {
		if (!element) return;
		element.hidden = hidden;
	}, [element, hidden]);

	useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host || !element) return;
		if (element.parentElement !== host) host.appendChild(element);
		return () => {
			if (!restoreParent || element.parentElement !== host) return;
			restoreParent.appendChild(element);
		};
	}, [element, restoreParent]);

	return <div ref={hostRef} />;
}

function InviteToggleRow({
	invitePanel,
	invitePanelOpen,
	inviteRestoreParent,
	onToggle,
}: {
	invitePanel: HTMLElement | null;
	invitePanelOpen: boolean;
	inviteRestoreParent: HTMLElement | null;
	onToggle: () => void;
}) {
	return (
		<>
			<div className="sync-action">
				<button type="button" className="settings-button" onClick={onToggle}>
					{invitePanelOpen ? "Hide team setup" : "Set up a new team instead"}
				</button>
			</div>
			{invitePanel ? (
				<ExistingElementSlot
					element={invitePanel}
					hidden={!invitePanelOpen}
					restoreParent={inviteRestoreParent}
				/>
			) : null}
		</>
	);
}

export type SyncInviteJoinPanelsProps = {
	invitePanel: HTMLElement | null;
	invitePanelOpen: boolean;
	inviteRestoreParent: HTMLElement | null;
	joinPanel: HTMLElement | null;
	joinRestoreParent: HTMLElement | null;
	onToggleInvitePanel: () => void;
	presenceStatus: string;
};

export function SyncInviteJoinPanels({
	invitePanel,
	invitePanelOpen,
	inviteRestoreParent,
	joinPanel,
	joinRestoreParent,
	onToggleInvitePanel,
	presenceStatus,
}: SyncInviteJoinPanelsProps) {
	const notEnrolled = presenceStatus === "not_enrolled";
	const showInviteActions = !notEnrolled;

	return (
		<>
			{notEnrolled ? (
				<>
					<div className="sync-action">
						<div className="sync-action-text">Join this device</div>
					</div>
					{joinPanel ? (
						<ExistingElementSlot
							element={joinPanel}
							hidden={false}
							restoreParent={joinRestoreParent}
						/>
					) : null}
					<div className="peer-meta" id="syncJoinFeedback" hidden />
				</>
			) : (
				<>
					{joinPanel ? (
						<ExistingElementSlot
							element={joinPanel}
							hidden={false}
							restoreParent={joinRestoreParent}
						/>
					) : null}
					{/* The join handler writes into state.syncJoinFlowFeedback and
					    calls setJoinFeedbackVisibility(); that helper exits early
					    if #syncJoinFeedback is missing from the DOM, so we must
					    keep the container mounted in this branch too. Otherwise
					    enrolled users joining another team get no success / error
					    / pending message after import. */}
					<div className="peer-meta" id="syncJoinFeedback" hidden />
				</>
			)}

			{showInviteActions ? (
				<InviteToggleRow
					invitePanel={invitePanel}
					invitePanelOpen={invitePanelOpen}
					inviteRestoreParent={inviteRestoreParent}
					onToggle={onToggleInvitePanel}
				/>
			) : null}
		</>
	);
}
