import type { TargetedInputEvent } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { RadixSelect, type RadixSelectOption } from '../../../components/primitives/radix-select';
import { formatTimestamp } from '../../../lib/format';
import { showGlobalNotice } from '../../../lib/notice';
import { state, isSyncRedactionEnabled } from '../../../lib/state';
import { PeerScopeCollapsible } from '../peer-scope-collapsible';
import {
  assignmentNote,
  consumePeerScopeReviewRequest,
  createChipEditor,
  isPeerScopeReviewPending,
  openPeerScopeEditors,
  pickPrimaryAddress,
  redactAddress,
} from '../helpers';
import { derivePeerTrustSummary, summarizeSyncRunResult, type PeerLike } from '../view-model';
import { renderIntoSyncMount } from './render-root';

type PeerScopeLike = {
  include?: string[];
  exclude?: string[];
  effective_include?: string[];
  effective_exclude?: string[];
  inherits_global?: boolean;
};

type SyncPeer = PeerLike & {
  actor_display_name?: string;
  addresses?: unknown[];
  claimed_local_actor?: boolean;
  project_scope?: PeerScopeLike;
};

type SyncPeerStatus = NonNullable<SyncPeer['status']> & {
  last_ping_at?: string;
  last_ping_at_utc?: string;
  last_sync_at?: string;
  last_sync_at_utc?: string;
};

type SyncPeerCardProps = {
  peer: SyncPeer;
  onAssignActor: (peerId: string, actorId: string | null) => Promise<void>;
  onRemove: (peerId: string, label: string) => Promise<void>;
  onRename: (peerId: string, name: string) => Promise<void>;
  onResetScope: (peerId: string) => Promise<void>;
  onSaveScope: (peerId: string, include: string[], exclude: string[]) => Promise<void>;
  onSync: (peer: SyncPeer, address: string | undefined) => Promise<ReturnType<typeof summarizeSyncRunResult> | null>;
};

type SyncPeersListProps = Omit<SyncPeerCardProps, 'peer'> & {
  peers: SyncPeer[];
};

function actorOptions(): RadixSelectOption[] {
  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  return [
    { value: '', label: 'No person assigned' },
    ...actors.map((actor) => {
      const actorId = String(actor?.actor_id || '');
      const label = actor.is_local
        ? `${String(actor.display_name || actorId || 'Unknown person')} (local)`
        : String(actor.display_name || actorId || 'Unknown person');
      return { value: actorId, label };
    }),
  ].filter((option, index, all) => index === all.findIndex((candidate) => candidate.value === option.value));
}

function listText(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function summaryText(prefix: string, values: string[], emptyLabel: string): string {
  return `${prefix}: ${values.join(', ') || emptyLabel}`;
}

function ExistingElementSlot({ element }: { element: HTMLElement }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (element.parentElement !== host) host.appendChild(element);
    return () => {
      if (element.parentElement === host) {
        host.removeChild(element);
      }
    };
  }, [element]);

  return <div ref={hostRef} />;
}

function SyncPeerCard({
  peer,
  onAssignActor,
  onRemove,
  onRename,
  onResetScope,
  onSaveScope,
  onSync,
}: SyncPeerCardProps) {
  const peerId = String(peer.peer_device_id || '');
  const displayName = peer.name || (peerId ? peerId.slice(0, 8) : 'unknown');
  const destructiveLabel = peer.name || peerId || displayName;
  const pendingScopeReview = isPeerScopeReviewPending(peerId);
  const trustSummary = derivePeerTrustSummary(peer);
  const peerStatus: SyncPeerStatus = peer.status || {};
  const scope = peer.project_scope || {};
  const includeList = listText(scope.include);
  const excludeList = listText(scope.exclude);
  const effectiveInclude = listText(scope.effective_include);
  const effectiveExclude = listText(scope.effective_exclude);
  const inheritsGlobal = Boolean(scope.inherits_global);
  const primaryAddress = pickPrimaryAddress(peer.addresses);
  const peerAddresses = Array.isArray(peer.addresses)
    ? Array.from(new Set(peer.addresses.filter(Boolean).map((value) => String(value))))
    : [];
  const addressLine = peerAddresses.length
    ? peerAddresses.map((address) => (isSyncRedactionEnabled() ? redactAddress(address) : address)).join(' · ')
    : 'No addresses';
  const lastSyncAt = String(peerStatus.last_sync_at || peerStatus.last_sync_at_utc || '');
  const lastPingAt = String(peerStatus.last_ping_at || peerStatus.last_ping_at_utc || '');
  const scopeEditorOpen = openPeerScopeEditors.has(peerId);
  const scopeReviewRequested = consumePeerScopeReviewRequest(peerId);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [scopeHost, setScopeHost] = useState<HTMLDivElement | null>(null);

  const [renameValue, setRenameValue] = useState(displayName);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameLabel, setRenameLabel] = useState('Save name');
  const [syncBusy, setSyncBusy] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeLabel, setRemoveLabel] = useState('Remove peer');
  const [selectedActorId, setSelectedActorId] = useState(String(peer.actor_id || ''));
  const [applyActorBusy, setApplyActorBusy] = useState(false);
  const [applyActorLabel, setApplyActorLabel] = useState('Save person');
  const [saveScopeBusy, setSaveScopeBusy] = useState(false);
  const [saveScopeLabel, setSaveScopeLabel] = useState('Save scope');
  const [resetScopeBusy, setResetScopeBusy] = useState(false);
  const [resetScopeLabel, setResetScopeLabel] = useState('Reset to global scope');

  const includeEditor = useMemo(
    () => createChipEditor(includeList, 'Add included project', 'All projects'),
    [peerId, includeList.join('|')],
  );
  const excludeEditor = useMemo(
    () => createChipEditor(excludeList, 'Add excluded project', 'No exclusions'),
    [peerId, excludeList.join('|')],
  );

  useEffect(() => {
    setRenameValue(displayName);
    setRenameBusy(false);
    setRenameLabel('Save name');
    setSyncBusy(false);
    setRemoveBusy(false);
    setRemoveLabel('Remove peer');
    setSelectedActorId(String(peer.actor_id || ''));
    setApplyActorBusy(false);
    setApplyActorLabel('Save person');
    setSaveScopeBusy(false);
    setSaveScopeLabel('Save scope');
    setResetScopeBusy(false);
    setResetScopeLabel('Reset to global scope');
  }, [displayName, peer.actor_id, peerId, includeList.join('|'), excludeList.join('|')]);

  useEffect(() => {
    if (!scopeReviewRequested || !cardRef.current) return;
    queueMicrotask(() => cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [scopeReviewRequested]);

  async function rename() {
    if (!peerId) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      showGlobalNotice('Enter a friendly name for this device.', 'warning');
      const input = document.querySelector(`[data-device-name-input="${CSS.escape(peerId)}"]`) as
        | HTMLInputElement
        | null;
      input?.focus();
      return;
    }
    setRenameBusy(true);
    setRenameLabel('Saving…');
    let ok = false;
    try {
      await onRename(peerId, nextName);
      ok = true;
    } catch {
      setRenameLabel('Retry save');
    } finally {
      setRenameBusy(false);
      if (ok) setRenameLabel('Save name');
    }
  }

  async function sync() {
    if (!primaryAddress) return;
    if (pendingScopeReview) {
      const proceed = window.confirm(
        `Sync scope review is still pending for ${displayName}. Continue with a manual sync anyway?`,
      );
      if (!proceed) return;
    }
    setSyncBusy(true);
    try {
      await onSync(peer, primaryAddress);
    } finally {
      setSyncBusy(false);
    }
  }

  async function remove() {
    if (!peerId) return;
    if (!window.confirm(`Remove peer ${destructiveLabel}? This deletes the local sync peer entry.`)) return;
    setRemoveBusy(true);
    setRemoveLabel('Removing…');
    let ok = false;
    try {
      await onRemove(peerId, destructiveLabel);
      ok = true;
    } catch {
      setRemoveLabel('Retry remove');
    } finally {
      setRemoveBusy(false);
      if (ok) setRemoveLabel('Remove peer');
    }
  }

  async function savePerson() {
    if (!peerId) return;
    setApplyActorBusy(true);
    setApplyActorLabel('Applying…');
    let ok = false;
    try {
      await onAssignActor(peerId, selectedActorId || null);
      ok = true;
    } catch {
      setApplyActorLabel('Retry');
    } finally {
      setApplyActorBusy(false);
      if (ok) setApplyActorLabel('Save person');
    }
  }

  async function saveScope() {
    if (!peerId) return;
    setSaveScopeBusy(true);
    setSaveScopeLabel('Saving…');
    let ok = false;
    try {
      await onSaveScope(peerId, includeEditor.values(), excludeEditor.values());
      ok = true;
    } catch {
      setSaveScopeLabel('Retry save');
    } finally {
      setSaveScopeBusy(false);
      if (ok) setSaveScopeLabel('Save scope');
    }
  }

  async function resetScope() {
    if (!peerId) return;
    setResetScopeBusy(true);
    setResetScopeLabel('Resetting…');
    let ok = false;
    try {
      await onResetScope(peerId);
      ok = true;
    } catch {
      setResetScopeLabel('Retry reset');
    } finally {
      setResetScopeBusy(false);
      if (ok) setResetScopeLabel('Reset to global scope');
    }
  }

  return (
    <div ref={cardRef} className="peer-card" data-peer-device-id={peerId || undefined}>
      <div className="peer-title">
        <strong title={peerId || undefined}>
          {displayName}{' '}
          <span className={`badge ${trustSummary.isWarning ? 'badge-offline' : 'badge-online'}`}>
            {trustSummary.badgeLabel}
          </span>
          {pendingScopeReview ? <span className="badge actor-badge">Needs scope review</span> : null}
        </strong>

        <div className="peer-actions">
          <input
            aria-label={`Friendly name for ${displayName}`}
            className="peer-scope-input"
            data-device-name-input={peerId || undefined}
            disabled={renameBusy}
            placeholder="Friendly device name"
            value={renameValue}
            onInput={(event: TargetedInputEvent<HTMLInputElement>) =>
              setRenameValue(event.currentTarget.value)
            }
          />
          <button disabled={renameBusy} onClick={() => void rename()}>
            {renameLabel}
          </button>
          <button disabled={!primaryAddress || syncBusy} onClick={() => void sync()}>
            {syncBusy ? 'Syncing…' : 'Sync now'}
          </button>
          <button disabled={removeBusy} onClick={() => void remove()}>
            {removeLabel}
          </button>
          <PeerScopeCollapsible
            contentHost={scopeHost}
            initialOpen={scopeEditorOpen}
            onOpenChange={(open) => {
              if (open) openPeerScopeEditors.add(peerId);
              else openPeerScopeEditors.delete(peerId);
            }}
          >
            <div>
              <div className="peer-scope-row">
                <ExistingElementSlot element={includeEditor.element} />
                <ExistingElementSlot element={excludeEditor.element} />
              </div>
              <div className="peer-scope-actions">
                <button
                  type="button"
                  className="settings-button"
                  disabled={saveScopeBusy}
                  onClick={() => void saveScope()}
                >
                  {saveScopeLabel}
                </button>
                <button
                  type="button"
                  className="settings-button"
                  disabled={resetScopeBusy}
                  onClick={() => void resetScope()}
                >
                  {resetScopeLabel}
                </button>
              </div>
            </div>
          </PeerScopeCollapsible>
        </div>
      </div>

      <div className="peer-addresses">{addressLine}</div>
      <div className="peer-meta">
        {[lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : 'Sync: never', lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : 'Ping: never'].join(' · ')}
      </div>

      <div className="peer-scope">
        {scopeReviewRequested ? (
          <div className="peer-meta">
            Review this device&apos;s sync scope now. Global defaults apply until you save an override here.
          </div>
        ) : pendingScopeReview ? (
          <div className="peer-meta">
            Scope review still pending. Save an override here or reset to global scope when you are done reviewing. Manual syncs can proceed, but they will use the current effective scope until you change it.
          </div>
        ) : null}

        <div className="peer-scope-summary">Assigned person</div>
        <div className="peer-meta">
          {peer.actor_display_name
            ? `Assigned to ${String(peer.actor_display_name)}${peer.claimed_local_actor ? ' · you' : ''}`
            : 'Unassigned person'}
        </div>
        <div className="peer-meta">{trustSummary.description}</div>
        <div className="peer-actor-row">
          <div className="sync-radix-select-host sync-actor-select-host">
            <RadixSelect
              ariaLabel={`Assigned person for ${displayName}`}
              contentClassName="sync-radix-select-content sync-actor-select-content"
              disabled={applyActorBusy}
              itemClassName="sync-radix-select-item"
              onValueChange={setSelectedActorId}
              options={actorOptions()}
              triggerClassName="sync-radix-select-trigger sync-actor-select"
              value={selectedActorId}
              viewportClassName="sync-radix-select-viewport"
            />
          </div>
          <button className="settings-button" disabled={applyActorBusy} onClick={() => void savePerson()}>
            {applyActorLabel}
          </button>
        </div>
        <div className="peer-scope-effective">{assignmentNote(selectedActorId)}</div>
        <div className="peer-scope-summary">
          {inheritsGlobal
            ? 'Using global sync scope'
            : `Device override · include: ${includeList.join(', ') || 'all'} · exclude: ${excludeList.join(', ') || 'none'}`}
        </div>
        <div className="peer-scope-effective">
          {`Effective scope · ${summaryText('include', effectiveInclude, 'all')} · ${summaryText('exclude', effectiveExclude, 'none')}`}
        </div>
        <div ref={setScopeHost} />
      </div>
    </div>
  );
}

function SyncPeersList(props: SyncPeersListProps) {
  if (!props.peers.length) {
    return (
      <div className="sync-empty-state">
        No devices connected on this machine yet. Use the pairing command in Diagnostics to connect another device.
      </div>
    );
  }

  return (
    <>
      {props.peers.map((peer) => {
        const peerId = String(peer.peer_device_id || peer.name || 'unknown-peer');
        return <SyncPeerCard key={peerId} peer={peer} {...props} />;
      })}
    </>
  );
}

export function renderSyncPeersList(mount: HTMLElement, props: SyncPeersListProps) {
  renderIntoSyncMount(mount, <SyncPeersList {...props} />);
}
