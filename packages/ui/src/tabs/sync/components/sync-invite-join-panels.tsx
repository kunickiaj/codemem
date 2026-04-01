import { copyToClipboard } from '../../../lib/dom';
import { useLayoutEffect, useRef } from 'preact/hooks';

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
          Add another teammate.
          <span className="sync-action-command">Generate an invite when you are ready to bring another device into this team.</span>
        </div>
        <button type="button" className="settings-button" onClick={onToggle}>
          {invitePanelOpen ? 'Hide invite form' : 'Invite a teammate'}
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
        <span className="sync-action-command">Use the pairing command in Advanced diagnostics when you are ready to connect one.</span>
      </div>
      <button
        type="button"
        className="settings-button sync-action-copy"
        onClick={(event) =>
          copyToClipboard('codemem sync pair --payload-only', event.currentTarget as HTMLButtonElement)
        }
      >
        Copy
      </button>
    </div>
  );
}

export type SyncInviteJoinPanelsProps = {
  invitePanel: HTMLElement | null;
  invitePanelOpen: boolean;
  inviteRestoreParent: HTMLElement | null;
  joinPanel: HTMLElement | null;
  joinRestoreParent: HTMLElement | null;
  onToggleInvitePanel: () => void;
  pairedPeerCount: number;
  presenceStatus: string;
};

export function SyncInviteJoinPanels({
  invitePanel,
  invitePanelOpen,
  inviteRestoreParent,
  joinPanel,
  joinRestoreParent,
  onToggleInvitePanel,
  pairedPeerCount,
  presenceStatus,
}: SyncInviteJoinPanelsProps) {
  const showInviteActions = presenceStatus !== 'not_enrolled';

  return (
    <>
      {presenceStatus === 'not_enrolled' ? (
        <>
          {joinPanel ? (
            <ExistingElementSlot element={joinPanel} hidden={false} restoreParent={joinRestoreParent} />
          ) : null}
          <div className="peer-meta" id="syncJoinFeedback" hidden />
          <div className="sync-action">
            <div className="sync-action-text">
              This device is not on the team yet.
              <span className="sync-action-command">
                Import an invite or ask an admin to enroll it first.
              </span>
            </div>
          </div>
        </>
      ) : null}

      {showInviteActions ? (
        <InviteToggleRow
          invitePanel={invitePanel}
          invitePanelOpen={invitePanelOpen}
          inviteRestoreParent={inviteRestoreParent}
          onToggle={onToggleInvitePanel}
        />
      ) : null}

      {!pairedPeerCount && presenceStatus === 'posted' ? <PairingCopyRow /> : null}
    </>
  );
}
