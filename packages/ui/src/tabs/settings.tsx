/* Settings modal — observer config, sync settings. */

import { render, type ComponentChildren, type JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { $, $button } from '../lib/dom';
import { showGlobalNotice } from '../lib/notice';
import { state } from '../lib/state';
import { RadixDialog } from '../components/primitives/radix-dialog';
import * as api from '../lib/api';

let settingsOpen = false;
let previouslyFocused: HTMLElement | null = null;
let settingsActiveTab = 'observer';
let settingsBaseline: Record<string, unknown> = {};
let settingsEnvOverrides: Record<string, unknown> = {};
let settingsTouchedKeys = new Set<string>();
let settingsShellMounted = false;
let settingsProtectedKeys = new Set<string>();
let settingsStartPolling: (() => void) | null = null;
let settingsRefresh: (() => void) | null = null;
const SETTINGS_ADVANCED_KEY = 'codemem-settings-advanced';
let settingsShowAdvanced = loadAdvancedPreference();

const DEFAULT_OPENAI_MODEL = 'gpt-5.1-codex-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-4.5-haiku';

type SettingsTabId = 'observer' | 'queue' | 'sync';

type SettingsFormState = {
  claudeCommand: string;
  observerProvider: string;
  observerModel: string;
  observerRuntime: string;
  observerAuthSource: string;
  observerAuthFile: string;
  observerAuthCommand: string;
  observerAuthTimeoutMs: string;
  observerAuthCacheTtlS: string;
  observerHeaders: string;
  observerMaxChars: string;
  packObservationLimit: string;
  packSessionLimit: string;
  rawEventsSweeperIntervalS: string;
  syncEnabled: boolean;
  syncHost: string;
  syncPort: string;
  syncInterval: string;
  syncMdns: boolean;
  syncCoordinatorUrl: string;
  syncCoordinatorGroup: string;
  syncCoordinatorTimeout: string;
  syncCoordinatorPresenceTtl: string;
};

type SettingsRenderState = {
  effectiveText: string;
  isSaving: boolean;
  observerStatus: unknown;
  overridesVisible: boolean;
  pathText: string;
  providers: string[];
  statusText: string;
  values: SettingsFormState;
};

type SettingsTooltipState = {
  anchor: HTMLElement | null;
  content: string;
  visible: boolean;
};

type SettingsController = {
  hideTooltip: () => void;
  setActiveTab: (tab: SettingsTabId) => void;
  setDirty: (dirty: boolean) => void;
  setOpen: (open: boolean) => void;
  setRenderState: (patch: Partial<SettingsRenderState>) => void;
  setShowAdvanced: (show: boolean) => void;
};

let settingsController: SettingsController | null = null;

const INPUT_TO_CONFIG_KEY: Record<keyof SettingsFormState, string> = {
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

const PROTECTED_VIEWER_CONFIG_KEYS = new Set([
  'claude_command',
  'observer_base_url',
  'observer_auth_file',
  'observer_auth_command',
  'observer_headers',
  'sync_coordinator_url',
]);

const EMPTY_FORM_STATE: SettingsFormState = {
  claudeCommand: '',
  observerProvider: '',
  observerModel: '',
  observerRuntime: 'api_http',
  observerAuthSource: 'auto',
  observerAuthFile: '',
  observerAuthCommand: '',
  observerAuthTimeoutMs: '',
  observerAuthCacheTtlS: '',
  observerHeaders: '',
  observerMaxChars: '',
  packObservationLimit: '',
  packSessionLimit: '',
  rawEventsSweeperIntervalS: '',
  syncEnabled: false,
  syncHost: '',
  syncPort: '',
  syncInterval: '',
  syncMdns: false,
  syncCoordinatorUrl: '',
  syncCoordinatorGroup: '',
  syncCoordinatorTimeout: '',
  syncCoordinatorPresenceTtl: '',
};

let settingsRenderState: SettingsRenderState = {
  effectiveText: '',
  isSaving: false,
  observerStatus: null,
  overridesVisible: false,
  pathText: 'Config path: n/a',
  providers: [],
  statusText: 'Ready',
  values: { ...EMPTY_FORM_STATE },
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
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
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

function getObserverModelHint(): string {
  const values = settingsRenderState.values;
  const inferred = inferObserverModel(
    values.observerRuntime.trim() || 'api_http',
    values.observerProvider.trim(),
    normalizeTextValue(values.observerModel),
  );
  const overrideActive = ['observer_model', 'observer_provider', 'observer_runtime'].some(
    (key) => hasOwn(settingsEnvOverrides, key),
  );
  const source = overrideActive ? 'Env override' : inferred.source;
  return `${source}: ${inferred.model}`;
}

function positionHelpTooltipElement(el: HTMLElement, anchor: HTMLElement) {
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

function hideHelpTooltip() {
  settingsController?.hideTooltip();
}

function helpButtonFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest('.help-icon[data-tooltip]') as HTMLElement | null;
}

function markFieldTouched(inputId: keyof SettingsFormState) {
  const key = INPUT_TO_CONFIG_KEY[inputId];
  if (!key) return;
  settingsTouchedKeys.add(key);
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

function focusSettingsDialog() {
  const modal = $('settingsModal');
  const focusable = getFocusableNodes(modal as HTMLElement | null);
  const firstFocusable = focusable[0];
  (firstFocusable || (modal as HTMLElement | null))?.focus();
}

function updateRenderState(patch: Partial<SettingsRenderState>) {
  if (settingsController) {
    settingsController.setRenderState(patch);
    return;
  }
  settingsRenderState = {
    ...settingsRenderState,
    ...patch,
  };
}

function updateFormState(patch: Partial<SettingsFormState>) {
  updateRenderState({
    values: {
      ...settingsRenderState.values,
      ...patch,
    },
  });
}

function renderSettingsShell() {
  const mount = $('settingsDialogMount');
  if (!mount) return;
  render(<SettingsDialogShell />, mount);
}

function ensureSettingsShell() {
  const mount = $('settingsDialogMount');
  if (!mount) return;
  if (settingsShellMounted) return;
  renderSettingsShell();
  settingsShellMounted = true;
}

function SettingsDialogShell() {
  const [open, setOpen] = useState(settingsOpen);
  const [activeTab, setActiveTabState] = useState<SettingsTabId>(
    ['observer', 'queue', 'sync'].includes(settingsActiveTab) ? (settingsActiveTab as SettingsTabId) : 'observer',
  );
  const [dirty, setDirtyState] = useState(state.settingsDirty);
  const [renderState, setRenderStateState] = useState(settingsRenderState);
  const [showAdvanced, setShowAdvancedState] = useState(settingsShowAdvanced);
  const [tooltip, setTooltip] = useState<SettingsTooltipState>({
    anchor: null,
    content: '',
    visible: false,
  });
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  settingsOpen = open;
  settingsActiveTab = activeTab;
  state.settingsDirty = dirty;
  settingsRenderState = renderState;
  settingsShowAdvanced = showAdvanced;

  useEffect(() => {
    settingsController = {
      hideTooltip: () => {
        setTooltip({ anchor: null, content: '', visible: false });
      },
      setActiveTab: (tab) => {
        const nextTab = ['observer', 'queue', 'sync'].includes(tab) ? tab : 'observer';
        settingsActiveTab = nextTab;
        setActiveTabState(nextTab);
      },
      setDirty: (nextDirty) => {
        state.settingsDirty = nextDirty;
        setDirtyState(nextDirty);
      },
      setOpen: (nextOpen) => {
        settingsOpen = nextOpen;
        setOpen(nextOpen);
      },
      setRenderState: (patch) => {
        const nextState = {
          ...settingsRenderState,
          ...patch,
        };
        settingsRenderState = nextState;
        setRenderStateState(nextState);
      },
      setShowAdvanced: (nextShowAdvanced) => {
        settingsShowAdvanced = nextShowAdvanced;
        persistAdvancedPreference(nextShowAdvanced);
        setShowAdvancedState(nextShowAdvanced);
      },
    };

    return () => {
      if (settingsController) {
        settingsController = null;
      }
    };
  }, []);

  useEffect(() => {
    const showTooltip = (anchor: HTMLElement) => {
      const content = anchor.dataset.tooltip?.trim();
      if (!content) return;
      setTooltip({ anchor, content, visible: true });
    };

    const hideTooltip = () => {
      setTooltip((current) => {
        if (!current.visible && !current.anchor && !current.content) return current;
        return { anchor: null, content: '', visible: false };
      });
    };

    const onPointerOver = (event: Event) => {
      const button = helpButtonFromTarget(event.target);
      if (!button) return;
      showTooltip(button);
    };

    const onPointerOut = (event: Event) => {
      const button = helpButtonFromTarget(event.target);
      if (!button) return;
      const related = (event as PointerEvent).relatedTarget;
      if (related instanceof Element && button.contains(related)) return;
      hideTooltip();
    };

    const onFocusIn = (event: Event) => {
      const button = helpButtonFromTarget(event.target);
      if (!button) return;
      showTooltip(button);
    };

    const onFocusOut = (event: Event) => {
      const button = helpButtonFromTarget(event.target);
      if (!button) return;
      hideTooltip();
    };

    const onClick = (event: Event) => {
      const button = helpButtonFromTarget(event.target);
      if (!button) return;
      event.preventDefault();
      setTooltip((current) => {
        if (current.anchor === button && current.visible) {
          return { anchor: null, content: '', visible: false };
        }
        const content = button.dataset.tooltip?.trim() || '';
        if (!content) return current;
        return { anchor: button, content, visible: true };
      });
    };

    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('click', onClick);

    return () => {
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('click', onClick);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tooltip.visible || !tooltip.anchor || !tooltipRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (tooltipRef.current && tooltip.anchor) {
        positionHelpTooltipElement(tooltipRef.current, tooltip.anchor);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [tooltip.anchor, tooltip.content, tooltip.visible]);

  useEffect(() => {
    if (!tooltip.visible || !tooltip.anchor) return;
    const reposition = () => {
      if (tooltipRef.current && tooltip.anchor) {
        positionHelpTooltipElement(tooltipRef.current, tooltip.anchor);
      }
    };
    globalThis.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    return () => {
      globalThis.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
    };
  }, [tooltip.anchor, tooltip.visible]);

  const tooltipPortal = useMemo(() => {
    if (typeof document === 'undefined') return null;
    return createPortal(
      <div
        className={`help-tooltip${tooltip.visible ? ' visible' : ''}`}
        hidden={!tooltip.visible}
        ref={tooltipRef}
      >
        {tooltip.content}
      </div>,
      document.body,
    );
  }, [tooltip.content, tooltip.visible]);

  const close = useCallback(() => {
    if (settingsStartPolling && settingsRefresh) {
      closeSettings(settingsStartPolling, settingsRefresh);
    }
  }, []);

  return (
    <>
      <RadixDialog
        ariaDescribedby="settingsDescription"
        ariaLabelledby="settingsTitle"
        contentClassName="modal"
        contentId="settingsModal"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusSettingsDialog();
        }}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setOpen(true);
            return;
          }
          close();
        }}
        open={open}
        overlayClassName="modal-backdrop"
        overlayId="settingsBackdrop"
      >
        <SettingsDialogContent />
      </RadixDialog>
      {tooltipPortal}
    </>
  );
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
  } else if (
    Array.isArray(sync.affected_keys) &&
    sync.affected_keys.length &&
    typeof sync.reason === 'string' &&
    sync.reason
  ) {
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

function isProtectedConfigKey(key: string): boolean {
  return settingsProtectedKeys.has(key) || PROTECTED_VIEWER_CONFIG_KEYS.has(key);
}

function protectedConfigHelp(key: string): string {
  return `${key} is read-only in the viewer for security. Edit the config file or environment instead.`;
}

function formStateFromPayload(payload: any): SettingsFormState {
  const config = payload.config || {};
  const effective = payload.effective || {};
  const observerHeadersValue = effectiveOrConfigured(config, effective, 'observer_headers');
  const observerHeaders =
    observerHeadersValue && typeof observerHeadersValue === 'object' && !Array.isArray(observerHeadersValue)
      ? Object.fromEntries(
          Object.entries(observerHeadersValue as Record<string, unknown>).filter(
            ([key, value]) => typeof key === 'string' && key.trim() && typeof value === 'string',
          ),
        )
      : {};
  const claudeCommandValue = effectiveOrConfigured(config, effective, 'claude_command');
  const claudeCommand = Array.isArray(claudeCommandValue)
    ? claudeCommandValue.filter((item): item is string => typeof item === 'string')
    : [];
  const authCommandValue = effectiveOrConfigured(config, effective, 'observer_auth_command');
  const authCommand = Array.isArray(authCommandValue)
    ? authCommandValue.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    claudeCommand: claudeCommand.length ? JSON.stringify(claudeCommand, null, 2) : '',
    observerProvider: asInputString(effectiveOrConfigured(config, effective, 'observer_provider')),
    observerModel: asInputString(effectiveOrConfigured(config, effective, 'observer_model')),
    observerRuntime: asInputString(effectiveOrConfigured(config, effective, 'observer_runtime')) || 'api_http',
    observerAuthSource:
      asInputString(effectiveOrConfigured(config, effective, 'observer_auth_source')) || 'auto',
    observerAuthFile: asInputString(effectiveOrConfigured(config, effective, 'observer_auth_file')),
    observerAuthCommand: authCommand.length ? JSON.stringify(authCommand, null, 2) : '',
    observerAuthTimeoutMs: asInputString(
      effectiveOrConfigured(config, effective, 'observer_auth_timeout_ms'),
    ),
    observerAuthCacheTtlS: asInputString(
      effectiveOrConfigured(config, effective, 'observer_auth_cache_ttl_s'),
    ),
    observerHeaders: Object.keys(observerHeaders).length ? JSON.stringify(observerHeaders, null, 2) : '',
    observerMaxChars: asInputString(effectiveOrConfigured(config, effective, 'observer_max_chars')),
    packObservationLimit: asInputString(
      effectiveOrConfigured(config, effective, 'pack_observation_limit'),
    ),
    packSessionLimit: asInputString(effectiveOrConfigured(config, effective, 'pack_session_limit')),
    rawEventsSweeperIntervalS: asInputString(
      effectiveOrConfigured(config, effective, 'raw_events_sweeper_interval_s'),
    ),
    syncEnabled: Boolean(effectiveOrConfigured(config, effective, 'sync_enabled')),
    syncHost: asInputString(effectiveOrConfigured(config, effective, 'sync_host')),
    syncPort: asInputString(effectiveOrConfigured(config, effective, 'sync_port')),
    syncInterval: asInputString(effectiveOrConfigured(config, effective, 'sync_interval_s')),
    syncMdns: Boolean(effectiveOrConfigured(config, effective, 'sync_mdns')),
    syncCoordinatorUrl: asInputString(effectiveOrConfigured(config, effective, 'sync_coordinator_url')),
    syncCoordinatorGroup: asInputString(
      effectiveOrConfigured(config, effective, 'sync_coordinator_group'),
    ),
    syncCoordinatorTimeout: asInputString(
      effectiveOrConfigured(config, effective, 'sync_coordinator_timeout_s'),
    ),
    syncCoordinatorPresenceTtl: asInputString(
      effectiveOrConfigured(config, effective, 'sync_coordinator_presence_ttl_s'),
    ),
  };
}

export function renderConfigModal(payload: any) {
  if (!payload || typeof payload !== 'object') return;
  const defaults = payload.defaults || {};
  const config = payload.config || {};
  const envOverrides =
    payload.env_overrides && typeof payload.env_overrides === 'object' ? payload.env_overrides : {};
  const protectedKeys = Array.isArray(payload.protected_keys)
    ? payload.protected_keys.filter(
        (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : [];
  const values = formStateFromPayload(payload);

  settingsEnvOverrides = envOverrides;
  settingsProtectedKeys = new Set(protectedKeys);
  state.configDefaults = defaults;
  state.configPath = payload.path || '';

  updateRenderState({
    effectiveText:
      Object.keys(envOverrides).length > 0 ? 'Some fields are managed by environment settings.' : '',
    overridesVisible: Object.keys(envOverrides).length > 0,
    pathText: state.configPath ? `Config path: ${state.configPath}` : 'Config path: n/a',
    providers: toProviderList(payload.providers),
    statusText: 'Ready',
    values,
  });

  settingsTouchedKeys = new Set<string>();
  try {
    const baseline = collectSettingsPayload({ allowUntouchedParseErrors: true });
    settingsBaseline = mergeOverrideBaseline(baseline, config, envOverrides);
  } catch {
    settingsBaseline = {};
  }

  setDirty(false);
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
  const values = settingsRenderState.values;
  let claudeCommand: string[] = [];
  try {
    claudeCommand = parseCommandArgv(values.claudeCommand, {
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
    authCommand = parseCommandArgv(values.observerAuthCommand, { label: 'observer auth command' });
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
    headers = parseObserverHeaders(values.observerHeaders);
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

  const authCacheTtlInput = values.observerAuthCacheTtlS.trim();
  const sweeperIntervalInput = values.rawEventsSweeperIntervalS.trim();
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
    observer_provider: normalizeTextValue(values.observerProvider),
    observer_model: normalizeTextValue(values.observerModel),
    observer_runtime: normalizeTextValue(values.observerRuntime || 'api_http') || 'api_http',
    observer_auth_source: normalizeTextValue(values.observerAuthSource || 'auto') || 'auto',
    observer_auth_file: normalizeTextValue(values.observerAuthFile),
    observer_auth_command: authCommand,
    observer_auth_timeout_ms: Number(values.observerAuthTimeoutMs || 0) || '',
    observer_auth_cache_ttl_s: authCacheTtl,
    observer_headers: headers,
    observer_max_chars: Number(values.observerMaxChars || 0) || '',
    pack_observation_limit: Number(values.packObservationLimit || 0) || '',
    pack_session_limit: Number(values.packSessionLimit || 0) || '',
    raw_events_sweeper_interval_s: sweeperInterval,
    sync_enabled: values.syncEnabled,
    sync_host: normalizeTextValue(values.syncHost),
    sync_port: Number(values.syncPort || 0) || '',
    sync_interval_s: Number(values.syncInterval || 0) || '',
    sync_mdns: values.syncMdns,
    sync_coordinator_url: normalizeTextValue(values.syncCoordinatorUrl),
    sync_coordinator_group: normalizeTextValue(values.syncCoordinatorGroup),
    sync_coordinator_timeout_s: Number(values.syncCoordinatorTimeout || 0) || '',
    sync_coordinator_presence_ttl_s: Number(values.syncCoordinatorPresenceTtl || 0) || '',
  };
}

function setSettingsTab(tab: string) {
  const nextTab = ['observer', 'queue', 'sync'].includes(tab) ? (tab as SettingsTabId) : 'observer';
  settingsActiveTab = nextTab;
  settingsController?.setActiveTab(nextTab);
}

function setDirty(dirty: boolean, rerender = true) {
  state.settingsDirty = dirty;
  if (rerender) settingsController?.setDirty(dirty);
}

export function openSettings(stopPolling: () => void) {
  if (!settingsShellMounted) {
    ensureSettingsShell();
  }
  settingsOpen = true;
  previouslyFocused = document.activeElement as HTMLElement | null;
  stopPolling();
  settingsController?.setOpen(true);
}

export function closeSettings(startPolling: () => void, refreshCallback: () => void) {
  if (state.settingsDirty) {
    if (!globalThis.confirm('Discard unsaved changes?')) {
      settingsController?.setOpen(true);
      return;
    }
  }
  settingsOpen = false;
  settingsController?.setOpen(false);
  hideHelpTooltip();
  const restoreTarget =
    previouslyFocused && typeof previouslyFocused.focus === 'function'
      ? previouslyFocused
      : $button('settingsButton');
  restoreTarget?.focus();
  previouslyFocused = null;
  settingsTouchedKeys = new Set<string>();
  startPolling();
  refreshCallback();
}

export async function saveSettings(startPolling: () => void, refreshCallback: () => void) {
  if (settingsRenderState.isSaving) return;
  updateRenderState({ isSaving: true, statusText: 'Saving...' });

  try {
    const current = collectSettingsPayload({ allowUntouchedParseErrors: true });
    const changed: Record<string, unknown> = {};
    Object.entries(current).forEach(([key, value]) => {
      if (isProtectedConfigKey(key)) {
        return;
      }
      if (hasOwn(settingsEnvOverrides, key) && !settingsTouchedKeys.has(key)) {
        return;
      }
      if (!isEqualValue(value, settingsBaseline[key])) {
        changed[key] = value;
      }
    });
    if (Object.keys(changed).length === 0) {
      updateRenderState({ isSaving: false, statusText: 'No changes' });
      setDirty(false);
      closeSettings(startPolling, refreshCallback);
      return;
    }

    const result = await api.saveConfig(changed);
    const notice = buildSettingsNotice(result);
    updateRenderState({ isSaving: false, statusText: 'Saved' });
    setDirty(false);
    closeSettings(startPolling, refreshCallback);
    showGlobalNotice(notice.message, notice.type);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    updateRenderState({ isSaving: false, statusText: `Save failed: ${message}` });
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

function formatFailureTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Unknown time';
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) return value;
  return ts.toLocaleString();
}

function renderObserverStatusBanner(status: any) {
  updateRenderState({ observerStatus: status && typeof status === 'object' ? status : null });
}

export async function loadConfigData() {
  if (settingsOpen) return;
  try {
    const [payload, status] = await Promise.all([api.loadConfig(), api.loadObserverStatus().catch(() => null)]);
    renderConfigModal(payload);
    renderObserverStatusBanner(status);
  } catch {}
}

function updateField<K extends keyof SettingsFormState>(field: K, value: SettingsFormState[K]) {
  markFieldTouched(field);
  updateFormState({ [field]: value } as Partial<SettingsFormState>);
  setDirty(true);
}

function onTextInput<K extends keyof SettingsFormState>(field: K) {
  return (event: JSX.TargetedEvent<HTMLInputElement | HTMLTextAreaElement, Event>) => {
    updateField(field, event.currentTarget.value as SettingsFormState[K]);
  };
}

function onSelectInput<K extends keyof SettingsFormState>(field: K) {
  return (event: JSX.TargetedEvent<HTMLSelectElement, Event>) => {
    updateField(field, event.currentTarget.value as SettingsFormState[K]);
  };
}

function onCheckboxInput<K extends keyof SettingsFormState>(field: K) {
  return (event: JSX.TargetedEvent<HTMLInputElement, Event>) => {
    updateField(field, event.currentTarget.checked as SettingsFormState[K]);
  };
}

function onAdvancedToggle(event: JSX.TargetedEvent<HTMLInputElement, Event>) {
  const checked = event.currentTarget.checked;
  settingsShowAdvanced = checked;
  settingsController?.setShowAdvanced(checked);
}

function tabButtonClass(tab: SettingsTabId): string {
  return `settings-tab${settingsActiveTab === tab ? ' active' : ''}`;
}

function panelClass(tab: SettingsTabId): string {
  return `settings-panel${settingsActiveTab === tab ? ' active' : ''}`;
}

function hiddenUnlessAdvanced(): boolean {
  return !settingsShowAdvanced;
}

function ObserverStatusBanner() {
  const status = settingsRenderState.observerStatus as Record<string, any> | null;
  if (!status) {
    return <div id="observerStatusBanner" className="observer-status-banner" hidden />;
  }

  const active = status.active;
  const available = status.available_credentials || {};
  const failure = status.latest_failure;
  const credentialEntries = Object.entries(available).filter(([, creds]) => creds && typeof creds === 'object');

  return (
    <div id="observerStatusBanner" className="observer-status-banner">
      {active ? (
        <>
          <div className="status-label">Active observer</div>
          <div className="status-active">
            {String(active.provider || 'unknown')} → {String(active.model || '')} via{' '}
            {formatAuthMethod(active.auth?.method || 'none')}{' '}
            <span className={active.auth?.token_present === true ? 'cred-ok' : 'cred-none'}>
              {active.auth?.token_present === true ? '✓' : '✗'}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="status-label">Observer status</div>
          <div className="status-active">Not yet initialized (waiting for first session)</div>
        </>
      )}

      {credentialEntries.length ? (
        <>
          <div className="status-label">Available credentials</div>
          <div>
            {credentialEntries.map(([provider, creds], index) => {
              const normalizedCreds = creds as Record<string, boolean>;
              const hasAny = Object.values(normalizedCreds).some(Boolean);
              return (
                <span key={provider} className="status-cred">
                  {index > 0 ? ' · ' : null}
                  <span className={hasAny ? 'cred-ok' : 'cred-none'}>{hasAny ? '✓' : '–'}</span>{' '}
                  {String(provider)}: {formatCredentialSources(normalizedCreds)}
                </span>
              );
            })}
          </div>
        </>
      ) : null}

      {failure && typeof failure === 'object' ? (
        <>
          <div className="status-label">Latest processing issue</div>
          <div className="status-issue">
            <div className="status-issue-message">
              {typeof failure.error_message === 'string' && failure.error_message.trim()
                ? failure.error_message.trim()
                : 'Raw-event processing failed.'}
            </div>
            <div className="status-issue-meta">
              {[
                [
                  typeof failure.observer_provider === 'string' ? failure.observer_provider.trim() : '',
                  typeof failure.observer_model === 'string' && failure.observer_model.trim()
                    ? `→ ${failure.observer_model.trim()}`
                    : '',
                  typeof failure.observer_runtime === 'string' && failure.observer_runtime.trim()
                    ? `(${failure.observer_runtime.trim()})`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                  .replace(/\s+/g, ' ')
                  .trim(),
                `Last failure ${formatFailureTimestamp(failure.updated_at)}`,
                typeof failure.attempt_count === 'number' && Number.isFinite(failure.attempt_count)
                  ? `Attempts ${failure.attempt_count}`
                  : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {typeof failure.impact === 'string' && failure.impact.trim() ? (
              <div className="status-issue-impact">{failure.impact.trim()}</div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Field({
  children,
  className = 'field',
  hidden = false,
  id,
}: {
  children: ComponentChildren;
  className?: string;
  hidden?: boolean;
  id?: string;
}) {
  return (
    <div className={className} hidden={hidden} id={id}>
      {children}
    </div>
  );
}

function SettingsDialogContent() {
  const values = settingsRenderState.values;
  const observerMaxCharsDefault = state.configDefaults?.observer_max_chars || '';
  const showAuthFile = values.observerAuthSource === 'file';
  const showAuthCommand = values.observerAuthSource === 'command';

  return (
    <div className="modal-card">
      <div className="modal-header">
        <h2 id="settingsTitle">Memory & model settings</h2>
        <button
          aria-label="Close settings"
          className="modal-close"
          id="settingsClose"
          onClick={() => {
            if (settingsStartPolling && settingsRefresh) {
              closeSettings(settingsStartPolling, settingsRefresh);
            }
          }}
          type="button"
        >
          close
        </button>
      </div>
      <div className="modal-body">
        <div className="small" id="settingsDescription">
          Configure connection, authentication, processing, and sync behavior.
        </div>
        <div aria-label="Settings sections" className="settings-tabs" role="tablist">
          <button
            aria-selected={settingsActiveTab === 'observer' ? 'true' : 'false'}
            className={tabButtonClass('observer')}
            data-settings-tab="observer"
            id="settingsTabObserver"
            onClick={() => setSettingsTab('observer')}
            role="tab"
            type="button"
          >
            Connection
          </button>
          <button
            aria-selected={settingsActiveTab === 'queue' ? 'true' : 'false'}
            className={tabButtonClass('queue')}
            data-settings-tab="queue"
            id="settingsTabQueue"
            onClick={() => setSettingsTab('queue')}
            role="tab"
            type="button"
          >
            Processing
          </button>
          <button
            aria-selected={settingsActiveTab === 'sync' ? 'true' : 'false'}
            className={tabButtonClass('sync')}
            data-settings-tab="sync"
            id="settingsTabSync"
            onClick={() => setSettingsTab('sync')}
            role="tab"
            type="button"
          >
            Device Sync
          </button>
        </div>
        <div className="settings-advanced-toolbar field-checkbox">
          <input
            checked={settingsShowAdvanced}
            className="cm-checkbox"
            id="settingsAdvancedToggle"
            onChange={onAdvancedToggle}
            type="checkbox"
          />
          <label htmlFor="settingsAdvancedToggle">Show advanced controls</label>
          <button
            aria-label="About advanced controls"
            className="help-icon"
            data-tooltip="Advanced controls include JSON fields, tuning values, and network overrides."
            type="button"
          >
            ?
          </button>
        </div>

        <div className={panelClass('observer')} data-settings-panel="observer" hidden={settingsActiveTab !== 'observer'} id="settingsPanelObserver">
          <ObserverStatusBanner />
          <div className="settings-group">
            <h3 className="settings-group-title">Connection</h3>
            <Field>
              <div className="field-label">
                <label htmlFor="observerProvider">Model provider</label>
                <button aria-label="About model provider" className="help-icon" data-tooltip="Choose where model requests are sent. Use auto for recommended defaults." type="button">?</button>
              </div>
              <select id="observerProvider" onChange={onSelectInput('observerProvider')} value={values.observerProvider}>
                <option value="">auto (default)</option>
                {Array.from(new Set(settingsRenderState.providers.concat(values.observerProvider ? [values.observerProvider] : [])))
                  .sort((left, right) => left.localeCompare(right))
                  .map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
              </select>
              <div className="small">`auto` uses recommended defaults for the selected connection mode.</div>
            </Field>
            <Field>
              <div className="field-label">
                <label htmlFor="observerModel">Model</label>
                <button aria-label="About model defaults" className="help-icon" data-tooltip="Leave blank to use a recommended model for your selected mode/provider." type="button">?</button>
              </div>
              <input id="observerModel" onInput={onTextInput('observerModel')} placeholder="leave empty for default" value={values.observerModel} />
              <div className="small">Default: `gpt-5.1-codex-mini` for Direct API; `claude-4.5-haiku` for Local Claude session.</div>
              <div className="small" id="observerModelHint">{getObserverModelHint()}</div>
            </Field>
            <Field>
              <div className="field-label">
                <label htmlFor="observerRuntime">Connection mode</label>
                <button aria-label="About connection mode" className="help-icon" data-tooltip="Direct API uses provider credentials. Local Claude session uses local Claude runtime auth." type="button">?</button>
              </div>
              <select id="observerRuntime" onChange={onSelectInput('observerRuntime')} value={values.observerRuntime}>
                <option value="api_http">Direct API (default)</option>
                <option value="claude_sidecar">Local Claude session</option>
              </select>
              <div className="small">Switch between provider API credentials and local Claude session auth.</div>
            </Field>
            <Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <label htmlFor="claudeCommand">Claude command (JSON argv)</label>
              <textarea disabled id="claudeCommand" placeholder='["claude"]' rows={2} value={values.claudeCommand} />
              <div className="small">{protectedConfigHelp('claude_command')}</div>
            </Field>
            <Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <label htmlFor="observerMaxChars">Request size limit (chars)</label>
              <input id="observerMaxChars" min="1" onInput={onTextInput('observerMaxChars')} type="number" value={values.observerMaxChars} />
              <div className="small" id="observerMaxCharsHint">{observerMaxCharsDefault ? `Default: ${observerMaxCharsDefault}` : ''}</div>
            </Field>
          </div>

          <div className="settings-group">
            <h3 className="settings-group-title">Authentication</h3>
            <Field>
              <div className="field-label">
                <label htmlFor="observerAuthSource">Authentication method</label>
                <button aria-label="About authentication method" className="help-icon" data-tooltip="Choose how credentials are resolved: environment, file, command, or none." type="button">?</button>
              </div>
              <select id="observerAuthSource" onChange={onSelectInput('observerAuthSource')} value={values.observerAuthSource}>
                <option value="auto">auto (default)</option>
                <option value="env">env</option>
                <option value="file">file</option>
                <option value="command">command</option>
                <option value="none">none</option>
              </select>
              <div className="small">Use `auto` unless you need a specific token source.</div>
            </Field>
            <Field hidden={!showAuthFile} id="observerAuthFileField">
              <label htmlFor="observerAuthFile">Token file path</label>
              <input disabled id="observerAuthFile" placeholder="~/.codemem/work-token.txt" value={values.observerAuthFile} />
              <div className="small">{protectedConfigHelp('observer_auth_file')}</div>
            </Field>
            <Field hidden={!showAuthCommand} id="observerAuthCommandField">
              <div className="field-label">
                <label htmlFor="observerAuthCommand">Token command</label>
                <button aria-label="About token command" className="help-icon" data-tooltip="Runs this command and uses stdout as the token. JSON argv only, no shell parsing." type="button">?</button>
              </div>
              <textarea disabled id="observerAuthCommand" placeholder='["iap-auth", "--audience", "gateway"]' rows={3} value={values.observerAuthCommand} />
              <div className="small">{protectedConfigHelp('observer_auth_command')}</div>
            </Field>
            <div className="small" hidden={!showAuthCommand} id="observerAuthCommandNote">
              Command format: JSON string array, e.g. `["iap-auth", "--audience", "gateway"]`.
            </div>
            <Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <label htmlFor="observerAuthTimeoutMs">Token command timeout (ms)</label>
              <input id="observerAuthTimeoutMs" min="1" onInput={onTextInput('observerAuthTimeoutMs')} type="number" value={values.observerAuthTimeoutMs} />
            </Field>
            <Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <label htmlFor="observerAuthCacheTtlS">Token cache time (s)</label>
              <input id="observerAuthCacheTtlS" min="0" onInput={onTextInput('observerAuthCacheTtlS')} type="number" value={values.observerAuthCacheTtlS} />
            </Field>
            <Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <div className="field-label">
                <label htmlFor="observerHeaders">Request headers (JSON)</label>
                <button aria-label="About request headers" className="help-icon" data-tooltip={'Optional extra headers. Supports templates like ${auth.token}, ${auth.type}, ${auth.source}.'} type="button">?</button>
              </div>
              <textarea disabled id="observerHeaders" placeholder='{"Authorization":"Bearer ${auth.token}"}' rows={4} value={values.observerHeaders} />
              <div className="small">{protectedConfigHelp('observer_headers')}</div>
            </Field>
          </div>
        </div>

        <div className={panelClass('queue')} data-settings-panel="queue" hidden={settingsActiveTab !== 'queue'} id="settingsPanelQueue">
          <div className="settings-group">
            <h3 className="settings-group-title">Processing</h3>
            <Field>
              <div className="field-label">
                <label htmlFor="rawEventsSweeperIntervalS">Background processing interval (seconds)</label>
                <button aria-label="About background processing interval" className="help-icon" data-tooltip="How often codemem checks for queued events to process in the background." type="button">?</button>
              </div>
              <input id="rawEventsSweeperIntervalS" min="1" onInput={onTextInput('rawEventsSweeperIntervalS')} type="number" value={values.rawEventsSweeperIntervalS} />
              <div className="small">How often background flush checks pending raw events.</div>
            </Field>
          </div>
          <div className="settings-group settings-advanced" hidden={hiddenUnlessAdvanced()}>
            <h3 className="settings-group-title">Context Pack Limits</h3>
            <Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <label htmlFor="packObservationLimit">Observation limit</label>
              <input id="packObservationLimit" min="1" onInput={onTextInput('packObservationLimit')} type="number" value={values.packObservationLimit} />
              <div className="small">Default number of observations to include in a pack.</div>
            </Field>
            <Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <label htmlFor="packSessionLimit">Session summary limit</label>
              <input id="packSessionLimit" min="1" onInput={onTextInput('packSessionLimit')} type="number" value={values.packSessionLimit} />
              <div className="small">Default number of session summaries to include in a pack.</div>
            </Field>
          </div>
        </div>

        <div className={panelClass('sync')} data-settings-panel="sync" hidden={settingsActiveTab !== 'sync'} id="settingsPanelSync">
          <div className="settings-group">
            <h3 className="settings-group-title">Device Sync</h3>
            <div className="field field-checkbox"><input checked={values.syncEnabled} className="cm-checkbox" id="syncEnabled" onChange={onCheckboxInput('syncEnabled')} type="checkbox" /><label htmlFor="syncEnabled">Enable sync</label></div>
            <div className="field"><label htmlFor="syncInterval">Sync interval (seconds)</label><input id="syncInterval" min="10" onInput={onTextInput('syncInterval')} type="number" value={values.syncInterval} /></div>
            <div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}><label htmlFor="syncHost">Sync host</label><input id="syncHost" onInput={onTextInput('syncHost')} placeholder="127.0.0.1" value={values.syncHost} /></div>
            <div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}><label htmlFor="syncPort">Sync port</label><input id="syncPort" min="1" onInput={onTextInput('syncPort')} type="number" value={values.syncPort} /></div>
            <div className="field field-checkbox settings-advanced" hidden={hiddenUnlessAdvanced()}><input checked={values.syncMdns} className="cm-checkbox" id="syncMdns" onChange={onCheckboxInput('syncMdns')} type="checkbox" /><label htmlFor="syncMdns">Enable mDNS discovery</label></div>
            <div className="field">
              <label htmlFor="syncCoordinatorUrl">Coordinator URL</label>
              <input disabled id="syncCoordinatorUrl" placeholder="https://coord.example.com" value={values.syncCoordinatorUrl} />
              <div className="small">{protectedConfigHelp('sync_coordinator_url')}</div>
            </div>
            <div className="field">
              <label htmlFor="syncCoordinatorGroup">Coordinator group</label>
              <input id="syncCoordinatorGroup" onInput={onTextInput('syncCoordinatorGroup')} placeholder="nerdworld" value={values.syncCoordinatorGroup} />
              <div className="small">Discovery namespace for peers using the same coordinator.</div>
            </div>
            <div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <label htmlFor="syncCoordinatorTimeout">Coordinator timeout (seconds)</label>
              <input id="syncCoordinatorTimeout" min="1" onInput={onTextInput('syncCoordinatorTimeout')} type="number" value={values.syncCoordinatorTimeout} />
            </div>
            <div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
              <label htmlFor="syncCoordinatorPresenceTtl">Presence TTL (seconds)</label>
              <input id="syncCoordinatorPresenceTtl" min="1" onInput={onTextInput('syncCoordinatorPresenceTtl')} type="number" value={values.syncCoordinatorPresenceTtl} />
            </div>
          </div>
        </div>

        <div className="small mono" id="settingsPath">{settingsRenderState.pathText}</div>
        <div className="small" id="settingsEffective">{settingsRenderState.effectiveText}</div>
        <div className="settings-note" hidden={!settingsRenderState.overridesVisible} id="settingsOverrides">
          Some values are controlled outside this screen and take priority.
        </div>
      </div>
      <div className="modal-footer">
        <div className="small" id="settingsStatus">{settingsRenderState.statusText}</div>
        <button
          className="settings-save"
          disabled={!state.settingsDirty || settingsRenderState.isSaving}
          id="settingsSave"
          onClick={() => {
            if (settingsStartPolling && settingsRefresh) {
              void saveSettings(settingsStartPolling, settingsRefresh);
            }
          }}
          type="button"
        >
          Save
        </button>
      </div>
    </div>
  );
}

export function initSettings(stopPolling: () => void, startPolling: () => void, refreshCallback: () => void) {
  settingsStartPolling = startPolling;
  settingsRefresh = refreshCallback;
  ensureSettingsShell();

  const settingsButton = $button('settingsButton');
  settingsButton?.addEventListener('click', () => openSettings(stopPolling));
}
