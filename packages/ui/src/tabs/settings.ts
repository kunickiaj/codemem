/* Settings modal — observer config, sync settings. */

import { $, $input, $select, $button, hide, show } from '../lib/dom';
import { hideGlobalNotice, showGlobalNotice } from '../lib/notice';
import { state } from '../lib/state';
import * as api from '../lib/api';

let settingsOpen = false;
let previouslyFocused: HTMLElement | null = null;
let settingsActiveTab = 'observer';
let settingsBaseline: Record<string, unknown> = {};
let settingsEnvOverrides: Record<string, unknown> = {};
let settingsTouchedKeys = new Set<string>();
let helpTooltipEl: HTMLDivElement | null = null;
let helpTooltipAnchor: HTMLElement | null = null;
let helpTooltipBound = false;
const SETTINGS_ADVANCED_KEY = 'codemem-settings-advanced';
let settingsShowAdvanced = loadAdvancedPreference();

const DEFAULT_OPENAI_MODEL = 'gpt-5.1-codex-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-4.5-haiku';
const INPUT_TO_CONFIG_KEY: Record<string, string> = {
  claudeCommand: 'claude_command',
  observerProvider: 'observer_provider',
  observerModel: 'observer_model',
  observerRuntime: 'observer_runtime',
  observerAuthSource: 'observer_auth_source',
  observerAuthFile: 'observer_auth_file',
  observerAuthCommand: 'observer_auth_command',
  observerAuthTimeoutMs: 'observer_auth_timeout_ms',
  observerAuthCacheTtlS: 'observer_auth_cache_ttl_s',
  observerHeaders: 'observer_headers',
  observerMaxChars: 'observer_max_chars',
  packObservationLimit: 'pack_observation_limit',
  packSessionLimit: 'pack_session_limit',
  rawEventsSweeperIntervalS: 'raw_events_sweeper_interval_s',
  syncEnabled: 'sync_enabled',
  syncHost: 'sync_host',
  syncPort: 'sync_port',
  syncInterval: 'sync_interval_s',
  syncMdns: 'sync_mdns',
  syncCoordinatorUrl: 'sync_coordinator_url',
  syncCoordinatorGroup: 'sync_coordinator_group',
  syncCoordinatorTimeout: 'sync_coordinator_timeout_s',
  syncCoordinatorPresenceTtl: 'sync_coordinator_presence_ttl_s',
};

function loadAdvancedPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(SETTINGS_ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistAdvancedPreference(show: boolean) {
  try {
    globalThis.localStorage?.setItem(SETTINGS_ADVANCED_KEY, show ? '1' : '0');
  } catch {}
}

function hasOwn(obj: unknown, key: string): boolean {
  return typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

function effectiveOrConfigured(config: any, effective: any, key: string): any {
  if (hasOwn(effective, key)) return effective[key];
  if (hasOwn(config, key)) return config[key];
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

function isEqualValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeTextValue(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? '' : trimmed;
}

function inferObserverModel(runtime: string, provider: string, configuredModel: string): { model: string; source: string } {
  if (configuredModel) return { model: configuredModel, source: 'Configured' };
  if (runtime === 'claude_sidecar') {
    return { model: DEFAULT_ANTHROPIC_MODEL, source: 'Recommended (local Claude session)' };
  }
  if (provider === 'anthropic') {
    return { model: DEFAULT_ANTHROPIC_MODEL, source: 'Recommended (Anthropic provider)' };
  }
  if (provider === 'opencode') {
    return { model: 'opencode/gpt-5.1-codex-mini', source: 'Recommended (OpenCode Zen provider)' };
  }
  if (provider && provider !== 'openai') {
    return { model: 'provider default', source: 'Recommended (provider default)' };
  }
  return { model: DEFAULT_OPENAI_MODEL, source: 'Recommended (direct API)' };
}

function configuredValueForKey(config: any, key: string): unknown {
  switch (key) {
    case 'claude_command': {
      const value = config?.claude_command;
      if (!Array.isArray(value)) return [];
      const normalized: string[] = [];
      value.forEach((item) => {
        if (typeof item !== 'string') return;
        const token = item.trim();
        if (token) normalized.push(token);
      });
      return normalized;
    }
    case 'observer_provider':
    case 'observer_model':
    case 'observer_auth_file':
    case 'sync_host':
    case 'sync_coordinator_url':
    case 'sync_coordinator_group':
      return normalizeTextValue(asInputString(config?.[key]));
    case 'observer_runtime':
      return normalizeTextValue(asInputString(config?.observer_runtime));
    case 'observer_auth_source':
      return normalizeTextValue(asInputString(config?.observer_auth_source));
    case 'observer_auth_command': {
      const value = config?.observer_auth_command;
      if (!Array.isArray(value)) return [];
      return value.filter((item) => typeof item === 'string');
    }
    case 'observer_headers': {
      const value = config?.observer_headers;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      const headers: Record<string, string> = {};
      Object.entries(value as Record<string, unknown>).forEach(([header, headerValue]) => {
        if (typeof header === 'string' && header.trim() && typeof headerValue === 'string') {
          headers[header.trim()] = headerValue;
        }
      });
      return headers;
    }
    case 'observer_auth_timeout_ms':
    case 'observer_max_chars':
    case 'pack_observation_limit':
    case 'pack_session_limit':
    case 'raw_events_sweeper_interval_s':
    case 'sync_port':
    case 'sync_interval_s': {
      if (!hasOwn(config, key)) return '';
      const parsed = Number(config[key]);
      return Number.isFinite(parsed) && parsed !== 0 ? parsed : '';
    }
    case 'sync_coordinator_timeout_s':
    case 'sync_coordinator_presence_ttl_s': {
      if (!hasOwn(config, key)) return '';
      const parsed = Number(config[key]);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : '';
    }
    case 'observer_auth_cache_ttl_s': {
      if (!hasOwn(config, key)) return '';
      const parsed = Number(config[key]);
      return Number.isFinite(parsed) ? parsed : '';
    }
    case 'sync_enabled':
    case 'sync_mdns':
      return Boolean(config?.[key]);
    default:
      return hasOwn(config, key) ? config[key] : '';
  }
}

function mergeOverrideBaseline(
  baseline: Record<string, unknown>,
  config: any,
  envOverrides: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...baseline };
  Object.keys(envOverrides).forEach((key) => {
    if (hasOwn(next, key)) {
      next[key] = configuredValueForKey(config, key);
    }
  });
  return next;
}

function renderObserverModelHint() {
  const hint = $('observerModelHint');
  if (!hint) return;
  const runtime = ($select('observerRuntime')?.value || 'api_http').trim();
  const provider = ($select('observerProvider')?.value || '').trim();
  const configuredModel = normalizeTextValue($input('observerModel')?.value || '');
  const inferred = inferObserverModel(runtime, provider, configuredModel);
  const overrideActive = ['observer_model', 'observer_provider', 'observer_runtime'].some(
    (key) => hasOwn(settingsEnvOverrides, key),
  );
  const source = overrideActive ? 'Env override' : inferred.source;
  hint.textContent = `${source}: ${inferred.model}`;
}

function setAdvancedVisibility(show: boolean) {
  settingsShowAdvanced = show;
  const toggle = $input('settingsAdvancedToggle') as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = show;
  }
  document.querySelectorAll('.settings-advanced').forEach((node) => {
    const el = node as HTMLElement;
    el.hidden = !show;
  });
}

function ensureHelpTooltipElement(): HTMLDivElement {
  if (helpTooltipEl) return helpTooltipEl;
  const el = document.createElement('div');
  el.className = 'help-tooltip';
  el.hidden = true;
  document.body.appendChild(el);
  helpTooltipEl = el;
  return el;
}

function positionHelpTooltip(anchor: HTMLElement) {
  const el = ensureHelpTooltipElement();
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 8;
  const width = el.offsetWidth;
  const height = el.offsetHeight;

  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, globalThis.innerWidth - width - margin));

  let top = rect.bottom + gap;
  if (top + height > globalThis.innerHeight - margin) {
    top = rect.top - height - gap;
  }
  top = Math.max(margin, top);

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function showHelpTooltip(anchor: HTMLElement) {
  const content = anchor.dataset.tooltip?.trim();
  if (!content) return;
  const el = ensureHelpTooltipElement();
  helpTooltipAnchor = anchor;
  el.textContent = content;
  el.hidden = false;
  requestAnimationFrame(() => {
    positionHelpTooltip(anchor);
    el.classList.add('visible');
  });
}

function hideHelpTooltip() {
  if (!helpTooltipEl) return;
  helpTooltipEl.classList.remove('visible');
  helpTooltipEl.hidden = true;
  helpTooltipAnchor = null;
}

function bindHelpTooltips() {
  if (helpTooltipBound) return;
  helpTooltipBound = true;
  document.querySelectorAll('.help-icon[data-tooltip]').forEach((node) => {
    const button = node as HTMLElement;
    button.addEventListener('mouseenter', () => showHelpTooltip(button));
    button.addEventListener('mouseleave', () => hideHelpTooltip());
    button.addEventListener('focus', () => showHelpTooltip(button));
    button.addEventListener('blur', () => hideHelpTooltip());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (helpTooltipAnchor === button && helpTooltipEl && !helpTooltipEl.hidden) {
        hideHelpTooltip();
        return;
      }
      showHelpTooltip(button);
    });
  });

  globalThis.addEventListener('resize', () => {
    if (helpTooltipAnchor) {
      positionHelpTooltip(helpTooltipAnchor);
    }
  });
  document.addEventListener('scroll', () => {
    if (helpTooltipAnchor) {
      positionHelpTooltip(helpTooltipAnchor);
    }
  }, true);
}

function markFieldTouched(inputId: string) {
  const key = INPUT_TO_CONFIG_KEY[inputId];
  if (!key) return;
  settingsTouchedKeys.add(key);
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

function formatSettingsKey(key: string): string {
  return String(key || '').replace(/_/g, ' ');
}

function joinPhrases(values: string[]): string {
  const items = values.filter((value) => typeof value === 'string' && value.trim());
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function buildSettingsNotice(payload: any): { message: string; type: 'success' | 'warning' } {
  const effects = payload?.effects && typeof payload.effects === 'object' ? payload.effects : {};
  const hotReloaded = Array.isArray(effects.hot_reloaded_keys)
    ? effects.hot_reloaded_keys.map(formatSettingsKey)
    : [];
  const liveApplied = Array.isArray(effects.live_applied_keys)
    ? effects.live_applied_keys.map(formatSettingsKey)
    : [];
  const restartRequired = Array.isArray(effects.restart_required_keys)
    ? effects.restart_required_keys.map(formatSettingsKey)
    : [];
  const warnings = Array.isArray(effects.warnings)
    ? effects.warnings.filter(
        (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : [];
  const manualActions = Array.isArray(effects.manual_actions) ? effects.manual_actions : [];
  const sync = effects.sync && typeof effects.sync === 'object' ? effects.sync : {};
  const lines: string[] = [];

  if (hotReloaded.length) {
    lines.push(`Applied now: ${joinPhrases(hotReloaded)}.`);
  }
  if (liveApplied.length) {
    lines.push(`Live settings updated: ${joinPhrases(liveApplied)}.`);
  }
  if (sync.attempted && typeof sync.message === 'string' && sync.message) {
    lines.push(`Sync: ${sync.message}.`);
  } else if (Array.isArray(sync.affected_keys) && sync.affected_keys.length && typeof sync.reason === 'string' && sync.reason) {
    lines.push(`Sync: ${sync.reason}.`);
  }
  if (restartRequired.length) {
    lines.push(`Restart required for ${joinPhrases(restartRequired)}. Run: codemem serve restart`);
  }
  warnings.forEach((warning) => {
    lines.push(warning);
  });
  manualActions.forEach((action) => {
    if (action && typeof action.command === 'string' && action.command.trim()) {
      lines.push(`If needed: ${action.command}.`);
    }
  });
  if (!lines.length) {
    lines.push('Saved.');
  }

  const hasWarning = restartRequired.length > 0 || warnings.length > 0 || sync.ok === false;
  return { message: lines.join(' '), type: hasWarning ? 'warning' : 'success' };
}

export function renderConfigModal(payload: any) {
  if (!payload || typeof payload !== 'object') return;
  const defaults = payload.defaults || {};
  const config = payload.config || {};
  const effective = payload.effective || {};
  const envOverrides = payload.env_overrides && typeof payload.env_overrides === 'object'
    ? payload.env_overrides
    : {};
  settingsEnvOverrides = envOverrides;
  const providers = toProviderList(payload.providers);
  state.configDefaults = defaults;
  state.configPath = payload.path || '';

  const observerProvider = $select('observerProvider');
  const claudeCommand = document.getElementById('claudeCommand') as HTMLTextAreaElement | null;
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
  const syncCoordinatorUrl = $input('syncCoordinatorUrl');
  const syncCoordinatorGroup = $input('syncCoordinatorGroup');
  const syncCoordinatorTimeout = $input('syncCoordinatorTimeout');
  const syncCoordinatorPresenceTtl = $input('syncCoordinatorPresenceTtl');
  const settingsPath = $('settingsPath');
  const observerModelHint = $('observerModelHint');
  const observerMaxCharsHint = $('observerMaxCharsHint');
  const settingsEffective = $('settingsEffective');

  const observerProviderValue = asInputString(effectiveOrConfigured(config, effective, 'observer_provider'));
  setProviderOptions(observerProvider, providers, observerProviderValue);
  if (claudeCommand) {
    const value = effectiveOrConfigured(config, effective, 'claude_command');
    const argv = Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
    claudeCommand.value = argv.length ? JSON.stringify(argv, null, 2) : '';
  }

  const observerModelValue = asInputString(effectiveOrConfigured(config, effective, 'observer_model'));
  if (observerModel) observerModel.value = observerModelValue;
  if (observerRuntime) observerRuntime.value = asInputString(effectiveOrConfigured(config, effective, 'observer_runtime')) || 'api_http';
  if (observerAuthSource) observerAuthSource.value = asInputString(effectiveOrConfigured(config, effective, 'observer_auth_source')) || 'auto';
  if (observerAuthFile) observerAuthFile.value = asInputString(effectiveOrConfigured(config, effective, 'observer_auth_file'));
  if (observerAuthCommand) {
    const argv = effectiveOrConfigured(config, effective, 'observer_auth_command');
    const command = Array.isArray(argv) ? argv : [];
    const commandStrings = command.filter((item) => typeof item === 'string');
    observerAuthCommand.value = commandStrings.length ? JSON.stringify(commandStrings, null, 2) : '';
  }
  if (observerAuthTimeoutMs) {
    observerAuthTimeoutMs.value = asInputString(effectiveOrConfigured(config, effective, 'observer_auth_timeout_ms'));
  }
  if (observerAuthCacheTtlS) {
    observerAuthCacheTtlS.value = asInputString(effectiveOrConfigured(config, effective, 'observer_auth_cache_ttl_s'));
  }
  if (observerHeaders) {
    const headerValue = effectiveOrConfigured(config, effective, 'observer_headers');
    const headers = headerValue && typeof headerValue === 'object' ? headerValue : {};
    const normalized: Record<string, string> = {};
    Object.entries(headers as Record<string, unknown>).forEach(([key, value]) => {
      if (typeof key === 'string' && key.trim() && typeof value === 'string') {
        normalized[key] = value;
      }
    });
    observerHeaders.value = Object.keys(normalized).length ? JSON.stringify(normalized, null, 2) : '';
  }
  if (observerMaxChars) observerMaxChars.value = asInputString(effectiveOrConfigured(config, effective, 'observer_max_chars'));
  if (packObservationLimit) packObservationLimit.value = asInputString(effectiveOrConfigured(config, effective, 'pack_observation_limit'));
  if (packSessionLimit) packSessionLimit.value = asInputString(effectiveOrConfigured(config, effective, 'pack_session_limit'));
  if (rawEventsSweeperIntervalS) {
    rawEventsSweeperIntervalS.value = asInputString(effectiveOrConfigured(config, effective, 'raw_events_sweeper_interval_s'));
  }
  if (syncEnabled) syncEnabled.checked = Boolean(effectiveOrConfigured(config, effective, 'sync_enabled'));
  if (syncHost) syncHost.value = asInputString(effectiveOrConfigured(config, effective, 'sync_host'));
  if (syncPort) syncPort.value = asInputString(effectiveOrConfigured(config, effective, 'sync_port'));
  if (syncInterval) syncInterval.value = asInputString(effectiveOrConfigured(config, effective, 'sync_interval_s'));
  if (syncMdns) syncMdns.checked = Boolean(effectiveOrConfigured(config, effective, 'sync_mdns'));
  if (syncCoordinatorUrl) syncCoordinatorUrl.value = asInputString(effectiveOrConfigured(config, effective, 'sync_coordinator_url'));
  if (syncCoordinatorGroup) syncCoordinatorGroup.value = asInputString(effectiveOrConfigured(config, effective, 'sync_coordinator_group'));
  if (syncCoordinatorTimeout) syncCoordinatorTimeout.value = asInputString(effectiveOrConfigured(config, effective, 'sync_coordinator_timeout_s'));
  if (syncCoordinatorPresenceTtl) syncCoordinatorPresenceTtl.value = asInputString(effectiveOrConfigured(config, effective, 'sync_coordinator_presence_ttl_s'));

  if (settingsPath) settingsPath.textContent = state.configPath ? `Config path: ${state.configPath}` : 'Config path: n/a';
  if (observerModelHint) renderObserverModelHint();
  if (observerMaxCharsHint) {
    const def = defaults?.observer_max_chars || '';
    observerMaxCharsHint.textContent = def ? `Default: ${def}` : '';
  }
  if (settingsEffective) {
    settingsEffective.textContent = Object.keys(envOverrides).length > 0
      ? 'Some fields are managed by environment settings.'
      : '';
  }
  const overrides = $('settingsOverrides');
  if (overrides) {
    (overrides as any).hidden = Object.keys(envOverrides).length === 0;
  }

  updateAuthSourceVisibility();
  setAdvancedVisibility(settingsShowAdvanced);
  setSettingsTab(settingsActiveTab);
  settingsTouchedKeys = new Set<string>();
  try {
    const baseline = collectSettingsPayload();
    settingsBaseline = mergeOverrideBaseline(baseline, config, envOverrides);
  } catch {
    settingsBaseline = {};
  }

  setDirty(false);
  const settingsStatus = $('settingsStatus');
  if (settingsStatus) settingsStatus.textContent = 'Ready';
}

function parseCommandArgv(raw: string, options: { label: string; normalize?: boolean; requireNonEmpty?: boolean }): string[] {
  const text = raw.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${options.label} must be a JSON string array`);
  }
  if (!options.normalize && !options.requireNonEmpty) {
    return parsed;
  }
  const values = options.normalize ? parsed.map((item) => item.trim()) : parsed;
  if (options.requireNonEmpty && values.some((item) => item.trim() === '')) {
    throw new Error(`${options.label} cannot contain empty command tokens`);
  }
  return values;
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

function collectSettingsPayload(options: { allowUntouchedParseErrors?: boolean } = {}): Record<string, unknown> {
  const allowUntouchedParseErrors = options.allowUntouchedParseErrors === true;
  const claudeCommandInput = (document.getElementById('claudeCommand') as HTMLTextAreaElement | null)?.value || '';
  const authCommandInput = (document.getElementById('observerAuthCommand') as HTMLTextAreaElement | null)?.value || '';
  const observerHeadersInput = (document.getElementById('observerHeaders') as HTMLTextAreaElement | null)?.value || '';
  const authCacheTtlInput = ($input('observerAuthCacheTtlS')?.value || '').trim();
  const sweeperIntervalInput = ($input('rawEventsSweeperIntervalS')?.value || '').trim();
  let claudeCommand: string[] = [];
  try {
    claudeCommand = parseCommandArgv(claudeCommandInput, {
      label: 'claude command',
      normalize: true,
      requireNonEmpty: true,
    });
  } catch (error) {
    if (!allowUntouchedParseErrors || settingsTouchedKeys.has('claude_command')) {
      throw error;
    }
    const baseline = settingsBaseline.claude_command;
    claudeCommand = Array.isArray(baseline)
      ? baseline
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
  }
  let authCommand: string[] = [];
  try {
    authCommand = parseCommandArgv(authCommandInput, { label: 'observer auth command' });
  } catch (error) {
    if (!allowUntouchedParseErrors || settingsTouchedKeys.has('observer_auth_command')) {
      throw error;
    }
    const baseline = settingsBaseline.observer_auth_command;
    authCommand = Array.isArray(baseline)
      ? baseline.filter((item): item is string => typeof item === 'string')
      : [];
  }
  let headers: Record<string, string> = {};
  try {
    headers = parseObserverHeaders(observerHeadersInput);
  } catch (error) {
    if (!allowUntouchedParseErrors || settingsTouchedKeys.has('observer_headers')) {
      throw error;
    }
    const baseline = settingsBaseline.observer_headers;
    if (baseline && typeof baseline === 'object' && !Array.isArray(baseline)) {
      Object.entries(baseline as Record<string, unknown>).forEach(([key, value]) => {
        if (typeof key === 'string' && key.trim() && typeof value === 'string') {
          headers[key] = value;
        }
      });
    }
  }
  const authCacheTtl = authCacheTtlInput === '' ? '' : Number(authCacheTtlInput);
  const sweeperIntervalNum = Number(sweeperIntervalInput);
  const sweeperInterval = sweeperIntervalInput === '' ? '' : sweeperIntervalNum;

  if (authCacheTtlInput !== '' && !Number.isFinite(authCacheTtl)) {
    throw new Error('observer auth cache ttl must be a number');
  }
  if (sweeperIntervalInput !== '' && (!Number.isFinite(sweeperIntervalNum) || sweeperIntervalNum <= 0)) {
    throw new Error('raw-event sweeper interval must be a positive number');
  }

  return {
    claude_command: claudeCommand,
    observer_provider: normalizeTextValue($select('observerProvider')?.value || ''),
    observer_model: normalizeTextValue($input('observerModel')?.value || ''),
    observer_runtime: normalizeTextValue($select('observerRuntime')?.value || 'api_http') || 'api_http',
    observer_auth_source: normalizeTextValue($select('observerAuthSource')?.value || 'auto') || 'auto',
    observer_auth_file: normalizeTextValue($input('observerAuthFile')?.value || ''),
    observer_auth_command: authCommand,
    observer_auth_timeout_ms: Number($input('observerAuthTimeoutMs')?.value || 0) || '',
    observer_auth_cache_ttl_s: authCacheTtl,
    observer_headers: headers,
    observer_max_chars: Number($input('observerMaxChars')?.value || 0) || '',
    pack_observation_limit: Number($input('packObservationLimit')?.value || 0) || '',
    pack_session_limit: Number($input('packSessionLimit')?.value || 0) || '',
    raw_events_sweeper_interval_s: sweeperInterval,
    sync_enabled: $input('syncEnabled')?.checked || false,
    sync_host: normalizeTextValue($input('syncHost')?.value || ''),
    sync_port: Number($input('syncPort')?.value || 0) || '',
    sync_interval_s: Number($input('syncInterval')?.value || 0) || '',
    sync_mdns: $input('syncMdns')?.checked || false,
    sync_coordinator_url: normalizeTextValue($input('syncCoordinatorUrl')?.value || ''),
    sync_coordinator_group: normalizeTextValue($input('syncCoordinatorGroup')?.value || ''),
    sync_coordinator_timeout_s: Number($input('syncCoordinatorTimeout')?.value || 0) || '',
    sync_coordinator_presence_ttl_s: Number($input('syncCoordinatorPresenceTtl')?.value || 0) || '',
  };
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
  hideHelpTooltip();
  const restoreTarget = previouslyFocused && typeof previouslyFocused.focus === 'function'
    ? previouslyFocused
    : $button('settingsButton');
  restoreTarget?.focus();
  previouslyFocused = null;
  settingsTouchedKeys = new Set<string>();
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
    const current = collectSettingsPayload({ allowUntouchedParseErrors: true });
    const changed: Record<string, unknown> = {};
    Object.entries(current).forEach(([key, value]) => {
      if (hasOwn(settingsEnvOverrides, key) && !settingsTouchedKeys.has(key)) {
        return;
      }
      if (!isEqualValue(value, settingsBaseline[key])) {
        changed[key] = value;
      }
    });
    if (Object.keys(changed).length === 0) {
      status.textContent = 'No changes';
      setDirty(false);
      closeSettings(startPolling, refreshCallback);
      return;
    }

    const result = await api.saveConfig(changed);
    const notice = buildSettingsNotice(result);
    status.textContent = 'Saved';
    setDirty(false);
    closeSettings(startPolling, refreshCallback);
    showGlobalNotice(notice.message, notice.type);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    status.textContent = `Save failed: ${message}`;
  } finally {
    saveBtn.disabled = !state.settingsDirty;
  }
}

function formatAuthMethod(method: string): string {
  switch (method) {
    case 'anthropic_consumer':
      return 'OAuth (Claude Max/Pro)';
    case 'codex_consumer':
      return 'OAuth (ChatGPT subscription)';
    case 'sdk_client':
      return 'API key';
    case 'claude_sidecar':
      return 'Local Claude session';
    case 'opencode_run':
      return 'OpenCode sidecar';
    default:
      return method || 'none';
  }
}

function formatCredentialSources(creds: Record<string, boolean>): string {
  const parts: string[] = [];
  if (creds.oauth) parts.push('OAuth');
  if (creds.api_key) parts.push('API key');
  if (creds.env_var) parts.push('env var');
  return parts.length ? parts.join(', ') : 'none';
}

function createEl(tag: string, className?: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function formatFailureTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Unknown time';
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) return value;
  return ts.toLocaleString();
}

function renderObserverStatusBanner(status: any) {
  const banner = $('observerStatusBanner');
  if (!banner) return;

  if (!status || typeof status !== 'object') {
    banner.hidden = true;
    return;
  }

  banner.textContent = '';
  const active = status.active;
  const available = status.available_credentials || {};

  if (active) {
    const provider = String(active.provider || 'unknown');
    const model = String(active.model || '');
    const method = formatAuthMethod(active.auth?.method || 'none');
    const tokenOk = active.auth?.token_present === true;

    banner.append(createEl('div', 'status-label', 'Active observer'));
    const row = createEl('div', 'status-active');
    row.textContent = `${provider} \u2192 ${model} via ${method} `;
    const tokenSpan = createEl('span', tokenOk ? 'cred-ok' : 'cred-none', tokenOk ? '\u2713' : '\u2717');
    row.append(tokenSpan);
    banner.append(row);
  } else {
    banner.append(createEl('div', 'status-label', 'Observer status'));
    banner.append(createEl('div', 'status-active', 'Not yet initialized (waiting for first session)'));
  }

  const credEntries = Object.entries(available).filter(
    ([, creds]) => creds && typeof creds === 'object',
  );
  if (credEntries.length) {
    banner.append(createEl('div', 'status-label', 'Available credentials'));
    const row = createEl('div');
    credEntries.forEach(([provider, creds], idx) => {
      const c = creds as Record<string, boolean>;
      const sources = formatCredentialSources(c);
      const hasAny = Object.values(c).some(Boolean);
      const span = createEl('span', 'status-cred');
      const icon = createEl('span', hasAny ? 'cred-ok' : 'cred-none', hasAny ? '\u2713' : '\u2013');
      span.append(icon);
      span.append(` ${String(provider)}: ${sources}`);
      if (idx > 0) row.append(' \u00b7 ');
      row.append(span);
    });
    banner.append(row);
  }

  const failure = status.latest_failure;
  if (failure && typeof failure === 'object') {
    banner.append(createEl('div', 'status-label', 'Latest processing issue'));
    const box = createEl('div', 'status-issue');
    const message = typeof failure.error_message === 'string' && failure.error_message.trim()
      ? failure.error_message.trim()
      : 'Raw-event processing failed.';
    box.append(createEl('div', 'status-issue-message', message));

    const detailParts: string[] = [];
    const provider = typeof failure.observer_provider === 'string' ? failure.observer_provider.trim() : '';
    const model = typeof failure.observer_model === 'string' ? failure.observer_model.trim() : '';
    const runtime = typeof failure.observer_runtime === 'string' ? failure.observer_runtime.trim() : '';
    if (provider || model || runtime) {
      const flow = [provider || 'observer', model ? `→ ${model}` : '', runtime ? `(${runtime})` : '']
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (flow) detailParts.push(flow);
    }
    const failedAt = formatFailureTimestamp(failure.updated_at);
    if (failedAt) detailParts.push(`Last failure ${failedAt}`);
    if (typeof failure.attempt_count === 'number' && Number.isFinite(failure.attempt_count)) {
      detailParts.push(`Attempts ${failure.attempt_count}`);
    }
    if (detailParts.length) {
      box.append(createEl('div', 'status-issue-meta', detailParts.join(' · ')));
    }

    const impact = typeof failure.impact === 'string' ? failure.impact.trim() : '';
    if (impact) {
      box.append(createEl('div', 'status-issue-impact', impact));
    }
    banner.append(box);
  }

  banner.hidden = false;
}

export async function loadConfigData() {
  if (settingsOpen) return;
  try {
    const [payload, status] = await Promise.all([
      api.loadConfig(),
      api.loadObserverStatus().catch(() => null),
    ]);
    renderConfigModal(payload);
    renderObserverStatusBanner(status);
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
  bindHelpTooltips();

  document.addEventListener('keydown', (e) => {
    trapModalFocus(e);
    if (e.key === 'Escape' && settingsOpen) closeSettings(startPolling, refreshCallback);
  });

  // Mark dirty on any input change
  const inputs = [
    'claudeCommand',
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
    'syncCoordinatorUrl',
    'syncCoordinatorGroup',
    'syncCoordinatorTimeout',
    'syncCoordinatorPresenceTtl',
  ];
  inputs.forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => {
      markFieldTouched(id);
      setDirty(true);
    });
    input.addEventListener('change', () => {
      markFieldTouched(id);
      setDirty(true);
    });
  });

  $select('observerAuthSource')?.addEventListener('change', () => updateAuthSourceVisibility());
  $select('observerProvider')?.addEventListener('change', () => renderObserverModelHint());
  $select('observerRuntime')?.addEventListener('change', () => renderObserverModelHint());
  $input('observerModel')?.addEventListener('input', () => renderObserverModelHint());
  $input('settingsAdvancedToggle')?.addEventListener('change', () => {
    const checked = Boolean($input('settingsAdvancedToggle')?.checked);
    setAdvancedVisibility(checked);
    persistAdvancedPreference(checked);
  });
  document.querySelectorAll('[data-settings-tab]').forEach((node) => {
    node.addEventListener('click', () => {
      const tab = (node as HTMLElement).dataset.settingsTab || 'observer';
      setSettingsTab(tab);
    });
  });
}
