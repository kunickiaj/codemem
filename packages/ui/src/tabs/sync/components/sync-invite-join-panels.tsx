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

function AnchorPeerGuide({ pairedPeerCount }: { pairedPeerCount: number }) {
	return (
		<section className="sync-action" aria-labelledby="anchor-peer-guide-title">
			<div className="sync-action-text">
				<span id="anchor-peer-guide-title">Set up an always-on peer.</span>
				<span className="sync-action-command">
					An anchor peer is a normal paired device that stays online. It is not a coordinator,
					relay, or special protocol role.
				</span>
				<ol className="sync-action-command">
					<li>Pair or select the server, desktop, Pi, or VPS you expect to stay online.</li>
					<li>
						Grant only the explicit Sharing domains it should carry; domains absent from its
						Authorized Sharing domains list will not sync to it.
					</li>
					<li>
						Use project filters only to narrow those authorized domains. Coordinator discovery only
						helps devices find each other.
					</li>
					<li>
						Headless setup: run <code>codemem sync enable</code>, copy a pairing payload with{" "}
						<code>codemem sync pair --payload-only</code>, then grant only the intended domains with{" "}
						<code>
							codemem coordinator grant-scope-member &lt;group&gt; &lt;scope-id&gt;
							&lt;anchor-device-id&gt;
						</code>
						. Verify with <code>codemem coordinator list-scope-members</code>.
					</li>
				</ol>
				<a
					className="settings-link"
					href="https://github.com/kunickiaj/codemem/blob/main/docs/anchor-peer-deployment.md"
					rel="noreferrer"
					target="_blank"
				>
					Open anchor-peer deployment guide
				</a>
				<span className="sync-action-command">
					{pairedPeerCount > 0
						? "Expand a device below to review what it can and cannot receive before treating it as your always-on peer."
						: "No paired devices are available yet. Pair the always-on device first, then review its Sharing-domain grants here."}
				</span>
			</div>
		</section>
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
					Accept an invite or pairing.
					<span className="sync-action-command">
						Paste a team invite to join another team, or a pairing payload to connect another
						device.
					</span>
				</div>
				<button type="button" className="settings-button" onClick={onToggle}>
					{joinPanelOpen ? "Hide paste form" : "Paste invite or pairing"}
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
								Paste a team invite or pairing payload below to join an existing team or connect
								another of your devices.
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

			{showInviteActions ? <AnchorPeerGuide pairedPeerCount={pairedPeerCount} /> : null}

			{!pairedPeerCount && presenceStatus === "posted" ? <PairingCopyRow /> : null}
		</>
	);
}
