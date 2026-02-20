/* Settings modal — observer config, sync settings. */

import { $, $input, $select, $button, hide, show } from '../lib/dom';
import { state } from '../lib/state';
import * as api from '../lib/api';

let settingsOpen = false;

export function isSettingsOpen(): boolean {
  return settingsOpen;
}

export function renderConfigModal(payload: any) {
  if (!payload || typeof payload !== 'object') return;
  const defaults = payload.defaults || {};
  const config = payload.config || {};
  state.configDefaults = defaults;
  state.configPath = payload.path || '';

  const observerProvider = $select('observerProvider');
  const observerModel = $input('observerModel');
  const observerMaxChars = $input('observerMaxChars');
  const packObservationLimit = $input('packObservationLimit');
  const packSessionLimit = $input('packSessionLimit');
  const syncEnabled = $input('syncEnabled');
  const syncHost = $input('syncHost');
  const syncPort = $input('syncPort');
  const syncInterval = $input('syncInterval');
  const syncMdns = $input('syncMdns');
  const settingsPath = $('settingsPath');
  const observerMaxCharsHint = $('observerMaxCharsHint');
  const settingsEffective = $('settingsEffective');

  if (observerProvider) observerProvider.value = config.observer_provider || '';
  if (observerModel) observerModel.value = config.observer_model || '';
  if (observerMaxChars) observerMaxChars.value = config.observer_max_chars || '';
  if (packObservationLimit) packObservationLimit.value = config.pack_observation_limit || '';
  if (packSessionLimit) packSessionLimit.value = config.pack_session_limit || '';
  if (syncEnabled) syncEnabled.checked = Boolean(config.sync_enabled);
  if (syncHost) syncHost.value = config.sync_host || '';
  if (syncPort) syncPort.value = config.sync_port || '';
  if (syncInterval) syncInterval.value = config.sync_interval_s || '';
  if (syncMdns) syncMdns.checked = Boolean(config.sync_mdns);

  if (settingsPath) settingsPath.textContent = state.configPath ? `Config path: ${state.configPath}` : 'Config path: n/a';
  if (observerMaxCharsHint) {
    const def = defaults?.observer_max_chars || '';
    observerMaxCharsHint.textContent = def ? `Default: ${def}` : '';
  }
  if (settingsEffective) {
    settingsEffective.textContent = payload.env_overrides ? 'Effective config differs (env overrides active)' : '';
  }

  setDirty(false);
  const settingsStatus = $('settingsStatus');
  if (settingsStatus) settingsStatus.textContent = 'Ready';
}

function setDirty(dirty: boolean) {
  state.settingsDirty = dirty;
  const saveBtn = $button('settingsSave');
  if (saveBtn) saveBtn.disabled = !dirty;
}

export function openSettings(stopPolling: () => void) {
  settingsOpen = true;
  stopPolling();
  show($('settingsBackdrop'));
  show($('settingsModal'));
}

export function closeSettings(startPolling: () => void, refreshCallback: () => void) {
  if (state.settingsDirty) {
    if (!globalThis.confirm('Discard unsaved changes?')) return;
  }
  settingsOpen = false;
  hide($('settingsBackdrop'));
  hide($('settingsModal'));
  startPolling();
  refreshCallback();
}

export async function saveSettings(startPolling: () => void, refreshCallback: () => void) {
  const saveBtn = $button('settingsSave');
  const status = $('settingsStatus');
  if (!saveBtn || !status) return;

  saveBtn.disabled = true;
  status.textContent = 'Saving...';

  try {
    await api.saveConfig({
      observer_provider: $select('observerProvider')?.value || '',
      observer_model: $input('observerModel')?.value || '',
      observer_max_chars: Number($input('observerMaxChars')?.value || 0) || '',
      pack_observation_limit: Number($input('packObservationLimit')?.value || 0) || '',
      pack_session_limit: Number($input('packSessionLimit')?.value || 0) || '',
      sync_enabled: $input('syncEnabled')?.checked || false,
      sync_host: $input('syncHost')?.value || '',
      sync_port: Number($input('syncPort')?.value || 0) || '',
      sync_interval_s: Number($input('syncInterval')?.value || 0) || '',
      sync_mdns: $input('syncMdns')?.checked || false,
    });
    status.textContent = 'Saved';
    setDirty(false);
    closeSettings(startPolling, refreshCallback);
  } catch {
    status.textContent = 'Save failed';
  } finally {
    saveBtn.disabled = !state.settingsDirty;
  }
}

export async function loadConfigData() {
  if (settingsOpen) return;
  try {
    const payload = await api.loadConfig();
    renderConfigModal(payload);
    const overrides = $('settingsOverrides');
    if (overrides) (overrides as any).hidden = !payload?.config?.has_env_overrides;
  } catch {}
}

export function initSettings(stopPolling: () => void, startPolling: () => void, refreshCallback: () => void) {
  const settingsButton = $button('settingsButton');
  const settingsClose = $button('settingsClose');
  const settingsBackdrop = $('settingsBackdrop');
  const settingsModal = $('settingsModal');
  const settingsSave = $button('settingsSave');

  settingsButton?.addEventListener('click', () => openSettings(stopPolling));
  settingsClose?.addEventListener('click', () => closeSettings(startPolling, refreshCallback));
  settingsBackdrop?.addEventListener('click', () => closeSettings(startPolling, refreshCallback));
  settingsModal?.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(startPolling, refreshCallback); });
  settingsSave?.addEventListener('click', () => saveSettings(startPolling, refreshCallback));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsOpen) closeSettings(startPolling, refreshCallback);
  });

  // Mark dirty on any input change
  const inputs = ['observerProvider', 'observerModel', 'observerMaxChars', 'packObservationLimit', 'packSessionLimit', 'syncEnabled', 'syncHost', 'syncPort', 'syncInterval', 'syncMdns'];
  inputs.forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => setDirty(true));
    input.addEventListener('change', () => setDirty(true));
  });
}
