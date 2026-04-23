import { useLayoutEffect, useRef } from "preact/hooks";
import { copyToClipboard } from "../../../lib/dom";

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
				<div className="sync-action-text">
					Invite a teammate.
					<span className="sync-action-command">
						Generate an invite when you want someone else to join this team from their device.
					</span>
				</div>
				<button type="button" className="settings-button" onClick={onToggle}>
					{invitePanelOpen ? "Hide invite form" : "Invite a teammate"}
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

function PairingCopyRow() {
	return (
		<div className="sync-action">
			<div className="sync-action-text">
				Pair another device.
				<span className="sync-action-command">
					Copy a pairing command when you want to connect another one of your own devices.
				</span>
			</div>
			<button
				type="button"
				className="settings-button sync-action-copy"
				onClick={(event) =>
					copyToClipboard(
						"codemem sync pair --payload-only",
						event.currentTarget as HTMLButtonElement,
					)
				}
			>
				Copy pairing command
			</button>
		</div>
	);
}

function JoinToggleRow({
	joinPanel,
	joinPanelOpen,
	joinRestoreParent,
	onToggle,
}: {
	joinPanel: HTMLElement | null;
	joinPanelOpen: boolean;
	joinRestoreParent: HTMLElement | null;
	onToggle: () => void;
}) {
	return (
		<>
			<div className="sync-action">
				<div className="sync-action-text">
					Join another team.
					<span className="sync-action-command">
						Paste an invite to join an additional team from this device.
					</span>
				</div>
				<button type="button" className="settings-button" onClick={onToggle}>
					{joinPanelOpen ? "Hide join form" : "Join another team"}
				</button>
			</div>
			{joinPanel ? (
				<ExistingElementSlot
					element={joinPanel}
					hidden={!joinPanelOpen}
					restoreParent={joinRestoreParent}
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
	joinPanelOpen: boolean;
	joinRestoreParent: HTMLElement | null;
	onToggleInvitePanel: () => void;
	onToggleJoinPanel: () => void;
	pairedPeerCount: number;
	presenceStatus: string;
};

export function SyncInviteJoinPanels({
	invitePanel,
	invitePanelOpen,
	inviteRestoreParent,
	joinPanel,
	joinPanelOpen,
	joinRestoreParent,
	onToggleInvitePanel,
	onToggleJoinPanel,
	pairedPeerCount,
	presenceStatus,
}: SyncInviteJoinPanelsProps) {
	const notEnrolled = presenceStatus === "not_enrolled";
	const showInviteActions = !notEnrolled;

	return (
		<>
			{notEnrolled ? (
				<>
					<div className="sync-action">
						<div className="sync-action-text">
							Join this device.
							<span className="sync-action-command">
								Paste an invite for this device below to join an existing team.
							</span>
						</div>
					</div>
					{joinPanel ? (
						<ExistingElementSlot
							element={joinPanel}
							hidden={false}
							restoreParent={joinRestoreParent}
						/>
					) : null}
					<div className="peer-meta" id="syncJoinFeedback" hidden />
					<div className="sync-action">
						<div className="sync-action-text">
							This device is not on the team yet.
							<span className="sync-action-command">
								Use Join this device above, or ask an admin to enroll it first.
							</span>
						</div>
					</div>
				</>
			) : (
				<>
					<JoinToggleRow
						joinPanel={joinPanel}
						joinPanelOpen={joinPanelOpen}
						joinRestoreParent={joinRestoreParent}
						onToggle={onToggleJoinPanel}
					/>
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

			{!pairedPeerCount && presenceStatus === "posted" ? <PairingCopyRow /> : null}
		</>
	);
}
