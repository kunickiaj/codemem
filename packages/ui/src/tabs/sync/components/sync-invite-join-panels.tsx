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
	onToggleInvitePanel: () => void;
	presenceStatus: string;
};

/** The Team setup toggle. Accepting an invitation happens in Sharing. */
export function SyncInviteJoinPanels({
	invitePanel,
	invitePanelOpen,
	inviteRestoreParent,
	onToggleInvitePanel,
	presenceStatus,
}: SyncInviteJoinPanelsProps) {
	if (presenceStatus === "not_enrolled") return null;
	return (
		<InviteToggleRow
			invitePanel={invitePanel}
			invitePanelOpen={invitePanelOpen}
			inviteRestoreParent={inviteRestoreParent}
			onToggle={onToggleInvitePanel}
		/>
	);
}
