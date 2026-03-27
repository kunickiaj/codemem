/* Shared helpers for the Sync tab sub-modules. */

import { el, copyToClipboard } from '../../lib/dom';
import { state } from '../../lib/state';

/* ── Skeleton helpers ────────────────────────────────────── */

export function hideSkeleton(id: string): void {
  const skeleton = document.getElementById(id);
  if (skeleton) skeleton.remove();
}

/* ── Module-level UI state ───────────────────────────────── */

export let adminSetupExpanded = false;
export function setAdminSetupExpanded(v: boolean) {
  adminSetupExpanded = v;
}

export let teamInvitePanelOpen = false;
export function setTeamInvitePanelOpen(v: boolean) {
  teamInvitePanelOpen = v;
}

export const openPeerScopeEditors = new Set<string>();
const pendingPeerScopeReviewIds = new Set<string>();
const freshPeerScopeReviewIds = new Set<string>();

export function requestPeerScopeReview(peerDeviceId: string) {
  const value = String(peerDeviceId || '').trim();
  if (!value) return;
  pendingPeerScopeReviewIds.add(value);
  freshPeerScopeReviewIds.add(value);
  openPeerScopeEditors.add(value);
}

export function isPeerScopeReviewPending(peerDeviceId: string): boolean {
  const value = String(peerDeviceId || '').trim();
  return Boolean(value) && pendingPeerScopeReviewIds.has(value);
}

export function clearPeerScopeReview(peerDeviceId: string) {
  const value = String(peerDeviceId || '').trim();
  if (!value) return;
  pendingPeerScopeReviewIds.delete(value);
}

export function consumePeerScopeReviewRequest(peerDeviceId: string): boolean {
  const value = String(peerDeviceId || '').trim();
  if (!value || !freshPeerScopeReviewIds.has(value)) return false;
  freshPeerScopeReviewIds.delete(value);
  return true;
}

/* ── Text helpers ────────────────────────────────────────── */

/** Redact the last two octets of IPv4 addresses. */
export function redactIpOctets(text: string): string {
  return text.replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, '$1.#.#');
}

export function redactAddress(address: any): string {
  const raw = String(address || '');
  if (!raw) return '';
  return redactIpOctets(raw);
}

export function pickPrimaryAddress(addresses: unknown): string {
  if (!Array.isArray(addresses)) return '';
  const unique = Array.from(new Set(addresses.filter(Boolean)));
  return typeof unique[0] === 'string' ? unique[0] : '';
}

export function parseScopeList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/* ── Actor helpers ───────────────────────────────────────── */

export function actorLabel(actor: any): string {
  if (!actor || typeof actor !== 'object') return 'Unknown actor';
  const displayName = String(actor.display_name || '').trim();
  if (!displayName) return String(actor.actor_id || 'Unknown actor');
  return displayName;
}

export function assignedActorCount(actorId: string): number {
  const peers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
  return peers.filter((peer) => String(peer?.actor_id || '') === actorId).length;
}

export function assignmentNote(actorId: string): string {
  if (!actorId) return 'Unassigned devices keep legacy fallback attribution until you choose an actor.';
  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  const actor = actors.find((item) => String(item?.actor_id || '') === actorId);
  if (actor?.is_local) {
    return 'Local actor assignment keeps this device in your same-person continuity path, including private sync.';
  }
  return 'This actor receives memories from allowed projects by default. Use Only me on a memory when it should stay local.';
}

export function buildActorOptions(selectedActorId: string): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [];
  const unassigned = document.createElement('option');
  unassigned.value = '';
  unassigned.textContent = 'No actor assigned';
  options.push(unassigned);

  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  actors.forEach((actor) => {
    const option = document.createElement('option');
    option.value = String(actor.actor_id || '');
    option.textContent = actor.is_local ? `${actorLabel(actor)} (local)` : actorLabel(actor);
    option.selected = option.value === selectedActorId;
    options.push(option);
  });
  if (!selectedActorId) options[0].selected = true;
  return options;
}

export function mergeTargetActors(actorId: string): any[] {
  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  return actors.filter((actor) => String(actor?.actor_id || '') !== actorId);
}

export function actorMergeNote(targetActorId: string, secondaryActorId: string): string {
  const target = mergeTargetActors(secondaryActorId).find(
    (actor) => String(actor?.actor_id || '') === targetActorId,
  );
  if (!targetActorId || !target) {
    return 'Choose where this duplicate actor should collapse.';
  }
  return `Merge into ${actorLabel(target)}. Assigned devices move now; existing memories keep their current provenance.`;
}

/* ── Chip editor component ───────────────────────────────── */

export function createChipEditor(initialValues: string[], placeholder: string, emptyLabel: string) {
  let values = [...initialValues];
  const container = el('div', 'peer-scope-editor');
  const chips = el('div', 'peer-scope-chips');
  const input = el('input', 'peer-scope-input') as HTMLInputElement;
  input.placeholder = placeholder;

  const syncChips = () => {
    chips.textContent = '';
    if (!values.length) {
      chips.appendChild(el('span', 'peer-scope-chip empty', emptyLabel));
      return;
    }
    values.forEach((value, index) => {
      const chip = el('span', 'peer-scope-chip');
      const label = el('span', null, value);
      const remove = el('button', 'peer-scope-chip-remove', 'x') as HTMLButtonElement;
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${value}`);
      remove.addEventListener('click', () => {
        values = values.filter((_, currentIndex) => currentIndex !== index);
        syncChips();
      });
      chip.append(label, remove);
      chips.appendChild(chip);
    });
  };

  const commitInput = () => {
    const incoming = parseScopeList(input.value);
    if (incoming.length) {
      values = Array.from(new Set([...values, ...incoming]));
      input.value = '';
      syncChips();
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitInput();
    }
    if (event.key === 'Backspace' && !input.value && values.length) {
      values = values.slice(0, -1);
      syncChips();
    }
  });
  input.addEventListener('blur', commitInput);

  syncChips();
  container.append(chips, input);
  return {
    element: container,
    values: () => [...values],
  };
}

/* ── Action list renderer ────────────────────────────────── */

export function renderActionList(
  container: HTMLElement | null,
  actions: Array<{ label: string; command: string }>,
) {
  if (!container) return;
  container.textContent = '';
  if (!actions.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  actions.slice(0, 2).forEach((item) => {
    const row = el('div', 'sync-action');
    const textWrap = el('div', 'sync-action-text');
    textWrap.textContent = item.label;
    textWrap.appendChild(el('span', 'sync-action-command', item.command));
    const btn = el('button', 'settings-button sync-action-copy', 'Copy') as HTMLButtonElement;
    btn.addEventListener('click', () => copyToClipboard(item.command, btn));
    row.append(textWrap, btn);
    container.appendChild(row);
  });
}
