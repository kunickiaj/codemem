import { render, type ComponentChildren } from 'preact';

function markMount(mount: HTMLElement) {
  mount.dataset.syncRenderRoot = 'preact';
}

export function ensureSyncRenderBoundary() {
  const syncTab = document.getElementById('tab-sync');
  if (!syncTab) return;
  syncTab.dataset.syncRenderBoundary = 'preact-hybrid';
}

export function renderIntoSyncMount(mount: HTMLElement, content: ComponentChildren) {
  markMount(mount);
  render(content, mount);
}

export function clearSyncMount(mount: HTMLElement) {
  if (mount.dataset.syncRenderRoot !== 'preact') return;
  render(null, mount);
}
