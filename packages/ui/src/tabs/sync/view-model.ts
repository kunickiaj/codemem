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

interface MergedDevice {
  deviceId: string;
  localName: string;
  coordinatorName: string;
  peer: any | null;
  discovered: any | null;
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

export function derivePeerUiStatus(peer: any): UiSyncStatus {
  const peerState = cleanText(peer?.status?.peer_state);
  if (peer?.has_error || peerState === 'degraded') return 'needs-repair';
  if (peerState === 'online') return 'connected';
  if (peerState === 'offline' || peerState === 'stale') return 'offline';
  if (peer?.status?.fresh) return 'connected';
  return 'waiting';
}

export function deriveDuplicatePeople(actors: any[]): UiDuplicatePersonCandidate[] {
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

function createRepairItem(device: { id: string; name: string; summary: string }): UiSyncAttentionItem {
  return {
    id: `repair:${device.id}`,
    kind: 'device-needs-repair',
    priority: 10,
    title: `${device.name} needs repair`,
    summary: device.summary,
    actionLabel: 'Review device',
    deviceId: device.id,
  };
}

function createReviewItem(device: { id: string; name: string; summary: string }): UiSyncAttentionItem {
  return {
    id: `review:${device.id}`,
    kind: 'review-team-device',
    priority: 20,
    title: `${device.name} is available to review`,
    summary: device.summary,
    actionLabel: 'Review device',
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
    actionLabel: 'Name device',
    deviceId: device.id,
  };
}

function mergeDevices(peers: any[], discoveredDevices: any[]): MergedDevice[] {
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
  actors?: any[];
  peers?: any[];
  coordinator?: any;
}): UiSyncViewModel {
  const actors = Array.isArray(input.actors) ? input.actors : [];
  const peers = Array.isArray(input.peers) ? input.peers : [];
  const discoveredDevices = Array.isArray(input.coordinator?.discovered_devices)
    ? input.coordinator.discovered_devices
    : [];
  const mergedDevices = mergeDevices(peers, discoveredDevices);
  const duplicatePeople = deriveDuplicatePeople(actors);
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
      actionLabel: 'Review people',
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
      const detail = cleanText(device.peer?.last_error) || 'Sync health is degraded or broken.';
      attentionItems.push(createRepairItem({ id: device.deviceId, name, summary: detail }));
    } else if (device.peer && peerStatus === 'offline') {
      attentionItems.push(
        createRepairItem({
          id: device.deviceId,
          name,
          summary: 'This device is offline or stale. Review it before re-pairing or retrying sync.',
        }),
      );
    } else if (!device.peer && device.discovered && !device.discovered?.stale) {
      attentionItems.push(
        createReviewItem({
          id: device.deviceId,
          name,
          summary: 'This device is seen on the team and is ready for review or connection on this machine.',
        }),
      );
    }

    if (
      deviceNeedsFriendlyName({
        localName: device.localName,
        coordinatorName: device.coordinatorName,
        deviceId: device.deviceId,
      }) && looksLikeDeviceId(name)
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
      offlineTeamDeviceCount: discoveredDevices.filter((device: any) => Boolean(device?.stale)).length,
    },
    duplicatePeople,
    attentionItems: attentionItems.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title)),
  };
}
