/* Team sync card — coordinator onboarding, invites, join requests. */

import { h } from 'preact';
import { state, setFeedScopeFilter, isSyncRedactionEnabled } from '../../lib/state';
import * as api from '../../lib/api';
import { showGlobalNotice } from '../../lib/notice';
import { markFieldError, clearFieldError, friendlyError } from '../../lib/form';
import {
  adminSetupExpanded,
  setAdminSetupExpanded,
  teamInvitePanelOpen,
  setTeamInvitePanelOpen,
  hideSkeleton,
  isPeerScopeReviewPending,
  redactAddress,
  requestPeerScopeReview,
  clearDuplicatePersonDecision,
  saveDuplicatePersonDecision,
} from './helpers';
import { clearSyncMount, renderIntoSyncMount } from './components/render-root';
import { renderTeamSetupDisclosure } from './components/sync-disclosure';
import { SyncInviteJoinPanels } from './components/sync-invite-join-panels';
import { SyncSharingReview, type SyncSharingReviewItem } from './components/sync-sharing-review';
import {
  TeamSyncPanel,
  type TeamSyncDiscoveredRow,
  type TeamSyncPendingJoinRequest,
  type TeamSyncStatusSummary,
} from './components/team-sync-panel';
import { openDuplicatePersonDialog, openSyncConfirmDialog, openSyncInputDialog } from './sync-dialogs';
import {
  deriveCoordinatorApprovalSummary,
  resolveFriendlyDeviceName,
  SYNC_TERMINOLOGY,
  summarizeSyncRunResult,
} from './view-model';
import { RadixSelect, type RadixSelectOption } from '../../components/primitives/radix-select';

const TEAM_SYNC_ACTIONS_MOUNT_ID = 'syncTeamActionsMount';
const INVITE_POLICY_OPTIONS: RadixSelectOption[] = [
  { value: 'auto_admit', label: 'Auto-admit' },
  { value: 'approval_required', label: 'Approval required' },
];

let invitePolicyValue: 'auto_admit' | 'approval_required' = 'auto_admit';

function renderAdminSetupDisclosure() {
  const mount = document.getElementById('syncAdminDisclosureMount') as HTMLElement | null;
  if (!mount) return;
  renderTeamSetupDisclosure(mount, {
    open: adminSetupExpanded,
    onOpenChange: (open) => {
      setAdminSetupExpanded(open);
      renderAdminSetupDisclosure();
      renderInvitePolicySelect();
      setInviteOutputVisibility();
    },
  });
}

/* ── DOM placement helpers ───────────────────────────────── */

function ensureInvitePanelInAdminSection() {
  // Team setup disclosure now renders in-place through Radix collapsible.
}

function ensureJoinPanelInSetupSection() {
  const joinPanel = document.getElementById('syncJoinPanel');
  const joinSection = document.getElementById('syncJoinSection');
  if (!joinPanel || !joinSection) return;
  if (joinPanel.parentElement !== joinSection) joinSection.appendChild(joinPanel);
}

function setInviteOutputVisibility() {
  const syncInviteOutput = document.getElementById('syncInviteOutput') as HTMLTextAreaElement | null;
  if (!syncInviteOutput) return;
  const encoded = String(state.lastTeamInvite?.encoded || '').trim();
  syncInviteOutput.value = encoded;
  syncInviteOutput.hidden = !encoded;
}

function clearContent(node: HTMLElement | null) {
  if (node) node.textContent = '';
}

function renderInvitePolicySelect() {
  const mount = document.getElementById('syncInvitePolicyMount') as HTMLElement | null;
  if (!mount) return;
  renderIntoSyncMount(
    mount,
    h(RadixSelect, {
      ariaLabel: 'Join policy',
      contentClassName: 'sync-radix-select-content sync-actor-select-content',
      id: 'syncInvitePolicy',
      itemClassName: 'sync-radix-select-item',
      onValueChange: (value) => {
        const nextValue = value === 'approval_required' ? 'approval_required' : 'auto_admit';
        if (nextValue === invitePolicyValue) return;
        invitePolicyValue = nextValue;
        renderInvitePolicySelect();
      },
      options: INVITE_POLICY_OPTIONS,
      triggerClassName: 'sync-radix-select-trigger sync-actor-select',
      value: invitePolicyValue,
      viewportClassName: 'sync-radix-select-viewport',
    }),
  );
}

function teardownTeamSyncRender(actions: HTMLElement | null, targets: Array<HTMLElement | null>) {
  const mount = document.getElementById(TEAM_SYNC_ACTIONS_MOUNT_ID) as HTMLElement | null;
  if (mount) {
    clearSyncMount(mount);
    mount.remove();
  }
  clearContent(actions);
  targets.forEach((target) => clearContent(target));
}

/* ── Sharing review renderer ─────────────────────────────── */

function openFeedSharingReview() {
  setFeedScopeFilter('mine');
  state.feedQuery = '';
  window.location.hash = 'feed';
}

export function renderSyncSharingReview() {
  const panel = document.getElementById('syncSharingReview');
  const meta = document.getElementById('syncSharingReviewMeta');
  const list = document.getElementById('syncSharingReviewList') as HTMLElement | null;
  if (!panel || !meta || !list) return;
  const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
  if (!items.length) {
    clearSyncMount(list);
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const scopeLabel = state.currentProject
    ? `current project (${state.currentProject})`
    : 'all allowed projects';
  meta.textContent = `Teammates receive memories from ${scopeLabel} by default. Use Only me on a memory when it should stay local.`;
  const reviewItems: SyncSharingReviewItem[] = items.map((item) => ({
    actorDisplayName: String(item.actor_display_name || item.actor_id || 'unknown'),
    actorId: String(item.actor_id || 'unknown'),
    peerName: String(item.peer_name || item.peer_device_id || 'Device'),
    privateCount: Number(item.private_count || 0),
    scopeLabel: String(item.scope_label || 'All allowed projects'),
    shareableCount: Number(item.shareable_count || 0),
  }));
  renderIntoSyncMount(list, h(SyncSharingReview, { items: reviewItems, onReview: openFeedSharingReview }));
}

/* ── Team sync renderer ──────────────────────────────────── */

// loadSyncData is set by the index module after both are loaded.
let _loadSyncData: () => Promise<void> = async () => {};
export function setLoadSyncData(fn: () => Promise<void>) {
  _loadSyncData = fn;
}

export function renderTeamSync() {
  const meta = document.getElementById('syncTeamMeta');
  const setupPanel = document.getElementById('syncSetupPanel');
  const list = document.getElementById('syncTeamStatus');
  const actions = document.getElementById('syncTeamActions');
  if (!meta || !setupPanel || !list || !actions) return;

  renderAdminSetupDisclosure();
  renderInvitePolicySelect();
  setInviteOutputVisibility();

  const invitePanel = document.getElementById('syncInvitePanel');
  const inviteRestoreParent = document.getElementById('syncAdminSection');
  const joinPanel = document.getElementById('syncJoinPanel');
  const joinRestoreParent = document.getElementById('syncJoinSection');
  const joinRequests = document.getElementById('syncJoinRequests');
  const discoveredPanel = document.getElementById('syncCoordinatorDiscovered');
  const discoveredMeta = document.getElementById('syncCoordinatorDiscoveredMeta');
  const discoveredList = document.getElementById('syncCoordinatorDiscoveredList');

  hideSkeleton('syncTeamSkeleton');
  ensureInvitePanelInAdminSection();
  ensureJoinPanelInSetupSection();

  const coordinator = state.lastSyncCoordinator;
  const syncView = state.lastSyncViewModel || {
    summary: { connectedDeviceCount: 0, seenOnTeamCount: 0, offlineTeamDeviceCount: 0 },
    duplicatePeople: [],
    attentionItems: [],
  };

  const focusAttentionTarget = (item: { kind?: string; deviceId?: string }) => {
    if (item.kind === 'possible-duplicate-person') {
      const actorList = document.getElementById('syncActorsList');
      if (actorList instanceof HTMLElement) {
        actorList.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }
    const deviceId = String(item.deviceId || '').trim();
    if (!deviceId) return;
    if (item.kind === 'name-device') {
      const renameInput = document.querySelector(`[data-device-name-input="${CSS.escape(deviceId)}"]`);
      if (renameInput instanceof HTMLInputElement) {
        renameInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
        renameInput.focus();
        renameInput.select();
        return;
      }
    }
    const peerCard = document.querySelector(`[data-peer-device-id="${CSS.escape(deviceId)}"]`);
    if (peerCard instanceof HTMLElement) {
      peerCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const discoveredRow = document.querySelector(`[data-discovered-device-id="${CSS.escape(deviceId)}"]`);
    if (discoveredRow instanceof HTMLElement) {
      discoveredRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  const reviewDuplicatePeople = async (item: { actorIds?: unknown[]; title: string }) => {
    const actorIds = Array.isArray(item.actorIds)
      ? item.actorIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
      : [];
    const actors = (Array.isArray(state.lastSyncActors) ? state.lastSyncActors : []).filter((actor) =>
      actorIds.includes(String(actor?.actor_id || '').trim()),
    );
    if (actors.length < 2) {
      showGlobalNotice('This possible duplicate no longer has enough people to review.', 'warning');
      return;
    }
    const result = await openDuplicatePersonDialog({
      title: 'Review possible duplicate people',
      summary: item.title.replace(/^Possible duplicate person:\s*/, ''),
      actors: actors.map((actor) => ({
        actorId: String(actor?.actor_id || ''),
        label: String(actor?.display_name || actor?.actor_id || 'Unknown person'),
        isLocal: Boolean(actor?.is_local),
      })),
    });
    if (result.action === 'different-people') {
      saveDuplicatePersonDecision(actorIds, 'different-people');
      showGlobalNotice('Okay. I will keep these people separate on this device.');
      await _loadSyncData();
      return;
    }
    if (result.action !== 'merge') return;
    const primary = actors.find((actor) => String(actor?.actor_id || '') === result.primaryActorId);
    const secondary = actors.find((actor) => String(actor?.actor_id || '') === result.secondaryActorId);
    if (!primary?.actor_id || !secondary?.actor_id) {
      showGlobalNotice('Could not determine which people to combine.', 'warning');
      return;
    }
    try {
      await api.mergeActor(String(primary.actor_id), String(secondary.actor_id));
      clearDuplicatePersonDecision(actorIds);
      showGlobalNotice(`Combined duplicate people into ${String(primary.display_name || primary.actor_id)}.`);
      await _loadSyncData();
    } catch (error) {
      try {
        await _loadSyncData();
      } catch {}
      showGlobalNotice(friendlyError(error, 'Failed to combine these people.'), 'warning');
    }
  };

  const reviewDiscoveredDeviceName = async (suggestedName: string) => {
    return await openSyncInputDialog({
      title: 'Review device',
      description: 'Choose a friendly name for this device before connecting it on this machine.',
      initialValue: suggestedName,
      placeholder: 'Desk Mini',
      confirmLabel: 'Connect device',
      cancelLabel: 'Cancel',
      validate: (nextValue) => (nextValue.trim() ? null : 'Enter a device name to connect this device.'),
    });
  };

  const configured = Boolean(coordinator && coordinator.configured);
  meta.textContent = configured
    ? `Coordinator: ${String(coordinator.coordinator_url || '')} · group: ${(coordinator.groups || []).join(', ') || 'none'}`
    : 'Join an existing team or create one before connecting devices and people.';

  if (!configured) {
    teardownTeamSyncRender(actions, [list, joinRequests, discoveredList]);
    setupPanel.hidden = false;
    list.hidden = true;
    actions.hidden = true;
    if (joinRequests) joinRequests.hidden = true;
    if (discoveredPanel) discoveredPanel.hidden = true;
    return;
  }

  setupPanel.hidden = true;
  list.hidden = false;
  actions.hidden = false;

  const presenceStatus = String(coordinator.presence_status || '');
  const presenceLabel =
    presenceStatus === 'posted'
      ? 'Connected'
      : presenceStatus === 'not_enrolled'
        ? 'Needs enrollment'
        : 'Connection error';
  const localPeers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
  const attentionItems = Array.isArray(syncView.attentionItems) ? syncView.attentionItems : [];
  const connectedCount = Number(syncView.summary?.connectedDeviceCount || 0);
  const seenOnTeamCount = Number(syncView.summary?.seenOnTeamCount || 0);
  const offlineTeamDeviceCount = Number(syncView.summary?.offlineTeamDeviceCount || 0);
  const metricParts = [`Connected ${connectedCount}`, `Team ${seenOnTeamCount}`];
  if (offlineTeamDeviceCount > 0) {
    metricParts.push(`Offline ${offlineTeamDeviceCount}`);
  }
  const statusSummary: TeamSyncStatusSummary = {
    badgeClassName: `pill ${presenceStatus === 'posted' ? 'pill-success' : presenceStatus === 'not_enrolled' ? 'pill-warning' : 'pill-error'}`,
    headline:
      presenceStatus === 'posted'
        ? attentionItems.length > 0
          ? `${attentionItems.length} item${attentionItems.length === 1 ? '' : 's'} need review`
          : 'Everything important looks healthy'
        : presenceStatus === 'not_enrolled'
          ? 'This device is not enrolled in the team yet'
          : 'Sync needs attention',
    metricsText: metricParts.join(' · '),
    presenceLabel,
  };

  const discoveredDevices = Array.isArray(coordinator.discovered_devices)
    ? coordinator.discovered_devices
    : [];
  const discoveredRows: TeamSyncDiscoveredRow[] = discoveredDevices.map((device) => {
    const deviceId = String(device.device_id || '').trim();
    const rawCoordinatorName = String(device.display_name || '').trim();
    const displayName =
      resolveFriendlyDeviceName({ coordinatorName: rawCoordinatorName, deviceId }) ||
      'Discovered device';
    const displayTitle = deviceId && displayName !== deviceId ? deviceId : null;
    const fingerprint = String(device.fingerprint || '').trim();
    const groupIds = Array.isArray(device.groups)
      ? device.groups.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const hasAmbiguousCoordinatorGroup = groupIds.length > 1;
    const pairedPeer = localPeers.find((peer) => String(peer?.peer_device_id || '') === deviceId);
    const approvalSummary = deriveCoordinatorApprovalSummary({
      device,
      pairedLocally: Boolean(pairedPeer),
    });
    const pairedFingerprint = String(pairedPeer?.fingerprint || '').trim();
    const hasConflict =
      Boolean(pairedPeer) &&
      Boolean(fingerprint) &&
      Boolean(pairedFingerprint) &&
      pairedFingerprint !== fingerprint;
    const canAccept =
      Boolean(deviceId) &&
      Boolean(fingerprint) &&
      !pairedPeer &&
      !device.stale &&
      !hasAmbiguousCoordinatorGroup;
    const addresses = Array.isArray(device.addresses) ? device.addresses : [];
    const addressLabel = addresses.length
      ? addresses
          .map((address) =>
            isSyncRedactionEnabled() ? redactAddress(String(address || '')) : String(address || ''),
          )
          .filter(Boolean)
          .join(' · ')
      : 'No fresh addresses';
    const noteParts = [addressLabel];
    if (displayTitle && !addresses.length) noteParts.push(`device id: ${deviceId}`);
    let actionMessage: string | null = null;
    let mode: TeamSyncDiscoveredRow['mode'] = canAccept ? 'accept' : 'none';
    let pairedMessage: string | null = null;

    if (hasConflict) {
      mode = 'conflict';
    } else if (hasAmbiguousCoordinatorGroup) {
      actionMessage =
        'This device is visible through multiple coordinator groups. Fix that team setup first, then approve it here.';
      mode = 'ambiguous';
    } else if (pairedPeer && isPeerScopeReviewPending(deviceId)) {
      actionMessage = `Review this device's scope in People & devices next.`;
      mode = 'scope-pending';
    } else if (pairedPeer?.last_error) {
      noteParts.push(`error: ${String(pairedPeer.last_error)}`);
      mode = 'paired';
    } else if (pairedPeer?.status?.peer_state) {
      noteParts.push(`status: ${String(pairedPeer.status.peer_state)}`);
      mode = 'paired';
    } else if (!pairedPeer && device.stale) {
      actionMessage = 'Wait for a fresh coordinator presence update.';
      mode = 'stale';
    } else if (pairedPeer) {
      mode = 'paired';
    }
    if (mode === 'paired') {
      pairedMessage =
        approvalSummary.state === 'waiting-for-other-device'
          ? approvalSummary.description || 'Waiting on the other device.'
          : String(pairedPeer?.last_error || '').toLowerCase().includes('401') &&
              String(pairedPeer?.last_error || '').toLowerCase().includes('unauthorized')
            ? 'Waiting for the other device to trust this one before sync can work.'
            : 'Manage this device in People & devices.';
    }

    return {
      actionMessage,
      actionLabel: approvalSummary.actionLabel || 'Review device',
      approvalBadgeLabel: approvalSummary.badgeLabel,
      availabilityLabel: device.stale ? 'Offline' : 'Available',
      connectionLabel: hasConflict
        ? SYNC_TERMINOLOGY.conflicts
        : pairedPeer
          ? SYNC_TERMINOLOGY.pairedLocally
          : 'Not connected on this device',
      deviceId,
      displayName,
      displayTitle,
      fingerprint,
      mode,
      note: noteParts.join(' · '),
      pairedMessage,
    };
  });

  const pending = Array.isArray(state.lastSyncJoinRequests) ? state.lastSyncJoinRequests : [];
  const pendingJoinRequests: TeamSyncPendingJoinRequest[] = pending.map((request) => ({
    displayName: String(request.display_name || request.device_id || 'Pending device'),
    requestId: String(request.request_id || ''),
  }));

  if (discoveredPanel) discoveredPanel.hidden = discoveredRows.length === 0;
  if (discoveredMeta) {
    discoveredMeta.textContent = discoveredRows.length
      ? 'Visible through team discovery. Review before connecting them on this machine.'
      : '';
  }
  if (joinRequests) joinRequests.hidden = pendingJoinRequests.length === 0;

  teardownTeamSyncRender(actions, [list, joinRequests, discoveredList]);
  const actionMount = document.createElement('div');
  actionMount.id = TEAM_SYNC_ACTIONS_MOUNT_ID;
  actions.appendChild(actionMount);

  renderIntoSyncMount(
    actionMount,
    h(TeamSyncPanel, {
      actionItems: attentionItems,
      children: h(SyncInviteJoinPanels, {
        invitePanel,
        invitePanelOpen: teamInvitePanelOpen,
        inviteRestoreParent,
        joinPanel,
        joinRestoreParent,
        onToggleInvitePanel: () => {
          if (!invitePanel) return;
          setTeamInvitePanelOpen(!teamInvitePanelOpen);
          renderTeamSync();
        },
        pairedPeerCount: Number(coordinator.paired_peer_count || 0),
        presenceStatus,
      }),
      discoveredListMount: discoveredList,
      discoveredRows,
      joinRequestsMount: joinRequests,
      listMount: list,
      onApproveJoinRequest: async (request) => {
        try {
          await api.reviewJoinRequest(request.requestId, 'approve');
          showGlobalNotice(`Approved ${request.displayName}. They can now sync with the team.`);
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, 'Failed to approve join request.'), 'warning');
          throw error;
        }
      },
      onAttentionAction: async (item) => {
        if (item.kind === 'possible-duplicate-person') {
          await reviewDuplicatePeople(item);
          return;
        }
        focusAttentionTarget(item);
      },
      onDenyJoinRequest: async (request) => {
        const confirmed = await openSyncConfirmDialog({
          title: `Deny join request from ${request.displayName}?`,
          description: 'They will need a new invite to try joining this team again.',
          confirmLabel: 'Deny request',
          cancelLabel: 'Keep request pending',
          tone: 'danger',
        });
        if (!confirmed) return;
        try {
          await api.reviewJoinRequest(request.requestId, 'deny');
          showGlobalNotice(`Denied join request from ${request.displayName}.`);
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, 'Failed to deny join request.'), 'warning');
          throw error;
        }
      },
      onInspectConflict: (row) => {
        const peerCard = document.querySelector(`[data-peer-device-id="${CSS.escape(row.deviceId)}"]`);
        if (peerCard instanceof HTMLElement) {
          peerCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
          showGlobalNotice(`Opened the conflicting local device record for ${row.displayName}.`, 'warning');
          return;
        }
        showGlobalNotice(
          'The conflicting local device record is not visible yet. Scroll to People & devices and try again.',
          'warning',
        );
      },
      onRemoveConflict: async (row) => {
        const confirmed = await openSyncConfirmDialog({
          title: `Remove ${row.displayName}?`,
          description: 'This deletes the broken local device record. You can review this device again after the screen refreshes.',
          confirmLabel: 'Remove device record',
          cancelLabel: 'Keep device record',
          tone: 'danger',
        });
        if (!confirmed) return;
        try {
          await api.deletePeer(row.deviceId);
          showGlobalNotice(
            `Removed the broken local device record for ${row.displayName}. If it is still available, you can review it again from Needs attention.`,
          );
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, 'Failed to remove the broken local device record.'), 'warning');
          throw error;
        }
      },
      onReviewDiscoveredDevice: async (row) => {
        try {
          const reviewedName = await reviewDiscoveredDeviceName(row.displayName);
          if (!reviewedName) return;
          const result = await api.acceptDiscoveredPeer(row.deviceId, row.fingerprint);
          const optimisticName = String(result?.name || row.displayName || '').trim() || row.displayName;
          const pendingPeers = Array.isArray(state.pendingAcceptedSyncPeers)
            ? state.pendingAcceptedSyncPeers.filter(
                (peer) => String(peer?.peer_device_id || '').trim() !== row.deviceId,
              )
            : [];
          state.pendingAcceptedSyncPeers = [
            ...pendingPeers,
            {
              peer_device_id: row.deviceId,
              name: optimisticName,
              fingerprint: row.fingerprint,
              addresses: [],
              claimed_local_actor: false,
              status: { peer_state: 'degraded' },
              last_error: 'Waiting for the other device to approve this one.',
            },
          ];
          requestPeerScopeReview(row.deviceId);
          showGlobalNotice(
            row.approvalBadgeLabel === 'Needs your approval'
              ? `Approved ${row.displayName} on this device. Two-way trust should be ready once both devices refresh.`
              : `Step 1 complete on this device for ${row.displayName}. Finish onboarding on the other device so both sides trust each other for sync.`,
          );
          try {
            if (reviewedName.trim() !== optimisticName.trim()) {
              await api.renamePeer(row.deviceId, reviewedName.trim());
              showGlobalNotice(`Saved device name: ${reviewedName.trim()}.`);
            }
          } catch (error) {
            showGlobalNotice(friendlyError(error, 'Device connected, but naming did not finish.'), 'warning');
          }
          try {
            await _loadSyncData();
          } catch (error) {
            showGlobalNotice(
              friendlyError(error, 'Device connected, but the screen did not refresh yet.'),
              'warning',
            );
          }
        } catch (error) {
          showGlobalNotice(friendlyError(error, 'Failed to review this device.'), 'warning');
          throw error;
        }
      },
      pendingJoinRequests,
      presenceStatus,
      statusSummary,
    }),
  );
}

/* ── Event wiring ────────────────────────────────────────── */

export function initTeamSyncEvents(
  refreshCallback: () => void,
  loadSyncData: () => Promise<void>,
) {
  renderAdminSetupDisclosure();
  renderInvitePolicySelect();

  const syncNowButton = document.getElementById('syncNowButton') as HTMLButtonElement | null;
  const syncCreateInviteButton = document.getElementById(
    'syncCreateInviteButton',
  ) as HTMLButtonElement | null;
  const syncInviteGroup = document.getElementById('syncInviteGroup') as HTMLInputElement | null;
  const syncInviteTtl = document.getElementById('syncInviteTtl') as HTMLInputElement | null;
  const syncInviteOutput = document.getElementById(
    'syncInviteOutput',
  ) as HTMLTextAreaElement | null;
  const syncJoinButton = document.getElementById('syncJoinButton') as HTMLButtonElement | null;
  const syncJoinInvite = document.getElementById('syncJoinInvite') as HTMLTextAreaElement | null;

  syncCreateInviteButton?.addEventListener('click', async () => {
    if (
      !syncCreateInviteButton ||
      !syncInviteGroup ||
      !syncInviteTtl ||
      !syncInviteOutput
    )
      return;
    const groupName = syncInviteGroup.value.trim();
    const ttlValue = Number(syncInviteTtl.value);
    let valid = true;
    if (!groupName) {
      valid = markFieldError(syncInviteGroup, 'Team name is required.');
    } else {
      clearFieldError(syncInviteGroup);
    }
    if (!ttlValue || ttlValue < 1) {
      valid = markFieldError(syncInviteTtl, 'Must be at least 1 hour.');
    } else {
      clearFieldError(syncInviteTtl);
    }
    if (!valid) return;
    syncCreateInviteButton.disabled = true;
    syncCreateInviteButton.textContent = 'Creating\u2026';
    try {
      const result = await api.createCoordinatorInvite({
        group_id: groupName,
        policy: invitePolicyValue,
        ttl_hours: ttlValue || 24,
      });
      state.lastTeamInvite = result;
      syncInviteOutput.value = String(result.encoded || '');
      syncInviteOutput.hidden = false;
      syncInviteOutput.focus();
      syncInviteOutput.select();
      showGlobalNotice('Invite created. Copy the text above and share it with your teammate.');
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      warnings.forEach((warning) => showGlobalNotice(String(warning), 'warning'));
    } catch (error) {
      showGlobalNotice(friendlyError(error, 'Failed to create invite.'), 'warning');
    } finally {
      syncCreateInviteButton.disabled = false;
      syncCreateInviteButton.textContent = 'Create invite';
    }
  });

  syncJoinButton?.addEventListener('click', async () => {
    if (!syncJoinButton || !syncJoinInvite) return;
    const inviteValue = syncJoinInvite.value.trim();
    if (!inviteValue) {
      markFieldError(syncJoinInvite, 'Paste a team invite to join.');
      return;
    }
    clearFieldError(syncJoinInvite);
    syncJoinButton.disabled = true;
    syncJoinButton.textContent = 'Joining\u2026';
    try {
      const result = await api.importCoordinatorInvite(inviteValue);
      state.lastTeamJoin = result;
      showGlobalNotice(
        result.status === 'pending'
          ? 'Join request submitted \u2014 waiting for admin approval.'
          : 'Joined team successfully.',
      );
      syncJoinInvite.value = '';
      await loadSyncData();
    } catch (error) {
      showGlobalNotice(friendlyError(error, 'Failed to import invite.'), 'warning');
    } finally {
      syncJoinButton.disabled = false;
      syncJoinButton.textContent = 'Join team';
    }
  });

  syncNowButton?.addEventListener('click', async () => {
    if (!syncNowButton) return;
    syncNowButton.disabled = true;
    syncNowButton.textContent = 'Syncing\u2026';
    try {
      const result = await api.triggerSync();
      const summary = summarizeSyncRunResult(result);
      showGlobalNotice(summary.message, summary.warning ? 'warning' : undefined);
    } catch (error) {
      showGlobalNotice(friendlyError(error, 'Failed to start sync.'), 'warning');
    }
    syncNowButton.disabled = false;
    syncNowButton.textContent = 'Sync now';
    refreshCallback();
  });
}
