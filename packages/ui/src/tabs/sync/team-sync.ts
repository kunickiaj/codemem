/* Team sync card — coordinator onboarding, invites, join requests. */

import { el, copyToClipboard } from '../../lib/dom';
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
import { deriveCoordinatorApprovalSummary, SYNC_TERMINOLOGY, summarizeSyncRunResult } from './view-model';

/* ── DOM placement helpers ───────────────────────────────── */

function ensureInvitePanelInAdminSection() {
  const invitePanel = document.getElementById('syncInvitePanel');
  const adminSection = document.getElementById('syncAdminSection');
  if (!invitePanel || !adminSection) return;
  if (invitePanel.parentElement !== adminSection) adminSection.appendChild(invitePanel);
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

/* ── Sharing review renderer ─────────────────────────────── */

function openFeedSharingReview() {
  setFeedScopeFilter('mine');
  state.feedQuery = '';
  window.location.hash = 'feed';
}

export function renderSyncSharingReview() {
  const panel = document.getElementById('syncSharingReview');
  const meta = document.getElementById('syncSharingReviewMeta');
  const list = document.getElementById('syncSharingReviewList');
  if (!panel || !meta || !list) return;
  list.textContent = '';
  const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
  if (!items.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const scopeLabel = state.currentProject
    ? `current project (${state.currentProject})`
    : 'all allowed projects';
  meta.textContent = `Teammates receive memories from ${scopeLabel} by default. Use Only me on a memory when it should stay local.`;
  items.forEach((item) => {
    const row = el('div', 'actor-row');
    const details = el('div', 'actor-details');
    const title = el('div', 'actor-title');
    title.append(
      el('strong', null, String(item.peer_name || item.peer_device_id || 'Device')),
      el(
        'span',
        'badge actor-badge',
        `person: ${String(item.actor_display_name || item.actor_id || 'unknown')}`,
      ),
    );
    const note = el(
      'div',
      'peer-meta',
      `${Number(item.shareable_count || 0)} share by default \u00b7 ${Number(item.private_count || 0)} marked Only me \u00b7 ${String(item.scope_label || 'All allowed projects')}`,
    );
    details.append(title, note);
    const actions = el('div', 'actor-actions');
    const reviewBtn = el('button', 'settings-button', 'Review my memories in Feed') as HTMLButtonElement;
    reviewBtn.addEventListener('click', () => openFeedSharingReview());
    actions.appendChild(reviewBtn);
    row.append(details, actions);
    list.appendChild(row);
  });
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
  const invitePanel = document.getElementById('syncInvitePanel');
  const toggleAdmin = document.getElementById('syncToggleAdmin') as HTMLButtonElement | null;
  const joinPanel = document.getElementById('syncJoinPanel');
  const joinRequests = document.getElementById('syncJoinRequests');
  const discoveredPanel = document.getElementById('syncCoordinatorDiscovered');
  const discoveredMeta = document.getElementById('syncCoordinatorDiscoveredMeta');
  const discoveredList = document.getElementById('syncCoordinatorDiscoveredList');
  if (!meta || !setupPanel || !list || !actions) return;
  hideSkeleton('syncTeamSkeleton');
  // Move panels back to their home sections BEFORE clearing, so they survive the wipe
  ensureInvitePanelInAdminSection();
  ensureJoinPanelInSetupSection();
  list.textContent = '';
  actions.textContent = '';
  if (joinRequests) joinRequests.textContent = '';
  if (discoveredList) discoveredList.textContent = '';
  setInviteOutputVisibility();
  const coordinator = state.lastSyncCoordinator;
  const syncView = state.lastSyncViewModel || { summary: {}, attentionItems: [] };

  const focusAttentionTarget = (item: any) => {
    if (item.kind === 'possible-duplicate-person') {
      const actorList = document.getElementById('syncActorsList');
      if (actorList instanceof HTMLElement) actorList.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  const reviewDuplicatePeople = async (item: any) => {
    const actorIds = Array.isArray(item.actorIds) ? item.actorIds.map((value: unknown) => String(value || '').trim()).filter(Boolean) : [];
    const actors = (Array.isArray(state.lastSyncActors) ? state.lastSyncActors : []).filter((actor) =>
      actorIds.includes(String(actor?.actor_id || '').trim()),
    );
    if (actors.length < 2) {
      showGlobalNotice('This possible duplicate no longer has enough people to review.', 'warning');
      return;
    }
    const firstAnswer = window.prompt(
      `Possible duplicate person: ${item.title.replace(/^Possible duplicate person:\s*/, '')}\n\nChoose an option:\n1 = These are both me\n2 = These are different people\n3 = Decide later`,
      '1',
    );
    const choice = String(firstAnswer || '').trim();
    if (choice === '2') {
      saveDuplicatePersonDecision(actorIds, 'different-people');
      showGlobalNotice('Okay. I will keep these people separate on this device.');
      await _loadSyncData();
      return;
    }
    if (choice !== '1') return;
    clearDuplicatePersonDecision(actorIds);
    const localIndex = actors.findIndex((actor) => Boolean(actor?.is_local));
    const defaultChoice = localIndex >= 0 ? String(localIndex + 1) : '1';
    const options = actors
      .map((actor, index) => `${index + 1} = ${String(actor?.display_name || actor?.actor_id || `Person ${index + 1}`)}${actor?.is_local ? ' (You)' : ''}`)
      .join('\n');
    const keepAnswer = window.prompt(
      `Which person should remain after combining them?\n\n${options}`,
      defaultChoice,
    );
    const keepIndex = Number.parseInt(String(keepAnswer || defaultChoice), 10) - 1;
    const primary = actors[keepIndex] ?? actors[0];
    const secondary = actors.find((actor) => actor !== primary);
    if (!primary?.actor_id || !secondary?.actor_id) {
      showGlobalNotice('Could not determine which people to combine.', 'warning');
      return;
    }
    try {
      await api.mergeActor(String(primary.actor_id), String(secondary.actor_id));
      showGlobalNotice(`Combined duplicate people into ${String(primary.display_name || primary.actor_id)}.`);
      await _loadSyncData();
    } catch (error) {
      showGlobalNotice(friendlyError(error, 'Failed to combine these people.'), 'warning');
    }
  };

  const promptForDeviceName = async (deviceId: string, suggestedName: string) => {
    const nextName = window.prompt(
      'What should this device be called? You can change it later in People & devices.',
      suggestedName,
    );
    const value = String(nextName || '').trim();
    if (!value) {
      showGlobalNotice('You can name this device later from People & devices.', 'warning');
      return false;
    }
    await api.renamePeer(deviceId, value);
    showGlobalNotice(`Saved device name: ${value}.`);
    return true;
  };
  const configured = Boolean(coordinator && coordinator.configured);
  meta.textContent = configured
    ? `Connected to ${String(coordinator.coordinator_url || '')} \u00b7 group: ${(coordinator.groups || []).join(', ') || 'none'}`
    : 'Start here: join an existing team or create a new one before connecting devices and people.';
  if (!configured) {
    setupPanel.hidden = false;
    list.hidden = true;
    actions.hidden = true;
    if (joinRequests) joinRequests.hidden = true;
    if (discoveredPanel) discoveredPanel.hidden = true;
    if (invitePanel) invitePanel.hidden = !adminSetupExpanded;
    if (toggleAdmin) {
      toggleAdmin.textContent = adminSetupExpanded
        ? 'Hide team setup'
        : 'Set up a new team instead\u2026';
    }
    return;
  }
  setupPanel.hidden = true;
  list.hidden = false;
  actions.hidden = false;
  if (joinRequests) joinRequests.hidden = false;
  if (discoveredPanel) discoveredPanel.hidden = true;
  const presenceLabel =
    coordinator.presence_status === 'posted'
      ? 'Connected'
      : coordinator.presence_status === 'not_enrolled'
        ? 'Not connected \u2014 import an invite or ask your admin to enroll this device'
        : 'Connection error';
  const statusRow = el('div', 'sync-team-summary');
  const statusLine = el('div', 'sync-team-status-row');
  const statusLabel = el('span', 'sync-team-status-label', 'Status');
  const statusBadge = el(
    'span',
    `pill ${coordinator.presence_status === 'posted' ? 'pill-success' : coordinator.presence_status === 'not_enrolled' ? 'pill-warning' : 'pill-error'}`,
    presenceLabel,
  );
  const metricParts = [
    `Connected devices: ${Number(syncView.summary?.connectedDeviceCount || 0)}`,
    `Seen on team: ${Number(syncView.summary?.seenOnTeamCount || 0)}`,
  ];
  if (Number(syncView.summary?.offlineTeamDeviceCount || 0) > 0) {
    metricParts.push(`Offline on team: ${Number(syncView.summary?.offlineTeamDeviceCount || 0)}`);
  }
  statusLine.append(statusLabel, statusBadge);
  statusRow.append(statusLine, el('div', 'sync-team-metrics', metricParts.join(' \u00b7 ')));
  list.appendChild(statusRow);

  const localPeers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
  const attentionItems = Array.isArray(syncView.attentionItems) ? syncView.attentionItems : [];
  if (attentionItems.length) {
    const heading = el('div', 'sync-action-text');
    heading.textContent = 'Needs attention';
    actions.appendChild(heading);
    attentionItems.slice(0, 4).forEach((item: any) => {
      const row = el('div', 'sync-action');
      const textWrap = el('div', 'sync-action-text');
      textWrap.textContent = item.title;
      textWrap.appendChild(el('span', 'sync-action-command', item.summary));
      const actionButton = el('button', 'settings-button', item.actionLabel || 'Review') as HTMLButtonElement;
      actionButton.addEventListener('click', async () => {
        if (item.kind === 'possible-duplicate-person') {
          await reviewDuplicatePeople(item);
          return;
        }
        focusAttentionTarget(item);
      });
      row.append(textWrap, actionButton);
      actions.appendChild(row);
    });
  } else if (coordinator.presence_status === 'posted') {
    const row = el('div', 'sync-action');
    const textWrap = el('div', 'sync-action-text');
    textWrap.textContent = 'No immediate issues';
    textWrap.appendChild(
      el('span', 'sync-action-command', 'Your devices and team records do not currently need review.'),
    );
    row.appendChild(textWrap);
    actions.appendChild(row);
  } else if (coordinator.presence_status === 'not_enrolled') {
    const row = el('div', 'sync-action');
    const textWrap = el('div', 'sync-action-text');
    textWrap.textContent = 'This device still needs team enrollment';
    textWrap.appendChild(
      el('span', 'sync-action-command', 'Import an invite or ask your admin to enroll this device before expecting sync activity here.'),
    );
    row.appendChild(textWrap);
    actions.appendChild(row);
  }

  const discoveredDevices = Array.isArray(coordinator.discovered_devices)
    ? coordinator.discovered_devices
    : [];
  if (discoveredPanel && discoveredMeta && discoveredList && discoveredDevices.length) {
    discoveredPanel.hidden = false;
    discoveredMeta.textContent =
      'These devices are visible through team discovery. Review them before connecting them on this machine.';
    discoveredDevices.forEach((device) => {
      const row = el('div', 'actor-row');
      const details = el('div', 'actor-details');
      const title = el('div', 'actor-title');
      const rowActions = el('div', 'actor-actions');
      const deviceId = String(device.device_id || '').trim();
      if (deviceId) row.dataset.discoveredDeviceId = deviceId;
      const displayName = String(device.display_name || '').trim() || deviceId || 'Discovered device';
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
      const hasConflict = Boolean(pairedPeer) && Boolean(fingerprint) && Boolean(pairedFingerprint) && pairedFingerprint !== fingerprint;
      const canAccept =
        Boolean(deviceId) &&
        Boolean(fingerprint) &&
        !pairedPeer &&
        !device.stale &&
        !hasAmbiguousCoordinatorGroup;
      title.append(el('strong', null, displayName));
      title.appendChild(
        el(
          'span',
          `badge actor-badge${device.stale ? '' : ' local'}`,
          device.stale ? 'Offline' : 'Available',
        ),
      );
      title.appendChild(
        el(
          'span',
          'badge actor-badge',
          hasConflict ? SYNC_TERMINOLOGY.conflicts : pairedPeer ? SYNC_TERMINOLOGY.pairedLocally : 'Not connected on this device',
        ),
      );
      if (approvalSummary.badgeLabel) {
        title.appendChild(el('span', 'badge actor-badge', approvalSummary.badgeLabel));
      }
      const addresses = Array.isArray(device.addresses) ? device.addresses : [];
      const addressLabel = addresses.length
        ? addresses
            .map((address) =>
              isSyncRedactionEnabled() ? redactAddress(String(address || '')) : String(address || ''),
            )
            .filter(Boolean)
            .join(' · ')
        : 'No fresh addresses';
      const noteParts = [deviceId, addressLabel];
      if (hasConflict) {
        noteParts.push('repair the local peer before accepting this discovered device');
      } else if (hasAmbiguousCoordinatorGroup) {
        noteParts.push('this device appears in multiple coordinator groups; review team setup before approving it here');
      } else if (pairedPeer && isPeerScopeReviewPending(deviceId)) {
        noteParts.push('scope review pending in People');
      } else if (pairedPeer?.last_error) {
        noteParts.push(`paired error: ${String(pairedPeer.last_error)}`);
      } else if (pairedPeer?.status?.peer_state) {
        noteParts.push(`paired status: ${String(pairedPeer.status.peer_state)}`);
      }
      if (approvalSummary.description) noteParts.push(approvalSummary.description);
      details.append(title, el('div', 'peer-meta', noteParts.join(' · ')));
      if (canAccept) {
        const acceptBtn = el(
          'button',
          'settings-button',
          approvalSummary.actionLabel || 'Review device',
        ) as HTMLButtonElement;
        acceptBtn.addEventListener('click', async () => {
          acceptBtn.disabled = true;
          acceptBtn.textContent = 'Opening…';
          try {
            const result = await api.acceptDiscoveredPeer(deviceId, fingerprint);
            requestPeerScopeReview(deviceId);
            showGlobalNotice(
              approvalSummary.state === 'needs-your-approval'
                ? `Approved ${displayName} on this device. Two-way trust should be ready once both devices refresh.`
                : `Step 1 complete on this device for ${displayName}. Finish onboarding on the other device so both sides trust each other for sync.`,
            );
            try {
              await promptForDeviceName(
                deviceId,
                String(result?.name || displayName || '').trim() || displayName,
              );
            } catch (error) {
              showGlobalNotice(
                friendlyError(error, 'Device connected, but naming did not finish.'),
                'warning',
              );
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
            acceptBtn.textContent = 'Retry review';
          } finally {
            acceptBtn.disabled = false;
            if (acceptBtn.textContent === 'Opening…') {
              acceptBtn.textContent = approvalSummary.actionLabel || 'Review device';
            }
          }
        });
        rowActions.appendChild(acceptBtn);
      } else if (!pairedPeer && device.stale) {
        rowActions.appendChild(el('div', 'peer-meta', 'Wait for a fresh coordinator presence update.'));
      } else if (!pairedPeer && hasAmbiguousCoordinatorGroup) {
        rowActions.appendChild(
          el('div', 'peer-meta', 'This device is visible through multiple coordinator groups. Fix that team setup first, then approve it here.'),
        );
      } else if (hasConflict) {
        const inspectBtn = el('button', 'settings-button', 'Open device details') as HTMLButtonElement;
        inspectBtn.addEventListener('click', () => {
          const peerCard = document.querySelector(`[data-peer-device-id="${CSS.escape(deviceId)}"]`);
          if (peerCard instanceof HTMLElement) {
            peerCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
            showGlobalNotice(`Opened the conflicting local device record for ${displayName}.`, 'warning');
            return;
          }
          showGlobalNotice('The conflicting local device record is not visible yet. Scroll to People & devices and try again.', 'warning');
        });
        const removeConflictBtn = el('button', 'settings-button', 'Remove broken device record') as HTMLButtonElement;
        removeConflictBtn.addEventListener('click', async () => {
          if (!pairedPeer) return;
          const confirmed = window.confirm(
            `Remove the broken local device record for ${displayName}? You can review this device again after the screen refreshes.`,
          );
          if (!confirmed) return;
          removeConflictBtn.disabled = true;
          inspectBtn.disabled = true;
            removeConflictBtn.textContent = 'Removing…';
          try {
            await api.deletePeer(deviceId);
            showGlobalNotice(`Removed the broken local device record for ${displayName}. If it is still available, you can review it again from Needs attention.`);
            await _loadSyncData();
          } catch (error) {
            showGlobalNotice(friendlyError(error, 'Failed to remove the broken local device record.'), 'warning');
            removeConflictBtn.textContent = 'Retry remove';
          } finally {
            removeConflictBtn.disabled = false;
            inspectBtn.disabled = false;
            if (removeConflictBtn.textContent === 'Removing…') {
              removeConflictBtn.textContent = 'Remove broken device record';
            }
          }
        });
        rowActions.append(inspectBtn, removeConflictBtn);
      } else if (pairedPeer && isPeerScopeReviewPending(deviceId)) {
        rowActions.appendChild(el('div', 'peer-meta', 'Review this device\'s scope in People & devices next.'));
      } else if (pairedPeer) {
        rowActions.appendChild(
          el(
            'div',
            'peer-meta',
            approvalSummary.state === 'waiting-for-other-device'
              ? approvalSummary.description || 'Waiting on the other device.'
              : String(pairedPeer?.last_error || '').toLowerCase().includes('401') && String(pairedPeer?.last_error || '').toLowerCase().includes('unauthorized')
                ? 'Waiting for the other device to trust this one before sync can work.'
                : 'Manage this device in People & devices.',
          ),
        );
      }
      row.append(details, rowActions);
      discoveredList.appendChild(row);
    });
  }

  const inviteToggleRow = el('div', 'sync-action');
  const inviteToggleText = el('div', 'sync-action-text');
  inviteToggleText.textContent = 'Generate an invite to add another teammate to this team.';
  const inviteToggleBtn = el(
    'button',
    'settings-button',
    'Invite a teammate',
  ) as HTMLButtonElement;
  inviteToggleBtn.addEventListener('click', () => {
    if (!invitePanel) return;
    setTeamInvitePanelOpen(!teamInvitePanelOpen);
    if (invitePanel.parentElement !== actions) actions.appendChild(invitePanel);
    invitePanel.hidden = !teamInvitePanelOpen;
    inviteToggleBtn.textContent = teamInvitePanelOpen ? 'Hide invite form' : 'Invite a teammate';
  });
  inviteToggleRow.append(inviteToggleText, inviteToggleBtn);
  actions.appendChild(inviteToggleRow);
  if (invitePanel) {
    if (teamInvitePanelOpen) {
      if (invitePanel.parentElement !== actions) actions.appendChild(invitePanel);
      invitePanel.hidden = false;
      inviteToggleBtn.textContent = 'Hide invite form';
    } else {
      invitePanel.hidden = true;
    }
  }

  if (coordinator.presence_status === 'not_enrolled') {
    if (joinPanel) {
      if (joinPanel.parentElement !== actions) actions.appendChild(joinPanel);
      joinPanel.hidden = false;
    }
    const row = el('div', 'sync-action');
    const textWrap = el('div', 'sync-action-text');
    textWrap.textContent = 'This device is not connected to the team yet.';
    textWrap.appendChild(
      el(
        'span',
        'sync-action-command',
        'Import a team invite or ask your admin to enroll this device',
      ),
    );
    actions.appendChild(row);
    row.appendChild(textWrap);
  }
  if (!Number(coordinator.paired_peer_count || 0) && coordinator.presence_status === 'posted') {
    const row = el('div', 'sync-action');
    const textWrap = el('div', 'sync-action-text');
    textWrap.textContent = 'No devices are paired yet.';
    textWrap.appendChild(
      el('span', 'sync-action-command', 'codemem sync pair --payload-only'),
    );
    const btn = el('button', 'settings-button sync-action-copy', 'Copy') as HTMLButtonElement;
    btn.addEventListener('click', () =>
      copyToClipboard('codemem sync pair --payload-only', btn),
    );
    row.append(textWrap, btn);
    actions.appendChild(row);
  }

  const pending = Array.isArray(state.lastSyncJoinRequests) ? state.lastSyncJoinRequests : [];
  if (joinRequests && pending.length) {
    const title = el(
      'div',
      'peer-meta',
      `${pending.length} pending join request${pending.length === 1 ? '' : 's'}`,
    );
    joinRequests.appendChild(title);
    pending.forEach((request) => {
      const row = el('div', 'actor-row');
      const details = el('div', 'actor-details');
      const name = String(request.display_name || request.device_id || 'Pending device');
      details.append(
        el('div', 'actor-title', name),
        el('div', 'peer-meta', `request: ${String(request.request_id || '')}`),
      );
      const rowActions = el('div', 'actor-actions');
      const approveBtn = el('button', 'settings-button', 'Approve') as HTMLButtonElement;
      const denyBtn = el('button', 'settings-button', 'Deny') as HTMLButtonElement;
      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        denyBtn.disabled = true;
        approveBtn.textContent = 'Approving\u2026';
        try {
          await api.reviewJoinRequest(String(request.request_id || ''), 'approve');
          showGlobalNotice(`Approved ${name}. They can now sync with the team.`);
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, 'Failed to approve join request.'), 'warning');
          approveBtn.textContent = 'Retry';
        } finally {
          approveBtn.disabled = false;
          denyBtn.disabled = false;
        }
      });
      denyBtn.addEventListener('click', async () => {
        if (
          !window.confirm(
            `Deny join request from ${name}? They will need a new invite to try again.`,
          )
        )
          return;
        approveBtn.disabled = true;
        denyBtn.disabled = true;
        denyBtn.textContent = 'Denying\u2026';
        try {
          await api.reviewJoinRequest(String(request.request_id || ''), 'deny');
          showGlobalNotice(`Denied join request from ${name}.`);
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, 'Failed to deny join request.'), 'warning');
          denyBtn.textContent = 'Retry deny';
        } finally {
          approveBtn.disabled = false;
          denyBtn.disabled = false;
        }
      });
      rowActions.append(approveBtn, denyBtn);
      row.append(details, rowActions);
      joinRequests.appendChild(row);
    });
  } else if (joinRequests) {
    joinRequests.hidden = true;
  }
}

/* ── Event wiring ────────────────────────────────────────── */

export function initTeamSyncEvents(
  refreshCallback: () => void,
  loadSyncData: () => Promise<void>,
) {
  const syncNowButton = document.getElementById('syncNowButton') as HTMLButtonElement | null;
  const syncToggleAdmin = document.getElementById('syncToggleAdmin') as HTMLButtonElement | null;
  const syncInvitePanel = document.getElementById('syncInvitePanel');
  const syncCreateInviteButton = document.getElementById(
    'syncCreateInviteButton',
  ) as HTMLButtonElement | null;
  const syncInviteGroup = document.getElementById('syncInviteGroup') as HTMLInputElement | null;
  const syncInvitePolicy = document.getElementById('syncInvitePolicy') as HTMLSelectElement | null;
  const syncInviteTtl = document.getElementById('syncInviteTtl') as HTMLInputElement | null;
  const syncInviteOutput = document.getElementById(
    'syncInviteOutput',
  ) as HTMLTextAreaElement | null;
  const syncJoinButton = document.getElementById('syncJoinButton') as HTMLButtonElement | null;
  const syncJoinInvite = document.getElementById('syncJoinInvite') as HTMLTextAreaElement | null;

  syncToggleAdmin?.addEventListener('click', () => {
    if (!syncInvitePanel) return;
    setAdminSetupExpanded(!adminSetupExpanded);
    syncInvitePanel.hidden = !adminSetupExpanded;
    syncToggleAdmin.setAttribute('aria-expanded', String(adminSetupExpanded));
    syncToggleAdmin.textContent = adminSetupExpanded
      ? 'Hide team setup'
      : 'Set up a new team instead\u2026';
  });

  syncCreateInviteButton?.addEventListener('click', async () => {
    if (
      !syncCreateInviteButton ||
      !syncInviteGroup ||
      !syncInvitePolicy ||
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
        policy: syncInvitePolicy.value as 'auto_admit' | 'approval_required',
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
