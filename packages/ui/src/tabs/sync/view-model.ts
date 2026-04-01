/* Derived sync view-model helpers. Keep these pure so UX logic is testable. */

export const SYNC_TERMINOLOGY = {
  actor: 'person',
  actors: 'people',
  actorAssignment: 'person assignment',
  localActor: 'you',
  peer: 'device',
  peers: 'devices',
  pairedLocally: 'Connected on this device',
  discovered: 'Seen on team',
  conflicts: 'Needs repair',
} as const;

export type UiSyncStatus = 'connected' | 'available' | 'needs-repair' | 'offline' | 'waiting';
export type UiTrustState = 'available' | 'trusted-by-you' | 'mutual-trust' | 'needs-repair' | 'offline';
export type UiCoordinatorApprovalState = 'none' | 'needs-your-approval' | 'waiting-for-other-device';

interface SyncPeerStatusLike {
  peer_state?: string;
  sync_status?: string;
  ping_status?: string;
  fresh?: boolean;
}

export interface UiSyncRunItem {
  peer_device_id: string;
  ok: boolean;
  error?: string;
  address?: string;
  opsIn: number;
  opsOut: number;
  addressErrors: Array<{ address: string; error: string }>;
}

export interface UiSyncRunResponse {
  items: UiSyncRunItem[];
}

export interface UiSyncAttentionItem {
  id: string;
  kind: 'possible-duplicate-person' | 'device-needs-repair' | 'review-team-device' | 'name-device';
  priority: number;
  title: string;
  summary: string;
  actionLabel: string;
  deviceId?: string;
  actorIds?: string[];
}

export interface UiDuplicatePersonCandidate {
  displayName: string;
  actorIds: string[];
  includesLocal: boolean;
}

export interface UiSyncViewModel {
  summary: {
    connectedDeviceCount: number;
    seenOnTeamCount: number;
    offlineTeamDeviceCount: number;
  };
  duplicatePeople: UiDuplicatePersonCandidate[];
  attentionItems: UiSyncAttentionItem[];
}

export interface UiPeerTrustSummary {
  state: UiTrustState;
  badgeLabel: string;
  description: string;
  isWarning: boolean;
}

export interface VisiblePeopleResult {
  visibleActors: ActorLike[];
  hiddenLocalDuplicateCount: number;
}

export interface ActorLike {
  actor_id?: string;
  display_name?: string;
  is_local?: boolean;
}

export interface PeerLike {
  peer_device_id?: string;
  name?: string;
  has_error?: boolean;
  last_error?: string;
  fingerprint?: string;
  actor_id?: string;
  status?: SyncPeerStatusLike;
}

export interface DiscoveredDeviceLike {
  device_id?: string;
  display_name?: string;
  stale?: boolean;
  fingerprint?: string;
  groups?: string[];
  needs_local_approval?: boolean;
  waiting_for_peer_approval?: boolean;
}

export interface UiCoordinatorApprovalSummary {
  state: UiCoordinatorApprovalState;
  badgeLabel: string | null;
  description: string | null;
  actionLabel: string | null;
}

interface MergedDevice {
  deviceId: string;
  localName: string;
  coordinatorName: string;
  peer: PeerLike | null;
  discovered: DiscoveredDeviceLike | null;
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeDisplayName(value: unknown): string {
  return cleanText(value).replace(/\s+/g, ' ').toLowerCase();
}

function looksLikeDeviceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
}

function friendlyDeviceFallback(deviceId: string): string {
  const cleanId = cleanText(deviceId);
  return cleanId ? cleanId.slice(0, 8) : 'Unnamed device';
}

export function resolveFriendlyDeviceName(input: {
  localName?: unknown;
  coordinatorName?: unknown;
  deviceId?: unknown;
}): string {
  const localName = cleanText(input.localName);
  if (localName) return localName;
  const coordinatorName = cleanText(input.coordinatorName);
  if (coordinatorName) return coordinatorName;
  return friendlyDeviceFallback(cleanText(input.deviceId));
}

export function deviceNeedsFriendlyName(input: {
  localName?: unknown;
  coordinatorName?: unknown;
  deviceId?: unknown;
}): boolean {
  const localName = cleanText(input.localName);
  const coordinatorName = cleanText(input.coordinatorName);
  if (localName || coordinatorName) return false;
  return Boolean(cleanText(input.deviceId));
}

export function derivePeerUiStatus(peer: PeerLike): UiSyncStatus {
  const peerState = cleanText(peer?.status?.peer_state);
  if (peer?.has_error || peerState === 'degraded') return 'needs-repair';
  if (peerState === 'online') return 'connected';
  if (peerState === 'offline' || peerState === 'stale') return 'offline';
  if (peer?.status?.fresh) return 'connected';
  return 'waiting';
}

function isOfflineTeamDevice(device: MergedDevice): boolean {
  if (!device.discovered?.stale) return false;
  return device.peer ? derivePeerUiStatus(device.peer) !== 'connected' : true;
}

function peerErrorText(peer: PeerLike): string {
  return cleanText(peer?.last_error).toLowerCase();
}

export function derivePeerTrustSummary(peer: PeerLike): UiPeerTrustSummary {
  const peerStatus = peer?.status || {};
  const peerState = cleanText(peerStatus.peer_state);
  const lastError = peerErrorText(peer);
  const syncOk = cleanText(peerStatus.sync_status) === 'ok' || cleanText(peerStatus.ping_status) === 'ok';
  if (peerState === 'offline' || peerState === 'stale') {
    return {
      state: 'offline',
      badgeLabel: 'Offline',
      description: 'This device is known locally, but it is not reachable right now.',
      isWarning: true,
    };
  }
  if (lastError.includes('401') && lastError.includes('unauthorized')) {
    return {
      state: 'trusted-by-you',
      badgeLabel: 'Waiting for other device',
      description:
        'You accepted this device, but the other device still needs to trust this one before sync can work.',
      isWarning: true,
    };
  }
  if (syncOk || peerState === 'online') {
    return {
      state: 'mutual-trust',
      badgeLabel: 'Two-way trust',
      description: 'Both devices trust each other and sync can run in both directions.',
      isWarning: false,
    };
  }
  if (peer?.has_error || peerState === 'degraded') {
    return {
      state: 'needs-repair',
      badgeLabel: 'Needs repair',
      description: 'This device has a sync problem that needs review before trust can be relied on.',
      isWarning: true,
    };
  }
  return {
    state: 'trusted-by-you',
    badgeLabel: 'Trusted on this device',
    description:
      'This device is trusted locally. Finish onboarding on the other device if sync is still blocked.',
    isWarning: false,
  };
}

export function deriveCoordinatorApprovalSummary(input: {
  device: DiscoveredDeviceLike;
  pairedLocally?: boolean;
}): UiCoordinatorApprovalSummary {
  if (Boolean(input.device?.needs_local_approval) && !input.pairedLocally) {
    return {
      state: 'needs-your-approval',
      badgeLabel: 'Needs your approval',
      description:
        'Another device already trusted this one. Approve it on this device to finish reciprocal onboarding.',
      actionLabel: 'Approve on this device',
    };
  }
  if (Boolean(input.device?.waiting_for_peer_approval)) {
    return {
      state: 'waiting-for-other-device',
      badgeLabel: 'Waiting on other device',
      description:
        'You already trusted this device here. The other device still needs to approve this one before sync can work both ways.',
      actionLabel: null,
    };
  }
  return {
    state: 'none',
    badgeLabel: null,
    description: null,
    actionLabel: null,
  };
}

export function summarizeSyncRunResult(payload: UiSyncRunResponse): { ok: boolean; message: string; warning: boolean } {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return { ok: true, message: 'Sync pass completed with no eligible devices.', warning: false };
  }
  const failedItems = items.filter((item) => item && item.ok === false);
  if (!failedItems.length) {
    return {
      ok: true,
      message: `Sync pass finished for ${items.length} device${items.length === 1 ? '' : 's'}.`,
      warning: false,
    };
  }
  const unauthorizedFailures = failedItems.filter((item) => cleanText(item.error).toLowerCase().includes('401') && cleanText(item.error).toLowerCase().includes('unauthorized'));
  if (unauthorizedFailures.length === failedItems.length) {
    return {
      ok: false,
      message:
        'This device trusts the peer, but the other device still needs to trust this one before sync can work.',
      warning: true,
    };
  }
  if (failedItems.length < items.length) {
    return {
      ok: false,
      message: `${failedItems.length} of ${items.length} device sync attempts failed. Review device details for the specific errors.`,
      warning: true,
    };
  }
  const error = cleanText(failedItems[0]?.error);
  return {
    ok: false,
    message: error || 'Sync failed for at least one device.',
    warning: true,
  };
}

export function deriveDuplicatePeople(actors: ActorLike[]): UiDuplicatePersonCandidate[] {
  const groups = new Map<string, UiDuplicatePersonCandidate>();
  (Array.isArray(actors) ? actors : []).forEach((actor) => {
    const displayName = cleanText(actor?.display_name);
    const actorId = cleanText(actor?.actor_id);
    const normalized = normalizeDisplayName(displayName);
    if (!displayName || !actorId || !normalized) return;
    const current = groups.get(normalized) ?? {
      displayName,
      actorIds: [],
      includesLocal: false,
    };
    current.actorIds = [...current.actorIds, actorId];
    current.includesLocal = current.includesLocal || Boolean(actor?.is_local);
    groups.set(normalized, current);
  });
  return [...groups.values()]
    .filter((item) => item.actorIds.length > 1)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function deriveVisiblePeopleActors(input: {
  actors?: ActorLike[];
  peers?: PeerLike[];
  duplicatePeople?: UiDuplicatePersonCandidate[];
}): VisiblePeopleResult {
  const actors = Array.isArray(input.actors) ? input.actors : [];
  const peers = Array.isArray(input.peers) ? input.peers : [];
  const duplicatePeople = Array.isArray(input.duplicatePeople) ? input.duplicatePeople : [];
  const assignedCounts = new Map<string, number>();
  peers.forEach((peer) => {
    const actorId = cleanText(peer?.actor_id);
    if (!actorId) return;
    assignedCounts.set(actorId, (assignedCounts.get(actorId) ?? 0) + 1);
  });

  const hiddenIds = new Set<string>();
  duplicatePeople.forEach((candidate) => {
    if (!candidate.includesLocal) return;
    candidate.actorIds.forEach((actorId) => {
      const actor = actors.find((item) => cleanText(item?.actor_id) === actorId);
      if (!actor || actor.is_local) return;
      if ((assignedCounts.get(actorId) ?? 0) > 0) return;
      hiddenIds.add(actorId);
    });
  });

  return {
    visibleActors: actors.filter((actor) => !hiddenIds.has(cleanText(actor?.actor_id))),
    hiddenLocalDuplicateCount: hiddenIds.size,
  };
}

function createRepairItem(device: { id: string; name: string; summary: string }): UiSyncAttentionItem {
  return {
    id: `repair:${device.id}`,
    kind: 'device-needs-repair',
    priority: 10,
    title: `${device.name} needs repair`,
    summary: device.summary,
    actionLabel: 'Open device',
    deviceId: device.id,
  };
}

function createReviewItem(device: { id: string; name: string; summary: string; key?: string }): UiSyncAttentionItem {
  return {
    id: `review:${device.id}:${device.key || 'default'}`,
    kind: 'review-team-device',
    priority: 20,
    title: `${device.name} is available to review`,
    summary: device.summary,
    actionLabel: 'Open device',
    deviceId: device.id,
  };
}

function createNamingItem(device: { id: string; name: string; summary: string }): UiSyncAttentionItem {
  return {
    id: `name:${device.id}`,
    kind: 'name-device',
    priority: 30,
    title: `Name ${device.name}`,
    summary: device.summary,
    actionLabel: 'Go to name field',
    deviceId: device.id,
  };
}

function mergeDevices(peers: PeerLike[], discoveredDevices: DiscoveredDeviceLike[]): MergedDevice[] {
  const devices = new Map<string, MergedDevice>();
  const getOrCreate = (deviceId: string): MergedDevice => {
    const current = devices.get(deviceId) ?? {
      deviceId,
      localName: '',
      coordinatorName: '',
      peer: null,
      discovered: null,
    };
    devices.set(deviceId, current);
    return current;
  };

  peers.forEach((peer) => {
    const deviceId = cleanText(peer?.peer_device_id);
    if (!deviceId) return;
    const current = getOrCreate(deviceId);
    current.peer = peer;
    current.localName = cleanText(peer?.name);
  });

  discoveredDevices.forEach((device) => {
    const deviceId = cleanText(device?.device_id);
    if (!deviceId) return;
    const current = getOrCreate(deviceId);
    current.discovered = device;
    current.coordinatorName = cleanText(device?.display_name);
  });

  return [...devices.values()];
}

export function deriveSyncViewModel(input: {
  actors?: ActorLike[];
  peers?: PeerLike[];
  coordinator?: { discovered_devices?: DiscoveredDeviceLike[] };
  duplicatePersonDecisions?: Record<string, string>;
}): UiSyncViewModel {
  const actors = Array.isArray(input.actors) ? input.actors : [];
  const peers = Array.isArray(input.peers) ? input.peers : [];
  const discoveredDevices = Array.isArray(input.coordinator?.discovered_devices)
    ? input.coordinator.discovered_devices
    : [];
  const mergedDevices = mergeDevices(peers, discoveredDevices);
  const duplicateDecisions = input.duplicatePersonDecisions ?? {};
  const duplicatePeople = deriveDuplicatePeople(actors).filter(
    (candidate) => !duplicateDecisions[[...candidate.actorIds].sort().join('::')],
  );
  const attentionItems: UiSyncAttentionItem[] = [];

  duplicatePeople.forEach((candidate) => {
    attentionItems.push({
      id: `duplicate:${candidate.actorIds.join(':')}`,
      kind: 'possible-duplicate-person',
      priority: candidate.includesLocal ? 5 : 15,
      title: `Possible duplicate person: ${candidate.displayName}`,
      summary: candidate.includesLocal
        ? 'At least one entry is marked as you. Confirm whether these records represent the same person.'
        : 'Multiple people share this name. Confirm whether they should stay separate or be combined.',
      actionLabel: 'Go to people',
      actorIds: candidate.actorIds,
    });
  });

  mergedDevices.forEach((device) => {
    const name = resolveFriendlyDeviceName({
      localName: device.localName,
      coordinatorName: device.coordinatorName,
      deviceId: device.deviceId,
    });
    const peerStatus = device.peer ? derivePeerUiStatus(device.peer) : 'waiting';
    const trustSummary = device.peer ? derivePeerTrustSummary(device.peer) : null;
    const discoveredFingerprint = cleanText(device.discovered?.fingerprint);
    const peerFingerprint = cleanText(device.peer?.fingerprint);
    const hasConflict = Boolean(device.peer) && Boolean(discoveredFingerprint) && Boolean(peerFingerprint) && discoveredFingerprint !== peerFingerprint;

    if (hasConflict) {
      attentionItems.push(
        createRepairItem({
          id: device.deviceId,
          name,
          summary: 'This device identity changed. Repair or remove the older local record before reconnecting it.',
        }),
      );
      return;
    }

    if (device.peer && peerStatus === 'needs-repair') {
      const detail = trustSummary?.state === 'trusted-by-you'
        ? trustSummary.description
        : cleanText(device.peer?.last_error) || 'Sync health is degraded or broken.';
      attentionItems.push(createRepairItem({ id: device.deviceId, name, summary: detail }));
    } else if (device.peer && peerStatus === 'offline') {
      attentionItems.push(
        createRepairItem({
          id: device.deviceId,
          name,
          summary: 'This device is offline or stale. Review it before re-pairing or retrying sync.',
        }),
      );
    }

    if (device.peer && trustSummary?.state === 'trusted-by-you') {
      attentionItems.push(
        createReviewItem({
          id: device.deviceId,
          key: 'other-device-trust',
          name,
          summary:
            'You accepted this device. Finish onboarding on the other device so it trusts this one too.',
        }),
      );
    }

    if (!device.peer && device.discovered?.stale) {
      attentionItems.push(
        createReviewItem({
          id: device.deviceId,
          key: 'stale-discovery',
          name,
          summary: 'This device is no longer advertising fresh coordinator presence. Wait for it to check in again before connecting it here.',
        }),
      );
    }

    if (!device.peer && Array.isArray(device.discovered?.groups) && device.discovered.groups.length > 1) {
      attentionItems.push(
        createReviewItem({
          id: device.deviceId,
          key: 'ambiguous-groups',
          name,
          summary: 'This device appears in multiple coordinator groups. Review the team setup before approving it here.',
        }),
      );
    }

    if (
      device.peer &&
      deviceNeedsFriendlyName({
        localName: device.localName,
        coordinatorName: device.coordinatorName,
        deviceId: device.deviceId,
      })
    ) {
      attentionItems.push(
        createNamingItem({
          id: device.deviceId,
          name,
          summary: 'Give this device a friendly name so it is easier to recognize later.',
        }),
      );
    }
  });

  return {
    summary: {
      connectedDeviceCount: peers.filter((peer) => derivePeerUiStatus(peer) === 'connected').length,
      seenOnTeamCount: discoveredDevices.length,
      offlineTeamDeviceCount: mergedDevices.filter((device) => isOfflineTeamDevice(device)).length,
    },
    duplicatePeople,
    attentionItems: attentionItems.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title)),
  };
}
