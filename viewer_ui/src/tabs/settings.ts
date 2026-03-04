/* Settings modal — observer config, sync settings. */

import { $, $input, $select, $button, hide, show } from '../lib/dom';
import { state } from '../lib/state';
import * as api from '../lib/api';

let settingsOpen = false;
let previouslyFocused: HTMLElement | null = null;
let settingsActiveTab = 'observer';

function hasOwn(obj: unknown, key: string): boolean {
  return typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

function configuredOrEffective(config: any, effective: any, key: string): any {
  if (hasOwn(config, key)) return config[key];
  if (hasOwn(effective, key)) return effective[key];
  return undefined;
}

function asInputString(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

function toProviderList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function setProviderOptions(
  selectEl: HTMLSelectElement | null,
  providers: string[],
  currentValue: string,
) {
  if (!selectEl) return;
  const values = new Set(providers);
  if (currentValue) values.add(currentValue);

  selectEl.innerHTML = '';
  const autoOption = document.createElement('option');
  autoOption.value = '';
  autoOption.textContent = 'auto (default)';
  selectEl.append(autoOption);

  Array.from(values)
    .sort((a, b) => a.localeCompare(b))
    .forEach((provider) => {
      const option = document.createElement('option');
      option.value = provider;
      option.textContent = provider;
      selectEl.append(option);
    });

  selectEl.value = currentValue;
}

function getFocusableNodes(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const selector = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[href]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(container.querySelectorAll(selector)).filter((node) => {
    const el = node as HTMLElement;
    return !el.hidden && el.offsetParent !== null;
  }) as HTMLElement[];
}

function trapModalFocus(event: KeyboardEvent) {
  if (!settingsOpen || event.key !== 'Tab') return;
  const modal = $('settingsModal');
  const focusable = getFocusableNodes(modal as HTMLElement | null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;

  if (event.shiftKey) {
    if (!active || active === first || !modal?.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (!active || active === last || !modal?.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

export function isSettingsOpen(): boolean {
  return settingsOpen;
}

export function renderConfigModal(payload: any) {
  if (!payload || typeof payload !== 'object') return;
  const defaults = payload.defaults || {};
  const config = payload.config || {};
  const effective = payload.effective || {};
  const envOverrides = payload.env_overrides && typeof payload.env_overrides === 'object'
    ? payload.env_overrides
    : {};
  const providers = toProviderList(payload.providers);
  state.configDefaults = defaults;
  state.configPath = payload.path || '';

  const observerProvider = $select('observerProvider');
  const observerModel = $input('observerModel');
  const observerRuntime = $select('observerRuntime');
  const observerAuthSource = $select('observerAuthSource');
  const observerAuthFile = $input('observerAuthFile');
  const observerAuthCommand = document.getElementById('observerAuthCommand') as HTMLTextAreaElement | null;
  const observerAuthTimeoutMs = $input('observerAuthTimeoutMs');
  const observerAuthCacheTtlS = $input('observerAuthCacheTtlS');
  const observerHeaders = document.getElementById('observerHeaders') as HTMLTextAreaElement | null;
  const observerMaxChars = $input('observerMaxChars');
  const packObservationLimit = $input('packObservationLimit');
  const packSessionLimit = $input('packSessionLimit');
  const rawEventsSweeperIntervalS = $input('rawEventsSweeperIntervalS');
  const syncEnabled = $input('syncEnabled');
  const syncHost = $input('syncHost');
  const syncPort = $input('syncPort');
  const syncInterval = $input('syncInterval');
  const syncMdns = $input('syncMdns');
  const settingsPath = $('settingsPath');
  const observerModelHint = $('observerModelHint');
  const observerMaxCharsHint = $('observerMaxCharsHint');
  const settingsEffective = $('settingsEffective');

  const observerProviderValue = asInputString(configuredOrEffective(config, effective, 'observer_provider'));
  setProviderOptions(observerProvider, providers, observerProviderValue);

  const observerModelValue = asInputString(configuredOrEffective(config, effective, 'observer_model'));
  if (observerModel) observerModel.value = observerModelValue;
  if (observerRuntime) observerRuntime.value = asInputString(configuredOrEffective(config, effective, 'observer_runtime')) || 'api_http';
  if (observerAuthSource) observerAuthSource.value = asInputString(configuredOrEffective(config, effective, 'observer_auth_source')) || 'auto';
  if (observerAuthFile) observerAuthFile.value = asInputString(configuredOrEffective(config, effective, 'observer_auth_file'));
  if (observerAuthCommand) {
    const argv = configuredOrEffective(config, effective, 'observer_auth_command');
    const command = Array.isArray(argv) ? argv : [];
    const commandStrings = command.filter((item) => typeof item === 'string');
    observerAuthCommand.value = commandStrings.length ? JSON.stringify(commandStrings, null, 2) : '';
  }
  if (observerAuthTimeoutMs) {
    observerAuthTimeoutMs.value = asInputString(configuredOrEffective(config, effective, 'observer_auth_timeout_ms'));
  }
  if (observerAuthCacheTtlS) {
    observerAuthCacheTtlS.value = asInputString(configuredOrEffective(config, effective, 'observer_auth_cache_ttl_s'));
  }
  if (observerHeaders) {
    const headerValue = configuredOrEffective(config, effective, 'observer_headers');
    const headers = headerValue && typeof headerValue === 'object' ? headerValue : {};
    observerHeaders.value = Object.keys(headers).length ? JSON.stringify(headers, null, 2) : '';
  }
  if (observerMaxChars) observerMaxChars.value = asInputString(configuredOrEffective(config, effective, 'observer_max_chars'));
  if (packObservationLimit) packObservationLimit.value = asInputString(configuredOrEffective(config, effective, 'pack_observation_limit'));
  if (packSessionLimit) packSessionLimit.value = asInputString(configuredOrEffective(config, effective, 'pack_session_limit'));
  if (rawEventsSweeperIntervalS) {
    rawEventsSweeperIntervalS.value = asInputString(configuredOrEffective(config, effective, 'raw_events_sweeper_interval_s'));
  }
  if (syncEnabled) syncEnabled.checked = Boolean(configuredOrEffective(config, effective, 'sync_enabled'));
  if (syncHost) syncHost.value = asInputString(configuredOrEffective(config, effective, 'sync_host'));
  if (syncPort) syncPort.value = asInputString(configuredOrEffective(config, effective, 'sync_port'));
  if (syncInterval) syncInterval.value = asInputString(configuredOrEffective(config, effective, 'sync_interval_s'));
  if (syncMdns) syncMdns.checked = Boolean(configuredOrEffective(config, effective, 'sync_mdns'));

  if (settingsPath) settingsPath.textContent = state.configPath ? `Config path: ${state.configPath}` : 'Config path: n/a';
  if (observerModelHint) {
    const source = hasOwn(config, 'observer_model') ? 'Configured' : 'Default';
    const effectiveModel = observerModelValue || 'n/a';
    observerModelHint.textContent = `${source} model: ${effectiveModel}`;
  }
  if (observerMaxCharsHint) {
    const def = defaults?.observer_max_chars || '';
    observerMaxCharsHint.textContent = def ? `Default: ${def}` : '';
  }
  if (settingsEffective) {
    settingsEffective.textContent = Object.keys(envOverrides).length > 0
      ? 'Effective config differs (env overrides active)'
      : '';
  }
  const overrides = $('settingsOverrides');
  if (overrides) {
    (overrides as any).hidden = Object.keys(envOverrides).length === 0;
  }

  updateAuthSourceVisibility();
  setSettingsTab(settingsActiveTab);

  setDirty(false);
  const settingsStatus = $('settingsStatus');
  if (settingsStatus) settingsStatus.textContent = 'Ready';
}

function parseCommandArgv(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('observer auth command must be a JSON string array');
  }
  return parsed;
}

function parseObserverHeaders(raw: string): Record<string, string> {
  const text = raw.trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('observer headers must be a JSON object');
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== 'string' || !key.trim() || typeof value !== 'string') {
      throw new Error('observer headers must map string keys to string values');
    }
    headers[key.trim()] = value;
  }
  return headers;
}

function updateAuthSourceVisibility() {
  const source = $select('observerAuthSource')?.value || 'auto';
  const fileField = document.getElementById('observerAuthFileField');
  const commandField = document.getElementById('observerAuthCommandField');
  const commandNote = document.getElementById('observerAuthCommandNote');
  if (fileField) fileField.hidden = source !== 'file';
  if (commandField) commandField.hidden = source !== 'command';
  if (commandNote) commandNote.hidden = source !== 'command';
}

function setSettingsTab(tab: string) {
  const next = ['observer', 'queue', 'sync'].includes(tab) ? tab : 'observer';
  settingsActiveTab = next;
  document.querySelectorAll('[data-settings-tab]').forEach((node) => {
    const button = node as HTMLButtonElement;
    const active = button.dataset.settingsTab === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-settings-panel]').forEach((node) => {
    const panel = node as HTMLElement;
    const active = panel.dataset.settingsPanel === next;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

function setDirty(dirty: boolean) {
  state.settingsDirty = dirty;
  const saveBtn = $button('settingsSave');
  if (saveBtn) saveBtn.disabled = !dirty;
}

export function openSettings(stopPolling: () => void) {
  settingsOpen = true;
  previouslyFocused = document.activeElement as HTMLElement | null;
  stopPolling();
  show($('settingsBackdrop'));
  show($('settingsModal'));
  const modal = $('settingsModal') as HTMLElement | null;
  const firstFocusable = getFocusableNodes(modal)[0];
  (firstFocusable || modal)?.focus();
}

export function closeSettings(startPolling: () => void, refreshCallback: () => void) {
  if (state.settingsDirty) {
    if (!globalThis.confirm('Discard unsaved changes?')) return;
  }
  settingsOpen = false;
  hide($('settingsBackdrop'));
  hide($('settingsModal'));
  const restoreTarget = previouslyFocused && typeof previouslyFocused.focus === 'function'
    ? previouslyFocused
    : $button('settingsButton');
  restoreTarget?.focus();
  previouslyFocused = null;
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
    const authCommandInput = (document.getElementById('observerAuthCommand') as HTMLTextAreaElement | null)?.value || '';
    const observerHeadersInput = (document.getElementById('observerHeaders') as HTMLTextAreaElement | null)?.value || '';
    const authCacheTtlInput = ($input('observerAuthCacheTtlS')?.value || '').trim();
    const sweeperIntervalInput = ($input('rawEventsSweeperIntervalS')?.value || '').trim();
    const authCommand = parseCommandArgv(authCommandInput);
    const headers = parseObserverHeaders(observerHeadersInput);
    const authCacheTtl = authCacheTtlInput === '' ? '' : Number(authCacheTtlInput);
    const sweeperIntervalNum = Number(sweeperIntervalInput);
    const sweeperInterval = sweeperIntervalInput === '' ? '' : sweeperIntervalNum;
    if (authCacheTtlInput !== '' && !Number.isFinite(authCacheTtl)) {
      throw new Error('observer auth cache ttl must be a number');
    }
    if (sweeperIntervalInput !== '' && (!Number.isFinite(sweeperIntervalNum) || sweeperIntervalNum <= 0)) {
      throw new Error('raw-event sweeper interval must be a positive number');
    }

    await api.saveConfig({
      observer_provider: $select('observerProvider')?.value || '',
      observer_model: $input('observerModel')?.value || '',
      observer_runtime: $select('observerRuntime')?.value || 'api_http',
      observer_auth_source: $select('observerAuthSource')?.value || 'auto',
      observer_auth_file: $input('observerAuthFile')?.value || '',
      observer_auth_command: authCommand,
      observer_auth_timeout_ms: Number($input('observerAuthTimeoutMs')?.value || 0) || '',
      observer_auth_cache_ttl_s: authCacheTtl,
      observer_headers: headers,
      observer_max_chars: Number($input('observerMaxChars')?.value || 0) || '',
      pack_observation_limit: Number($input('packObservationLimit')?.value || 0) || '',
      pack_session_limit: Number($input('packSessionLimit')?.value || 0) || '',
      raw_events_sweeper_interval_s: sweeperInterval,
      sync_enabled: $input('syncEnabled')?.checked || false,
      sync_host: $input('syncHost')?.value || '',
      sync_port: Number($input('syncPort')?.value || 0) || '',
      sync_interval_s: Number($input('syncInterval')?.value || 0) || '',
      sync_mdns: $input('syncMdns')?.checked || false,
    });
    status.textContent = 'Saved';
    setDirty(false);
    closeSettings(startPolling, refreshCallback);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    status.textContent = `Save failed: ${message}`;
  } finally {
    saveBtn.disabled = !state.settingsDirty;
  }
}

export async function loadConfigData() {
  if (settingsOpen) return;
  try {
    const payload = await api.loadConfig();
    renderConfigModal(payload);
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
    trapModalFocus(e);
    if (e.key === 'Escape' && settingsOpen) closeSettings(startPolling, refreshCallback);
  });

  // Mark dirty on any input change
  const inputs = [
    'observerProvider',
    'observerModel',
    'observerRuntime',
    'observerAuthSource',
    'observerAuthFile',
    'observerAuthCommand',
    'observerAuthTimeoutMs',
    'observerAuthCacheTtlS',
    'observerHeaders',
    'observerMaxChars',
    'packObservationLimit',
    'packSessionLimit',
    'rawEventsSweeperIntervalS',
    'syncEnabled',
    'syncHost',
    'syncPort',
    'syncInterval',
    'syncMdns',
  ];
  inputs.forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => setDirty(true));
    input.addEventListener('change', () => setDirty(true));
  });

  $select('observerAuthSource')?.addEventListener('change', () => updateAuthSourceVisibility());
  document.querySelectorAll('[data-settings-tab]').forEach((node) => {
    node.addEventListener('click', () => {
      const tab = (node as HTMLElement).dataset.settingsTab || 'observer';
      setSettingsTab(tab);
    });
  });
}
