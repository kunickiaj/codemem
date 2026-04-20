/* Settings modal — observer config, sync settings. */

import { type ComponentChildren, type JSX, render } from "preact";
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import { RadixSelect } from "../components/primitives/radix-select";
import { RadixSwitch } from "../components/primitives/radix-switch";
import { RadixTabs, RadixTabsContent } from "../components/primitives/radix-tabs";
import { TextArea } from "../components/primitives/text-area";
import { TextInput } from "../components/primitives/text-input";
import * as api from "../lib/api";
import { $, $button } from "../lib/dom";
import { showGlobalNotice } from "../lib/notice";
import { state } from "../lib/state";

let settingsOpen = false;
let previouslyFocused: HTMLElement | null = null;
let settingsActiveTab = "observer";
let settingsBaseline: Record<string, unknown> = {};
let settingsEnvOverrides: Record<string, unknown> = {};
let settingsTouchedKeys = new Set<string>();
let settingsShellMounted = false;
let settingsProtectedKeys = new Set<string>();
let settingsStartPolling: (() => void) | null = null;
let settingsRefresh: (() => void) | null = null;

import {
	DEFAULT_ANTHROPIC_MODEL,
	DEFAULT_OPENAI_MODEL,
	EMPTY_FORM_STATE,
	INPUT_TO_CONFIG_KEY,
	PROTECTED_VIEWER_CONFIG_KEYS,
	SETTINGS_ADVANCED_KEY,
	SETTINGS_TABS,
} from "./settings/data/constants";
import type {
	SettingsController,
	SettingsFormState,
	SettingsHintProps,
	SettingsRenderState,
	SettingsSectionIntroProps,
	SettingsTabId,
	SettingsTooltipState,
} from "./settings/data/types";

let settingsShowAdvanced = loadAdvancedPreference();
let settingsController: SettingsController | null = null;

let settingsRenderState: SettingsRenderState = {
	effectiveText: "",
	isSaving: false,
	observerStatus: null,
	overridesVisible: false,
	pathText: "Config path: n/a",
	providers: [],
	statusText: "Ready",
	values: { ...EMPTY_FORM_STATE },
};

function SettingsSectionIntro({ detail, title }: SettingsSectionIntroProps) {
	return (
		<div className="settings-section-intro">
			<div className="settings-section-intro-title">{title}</div>
			<div className="small settings-section-intro-detail">{detail}</div>
		</div>
	);
}

function SettingsHint({ children, hidden = false }: SettingsHintProps) {
	return (
		<div className="settings-note" hidden={hidden}>
			{children}
		</div>
	);
}

function loadAdvancedPreference(): boolean {
	try {
		return globalThis.localStorage?.getItem(SETTINGS_ADVANCED_KEY) === "1";
	} catch {
		return false;
	}
}

function persistAdvancedPreference(show: boolean) {
	try {
		globalThis.localStorage?.setItem(SETTINGS_ADVANCED_KEY, show ? "1" : "0");
	} catch {}
}

function hasOwn(obj: unknown, key: string): boolean {
	return typeof obj === "object" && obj !== null && Object.hasOwn(obj, key);
}

function effectiveOrConfigured(config: unknown, effective: unknown, key: string): unknown {
	if (hasOwn(effective, key)) return (effective as Record<string, unknown>)[key];
	if (hasOwn(config, key)) return (config as Record<string, unknown>)[key];
	return undefined;
}

function asInputString(value: unknown): string {
	if (value === undefined || value === null) return "";
	return String(value);
}

function asBooleanValue(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (!normalized) return false;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
	}
	return Boolean(value);
}

function toProviderList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isEqualValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeTextValue(value: string): string {
	const trimmed = value.trim();
	return trimmed === "" ? "" : trimmed;
}

function inferObserverModel(
	runtime: string,
	provider: string,
	configuredModel: string,
): { model: string; source: string } {
	if (configuredModel) return { model: configuredModel, source: "Configured" };
	if (runtime === "claude_sidecar") {
		return { model: DEFAULT_ANTHROPIC_MODEL, source: "Recommended (local Claude session)" };
	}
	if (provider === "anthropic") {
		return { model: DEFAULT_ANTHROPIC_MODEL, source: "Recommended (Anthropic provider)" };
	}
	if (provider === "opencode") {
		return { model: "opencode/gpt-5.1-codex-mini", source: "Recommended (OpenCode Zen provider)" };
	}
	if (provider && provider !== "openai") {
		return { model: "provider default", source: "Recommended (provider default)" };
	}
	return { model: DEFAULT_OPENAI_MODEL, source: "Recommended (direct API)" };
}

function configuredValueForKey(config: unknown, key: string): unknown {
	const cfg = (config ?? {}) as Record<string, unknown>;
	switch (key) {
		case "claude_command": {
			const value = cfg.claude_command;
			if (!Array.isArray(value)) return [];
			const normalized: string[] = [];
			value.forEach((item) => {
				if (typeof item !== "string") return;
				const token = item.trim();
				if (token) normalized.push(token);
			});
			return normalized;
		}
		case "observer_provider":
		case "observer_model":
		case "observer_simple_model":
		case "observer_rich_model":
		case "observer_rich_reasoning_effort":
		case "observer_rich_reasoning_summary":
		case "observer_auth_file":
		case "sync_host":
		case "sync_coordinator_url":
		case "sync_coordinator_group":
			return normalizeTextValue(asInputString(cfg[key]));
		case "observer_runtime":
			return normalizeTextValue(asInputString(cfg.observer_runtime));
		case "observer_auth_source":
			return normalizeTextValue(asInputString(cfg.observer_auth_source));
		case "observer_auth_command": {
			const value = cfg.observer_auth_command;
			if (!Array.isArray(value)) return [];
			return value.filter((item) => typeof item === "string");
		}
		case "observer_headers": {
			const value = cfg.observer_headers;
			if (!value || typeof value !== "object" || Array.isArray(value)) return {};
			const headers: Record<string, string> = {};
			Object.entries(value as Record<string, unknown>).forEach(([header, headerValue]) => {
				if (typeof header === "string" && header.trim() && typeof headerValue === "string") {
					headers[header.trim()] = headerValue;
				}
			});
			return headers;
		}
		case "observer_auth_timeout_ms":
		case "observer_max_chars":
		case "observer_simple_temperature":
		case "observer_rich_temperature":
		case "observer_rich_max_output_tokens":
		case "pack_observation_limit":
		case "pack_session_limit":
		case "raw_events_sweeper_interval_s":
		case "sync_port":
		case "sync_interval_s": {
			if (!hasOwn(cfg, key)) return "";
			const parsed = Number(cfg[key]);
			return Number.isFinite(parsed) && parsed !== 0 ? parsed : "";
		}
		case "sync_coordinator_timeout_s":
		case "sync_coordinator_presence_ttl_s": {
			if (!hasOwn(cfg, key)) return "";
			const parsed = Number(cfg[key]);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : "";
		}
		case "observer_auth_cache_ttl_s": {
			if (!hasOwn(cfg, key)) return "";
			const parsed = Number(cfg[key]);
			return Number.isFinite(parsed) ? parsed : "";
		}
		case "sync_enabled":
		case "sync_mdns":
		case "observer_tier_routing_enabled":
		case "observer_rich_openai_use_responses":
			return asBooleanValue(cfg[key]);
		default:
			return hasOwn(cfg, key) ? cfg[key] : "";
	}
}

function mergeOverrideBaseline(
	baseline: Record<string, unknown>,
	config: unknown,
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
	if (values.observerTierRoutingEnabled) {
		return "Tiered routing is enabled: simple/rich model selection now lives in Processing.";
	}
	const inferred = inferObserverModel(
		values.observerRuntime.trim() || "api_http",
		values.observerProvider.trim(),
		normalizeTextValue(values.observerModel),
	);
	const overrideActive = ["observer_model", "observer_provider", "observer_runtime"].some((key) =>
		hasOwn(settingsEnvOverrides, key),
	);
	const source = overrideActive ? "Env override" : inferred.source;
	return `${source}: ${inferred.model}`;
}

function getTieredRoutingHelperText(): string {
	if (!settingsRenderState.values.observerTierRoutingEnabled) {
		return "Off: codemem uses the base observer settings from the Connection tab for all batches.";
	}
	return "On: codemem can route simpler batches to a lighter model and richer batches to a higher-quality configuration.";
}

function getObserverModelLabel(): string {
	return settingsRenderState.values.observerTierRoutingEnabled ? "Base model fallback" : "Model";
}

function getObserverModelTooltip(): string {
	return settingsRenderState.values.observerTierRoutingEnabled
		? "Tiered routing is enabled, so Processing controls the simple/rich models. This base model is only a fallback."
		: "Leave blank to use a recommended model for your selected mode/provider.";
}

function getObserverModelDescription(): string {
	return settingsRenderState.values.observerTierRoutingEnabled
		? "Tiered routing is active. Use this only as a fallback while the Processing tab owns simple/rich model selection."
		: "Default: `gpt-5.1-codex-mini` for Direct API; `claude-4.5-haiku` for Local Claude session.";
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
	return target.closest(".help-icon[data-tooltip]") as HTMLElement | null;
}

function markFieldTouched(inputId: keyof SettingsFormState) {
	const key = INPUT_TO_CONFIG_KEY[inputId];
	if (!key) return;
	settingsTouchedKeys.add(key);
}

function getFocusableNodes(container: HTMLElement | null): HTMLElement[] {
	if (!container) return [];
	const selector = [
		"button:not([disabled])",
		"input:not([disabled])",
		"select:not([disabled])",
		"textarea:not([disabled])",
		"[href]",
		'[tabindex]:not([tabindex="-1"])',
	].join(",");
	return Array.from(container.querySelectorAll(selector)).filter((node) => {
		const el = node as HTMLElement;
		return !el.hidden && el.offsetParent !== null;
	}) as HTMLElement[];
}

function focusSettingsDialog() {
	const modal = $("settingsModal");
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
	const mount = $("settingsDialogMount");
	if (!mount) return;
	render(<SettingsDialogShell />, mount);
	// Lucide icon replacement happens in the shell's open-state effect — the
	// Dialog renders children only while open, so createIcons() here would
	// no-op against the unmounted tree.
}

function ensureSettingsShell() {
	const mount = $("settingsDialogMount");
	if (!mount) return;
	if (settingsShellMounted) return;
	renderSettingsShell();
	settingsShellMounted = true;
}

function SettingsDialogShell() {
	const [open, setOpen] = useState(settingsOpen);
	const [activeTab, setActiveTabState] = useState<SettingsTabId>(
		["observer", "queue", "sync"].includes(settingsActiveTab)
			? (settingsActiveTab as SettingsTabId)
			: "observer",
	);
	const [dirty, setDirtyState] = useState(state.settingsDirty);
	const [renderState, setRenderStateState] = useState(settingsRenderState);
	const [showAdvanced, setShowAdvancedState] = useState(settingsShowAdvanced);
	const [tooltip, setTooltip] = useState<SettingsTooltipState>({
		anchor: null,
		content: "",
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
				setTooltip({ anchor: null, content: "", visible: false });
			},
			setActiveTab: (tab) => {
				const nextTab = ["observer", "queue", "sync"].includes(tab) ? tab : "observer";
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

	// Radix Dialog mounts its children only while `open` is true, so any
	// <i data-lucide="..."> stubs inside the dialog need a createIcons pass
	// every time the modal opens. Running it on the shell mount (before the
	// children exist) is a no-op for those nodes.
	useEffect(() => {
		if (!open) return;
		const lucide = (globalThis as { lucide?: { createIcons?: () => void } }).lucide;
		lucide?.createIcons?.();
	}, [open]);

	useEffect(() => {
		const showTooltip = (anchor: HTMLElement) => {
			const content = anchor.dataset.tooltip?.trim();
			if (!content) return;
			setTooltip({ anchor, content, visible: true });
		};

		const hideTooltip = () => {
			setTooltip((current) => {
				if (!current.visible && !current.anchor && !current.content) return current;
				return { anchor: null, content: "", visible: false };
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
					return { anchor: null, content: "", visible: false };
				}
				const content = button.dataset.tooltip?.trim() || "";
				if (!content) return current;
				return { anchor: button, content, visible: true };
			});
		};

		document.addEventListener("pointerover", onPointerOver);
		document.addEventListener("pointerout", onPointerOut);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		document.addEventListener("click", onClick);

		return () => {
			document.removeEventListener("pointerover", onPointerOver);
			document.removeEventListener("pointerout", onPointerOut);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			document.removeEventListener("click", onClick);
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
		globalThis.addEventListener("resize", reposition);
		document.addEventListener("scroll", reposition, true);
		return () => {
			globalThis.removeEventListener("resize", reposition);
			document.removeEventListener("scroll", reposition, true);
		};
	}, [tooltip.anchor, tooltip.visible]);

	const tooltipPortal = useMemo(() => {
		if (typeof document === "undefined") return null;
		return createPortal(
			<div
				className={`help-tooltip${tooltip.visible ? " visible" : ""}`}
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
	return String(key || "").replace(/_/g, " ");
}

function joinPhrases(values: string[]): string {
	const items = values.filter((value) => typeof value === "string" && value.trim());
	if (items.length === 0) return "";
	if (items.length === 1) return items[0];
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

interface SettingsSaveEffects {
	hot_reloaded_keys?: unknown;
	live_applied_keys?: unknown;
	restart_required_keys?: unknown;
	warnings?: unknown;
	manual_actions?: unknown;
	sync?: {
		attempted?: boolean;
		message?: string;
		reason?: string;
		affected_keys?: unknown;
		ok?: boolean;
	};
}

function buildSettingsNotice(payload: unknown): { message: string; type: "success" | "warning" } {
	const raw = (payload as { effects?: SettingsSaveEffects } | null | undefined)?.effects;
	const effects: SettingsSaveEffects =
		raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const hotReloaded = Array.isArray(effects.hot_reloaded_keys)
		? effects.hot_reloaded_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const liveApplied = Array.isArray(effects.live_applied_keys)
		? effects.live_applied_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const restartRequired = Array.isArray(effects.restart_required_keys)
		? effects.restart_required_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const warnings = Array.isArray(effects.warnings)
		? effects.warnings.filter(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			)
		: [];
	const manualActions: Array<{ command?: string }> = Array.isArray(effects.manual_actions)
		? (effects.manual_actions as Array<{ command?: string }>)
		: [];
	const sync = effects.sync && typeof effects.sync === "object" ? effects.sync : {};
	const lines: string[] = [];

	if (hotReloaded.length) {
		lines.push(`Applied now: ${joinPhrases(hotReloaded)}.`);
	}
	if (liveApplied.length) {
		lines.push(`Live settings updated: ${joinPhrases(liveApplied)}.`);
	}
	if (sync.attempted && typeof sync.message === "string" && sync.message) {
		lines.push(`Sync: ${sync.message}.`);
	} else if (
		Array.isArray(sync.affected_keys) &&
		sync.affected_keys.length &&
		typeof sync.reason === "string" &&
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
		if (action && typeof action.command === "string" && action.command.trim()) {
			lines.push(`If needed: ${action.command}.`);
		}
	});
	if (!lines.length) {
		lines.push("Saved.");
	}

	const hasWarning = restartRequired.length > 0 || warnings.length > 0 || sync.ok === false;
	return { message: lines.join(" "), type: hasWarning ? "warning" : "success" };
}

function isProtectedConfigKey(key: string): boolean {
	return settingsProtectedKeys.has(key) || PROTECTED_VIEWER_CONFIG_KEYS.has(key);
}

function protectedConfigHelp(key: string): string {
	return `${key} is read-only in the viewer for security. Edit the config file or environment instead.`;
}

interface ConfigPayload {
	config?: Record<string, unknown>;
	effective?: Record<string, unknown>;
	defaults?: Record<string, unknown>;
	env_overrides?: Record<string, unknown>;
	protected_keys?: unknown;
	providers?: unknown;
	path?: string;
}

function formStateFromPayload(payload: ConfigPayload): SettingsFormState {
	const config = payload.config || {};
	const effective = payload.effective || {};
	const observerHeadersValue = effectiveOrConfigured(config, effective, "observer_headers");
	const observerHeaders =
		observerHeadersValue &&
		typeof observerHeadersValue === "object" &&
		!Array.isArray(observerHeadersValue)
			? Object.fromEntries(
					Object.entries(observerHeadersValue as Record<string, unknown>).filter(
						([key, value]) => typeof key === "string" && key.trim() && typeof value === "string",
					),
				)
			: {};
	const claudeCommandValue = effectiveOrConfigured(config, effective, "claude_command");
	const claudeCommand = Array.isArray(claudeCommandValue)
		? claudeCommandValue.filter((item): item is string => typeof item === "string")
		: [];
	const authCommandValue = effectiveOrConfigured(config, effective, "observer_auth_command");
	const authCommand = Array.isArray(authCommandValue)
		? authCommandValue.filter((item): item is string => typeof item === "string")
		: [];

	return {
		claudeCommand: claudeCommand.length ? JSON.stringify(claudeCommand, null, 2) : "",
		observerProvider: asInputString(effectiveOrConfigured(config, effective, "observer_provider")),
		observerModel: asInputString(effectiveOrConfigured(config, effective, "observer_model")),
		observerTierRoutingEnabled: asBooleanValue(
			effectiveOrConfigured(config, effective, "observer_tier_routing_enabled"),
		),
		observerSimpleModel: asInputString(
			effectiveOrConfigured(config, effective, "observer_simple_model"),
		),
		observerSimpleTemperature: asInputString(
			effectiveOrConfigured(config, effective, "observer_simple_temperature"),
		),
		observerRichModel: asInputString(
			effectiveOrConfigured(config, effective, "observer_rich_model"),
		),
		observerRichTemperature: asInputString(
			effectiveOrConfigured(config, effective, "observer_rich_temperature"),
		),
		observerRichOpenAIUseResponses: asBooleanValue(
			effectiveOrConfigured(config, effective, "observer_rich_openai_use_responses"),
		),
		observerRichReasoningEffort: asInputString(
			effectiveOrConfigured(config, effective, "observer_rich_reasoning_effort"),
		),
		observerRichReasoningSummary: asInputString(
			effectiveOrConfigured(config, effective, "observer_rich_reasoning_summary"),
		),
		observerRichMaxOutputTokens: asInputString(
			effectiveOrConfigured(config, effective, "observer_rich_max_output_tokens"),
		),
		observerRuntime:
			asInputString(effectiveOrConfigured(config, effective, "observer_runtime")) || "api_http",
		observerAuthSource:
			asInputString(effectiveOrConfigured(config, effective, "observer_auth_source")) || "auto",
		observerAuthFile: asInputString(effectiveOrConfigured(config, effective, "observer_auth_file")),
		observerAuthCommand: authCommand.length ? JSON.stringify(authCommand, null, 2) : "",
		observerAuthTimeoutMs: asInputString(
			effectiveOrConfigured(config, effective, "observer_auth_timeout_ms"),
		),
		observerAuthCacheTtlS: asInputString(
			effectiveOrConfigured(config, effective, "observer_auth_cache_ttl_s"),
		),
		observerHeaders: Object.keys(observerHeaders).length
			? JSON.stringify(observerHeaders, null, 2)
			: "",
		observerMaxChars: asInputString(effectiveOrConfigured(config, effective, "observer_max_chars")),
		packObservationLimit: asInputString(
			effectiveOrConfigured(config, effective, "pack_observation_limit"),
		),
		packSessionLimit: asInputString(effectiveOrConfigured(config, effective, "pack_session_limit")),
		rawEventsSweeperIntervalS: asInputString(
			effectiveOrConfigured(config, effective, "raw_events_sweeper_interval_s"),
		),
		syncEnabled: asBooleanValue(effectiveOrConfigured(config, effective, "sync_enabled")),
		syncHost: asInputString(effectiveOrConfigured(config, effective, "sync_host")),
		syncPort: asInputString(effectiveOrConfigured(config, effective, "sync_port")),
		syncInterval: asInputString(effectiveOrConfigured(config, effective, "sync_interval_s")),
		syncMdns: asBooleanValue(effectiveOrConfigured(config, effective, "sync_mdns")),
		syncCoordinatorUrl: asInputString(
			effectiveOrConfigured(config, effective, "sync_coordinator_url"),
		),
		syncCoordinatorGroup: asInputString(
			effectiveOrConfigured(config, effective, "sync_coordinator_group"),
		),
		syncCoordinatorTimeout: asInputString(
			effectiveOrConfigured(config, effective, "sync_coordinator_timeout_s"),
		),
		syncCoordinatorPresenceTtl: asInputString(
			effectiveOrConfigured(config, effective, "sync_coordinator_presence_ttl_s"),
		),
	};
}

export function renderConfigModal(payload: unknown) {
	if (!payload || typeof payload !== "object") return;
	const data = payload as ConfigPayload;
	const defaults = data.defaults || {};
	const config = data.config || {};
	const envOverrides =
		data.env_overrides && typeof data.env_overrides === "object" ? data.env_overrides : {};
	const protectedKeys = Array.isArray(data.protected_keys)
		? data.protected_keys.filter(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			)
		: [];
	const values = formStateFromPayload(data);

	settingsEnvOverrides = envOverrides;
	settingsProtectedKeys = new Set(protectedKeys);
	state.configDefaults = defaults;
	state.configPath = data.path || "";

	updateRenderState({
		effectiveText:
			Object.keys(envOverrides).length > 0
				? "Some fields are managed by environment settings."
				: "",
		overridesVisible: Object.keys(envOverrides).length > 0,
		pathText: state.configPath ? `Config path: ${state.configPath}` : "Config path: n/a",
		providers: toProviderList(data.providers),
		statusText: "No unsaved changes",
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

function parseCommandArgv(
	raw: string,
	options: { label: string; normalize?: boolean; requireNonEmpty?: boolean },
): string[] {
	const text = raw.trim();
	if (!text) return [];
	const parsed = JSON.parse(text);
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
		throw new Error(`${options.label} must be a JSON string array`);
	}
	if (!options.normalize && !options.requireNonEmpty) {
		return parsed;
	}
	const values = options.normalize ? parsed.map((item) => item.trim()) : parsed;
	if (options.requireNonEmpty && values.some((item) => item.trim() === "")) {
		throw new Error(`${options.label} cannot contain empty command tokens`);
	}
	return values;
}

function parseObserverHeaders(raw: string): Record<string, string> {
	const text = raw.trim();
	if (!text) return {};
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("observer headers must be a JSON object");
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof key !== "string" || !key.trim() || typeof value !== "string") {
			throw new Error("observer headers must map string keys to string values");
		}
		headers[key.trim()] = value;
	}
	return headers;
}

function collectSettingsPayload(
	options: { allowUntouchedParseErrors?: boolean } = {},
): Record<string, unknown> {
	const allowUntouchedParseErrors = options.allowUntouchedParseErrors === true;
	const values = settingsRenderState.values;
	let claudeCommand: string[] = [];
	try {
		claudeCommand = parseCommandArgv(values.claudeCommand, {
			label: "claude command",
			normalize: true,
			requireNonEmpty: true,
		});
	} catch (error) {
		if (!allowUntouchedParseErrors || settingsTouchedKeys.has("claude_command")) {
			throw error;
		}
		const baseline = settingsBaseline.claude_command;
		claudeCommand = Array.isArray(baseline)
			? baseline
					.filter((item): item is string => typeof item === "string")
					.map((item) => item.trim())
					.filter((item) => item.length > 0)
			: [];
	}

	let authCommand: string[] = [];
	try {
		authCommand = parseCommandArgv(values.observerAuthCommand, { label: "observer auth command" });
	} catch (error) {
		if (!allowUntouchedParseErrors || settingsTouchedKeys.has("observer_auth_command")) {
			throw error;
		}
		const baseline = settingsBaseline.observer_auth_command;
		authCommand = Array.isArray(baseline)
			? baseline.filter((item): item is string => typeof item === "string")
			: [];
	}

	let headers: Record<string, string> = {};
	try {
		headers = parseObserverHeaders(values.observerHeaders);
	} catch (error) {
		if (!allowUntouchedParseErrors || settingsTouchedKeys.has("observer_headers")) {
			throw error;
		}
		const baseline = settingsBaseline.observer_headers;
		if (baseline && typeof baseline === "object" && !Array.isArray(baseline)) {
			Object.entries(baseline as Record<string, unknown>).forEach(([key, value]) => {
				if (typeof key === "string" && key.trim() && typeof value === "string") {
					headers[key] = value;
				}
			});
		}
	}

	const authCacheTtlInput = values.observerAuthCacheTtlS.trim();
	const simpleTemperatureInput = values.observerSimpleTemperature.trim();
	const richTemperatureInput = values.observerRichTemperature.trim();
	const richMaxOutputTokensInput = values.observerRichMaxOutputTokens.trim();
	const sweeperIntervalInput = values.rawEventsSweeperIntervalS.trim();
	const authCacheTtl = authCacheTtlInput === "" ? "" : Number(authCacheTtlInput);
	const simpleTemperature = simpleTemperatureInput === "" ? "" : Number(simpleTemperatureInput);
	const richTemperature = richTemperatureInput === "" ? "" : Number(richTemperatureInput);
	const richMaxOutputTokens =
		richMaxOutputTokensInput === "" ? "" : Number(richMaxOutputTokensInput);
	const sweeperIntervalNum = Number(sweeperIntervalInput);
	const sweeperInterval = sweeperIntervalInput === "" ? "" : sweeperIntervalNum;

	if (authCacheTtlInput !== "" && !Number.isFinite(authCacheTtl)) {
		throw new Error("observer auth cache ttl must be a number");
	}
	if (
		simpleTemperatureInput !== "" &&
		(typeof simpleTemperature !== "number" ||
			!Number.isFinite(simpleTemperature) ||
			simpleTemperature < 0)
	) {
		throw new Error("simple tier temperature must be a non-negative number");
	}
	if (
		richTemperatureInput !== "" &&
		(typeof richTemperature !== "number" ||
			!Number.isFinite(richTemperature) ||
			richTemperature < 0)
	) {
		throw new Error("rich tier temperature must be a non-negative number");
	}
	if (
		richMaxOutputTokensInput !== "" &&
		(typeof richMaxOutputTokens !== "number" ||
			!Number.isFinite(richMaxOutputTokens) ||
			richMaxOutputTokens <= 0 ||
			!Number.isInteger(richMaxOutputTokens))
	) {
		throw new Error("rich tier max output tokens must be a positive integer");
	}
	if (
		sweeperIntervalInput !== "" &&
		(!Number.isFinite(sweeperIntervalNum) || sweeperIntervalNum <= 0)
	) {
		throw new Error("raw-event sweeper interval must be a positive number");
	}

	return {
		claude_command: claudeCommand,
		observer_provider: normalizeTextValue(values.observerProvider),
		observer_model: normalizeTextValue(values.observerModel),
		observer_tier_routing_enabled: values.observerTierRoutingEnabled,
		observer_simple_model: normalizeTextValue(values.observerSimpleModel),
		observer_simple_temperature: simpleTemperature,
		observer_rich_model: normalizeTextValue(values.observerRichModel),
		observer_rich_temperature: richTemperature,
		observer_rich_openai_use_responses: values.observerRichOpenAIUseResponses,
		observer_rich_reasoning_effort: normalizeTextValue(values.observerRichReasoningEffort),
		observer_rich_reasoning_summary: normalizeTextValue(values.observerRichReasoningSummary),
		observer_rich_max_output_tokens: richMaxOutputTokens,
		observer_runtime: normalizeTextValue(values.observerRuntime || "api_http") || "api_http",
		observer_auth_source: normalizeTextValue(values.observerAuthSource || "auto") || "auto",
		observer_auth_file: normalizeTextValue(values.observerAuthFile),
		observer_auth_command: authCommand,
		observer_auth_timeout_ms: Number(values.observerAuthTimeoutMs || 0) || "",
		observer_auth_cache_ttl_s: authCacheTtl,
		observer_headers: headers,
		observer_max_chars: Number(values.observerMaxChars || 0) || "",
		pack_observation_limit: Number(values.packObservationLimit || 0) || "",
		pack_session_limit: Number(values.packSessionLimit || 0) || "",
		raw_events_sweeper_interval_s: sweeperInterval,
		sync_enabled: values.syncEnabled,
		sync_host: normalizeTextValue(values.syncHost),
		sync_port: Number(values.syncPort || 0) || "",
		sync_interval_s: Number(values.syncInterval || 0) || "",
		sync_mdns: values.syncMdns,
		sync_coordinator_url: normalizeTextValue(values.syncCoordinatorUrl),
		sync_coordinator_group: normalizeTextValue(values.syncCoordinatorGroup),
		sync_coordinator_timeout_s: Number(values.syncCoordinatorTimeout || 0) || "",
		sync_coordinator_presence_ttl_s: Number(values.syncCoordinatorPresenceTtl || 0) || "",
	};
}

function setSettingsTab(tab: string) {
	const nextTab = ["observer", "queue", "sync"].includes(tab) ? (tab as SettingsTabId) : "observer";
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
		if (!globalThis.confirm("Discard unsaved changes?")) {
			settingsController?.setOpen(true);
			return;
		}
	}
	settingsOpen = false;
	settingsController?.setOpen(false);
	hideHelpTooltip();
	const restoreTarget =
		previouslyFocused && typeof previouslyFocused.focus === "function"
			? previouslyFocused
			: $button("settingsButton");
	restoreTarget?.focus();
	previouslyFocused = null;
	settingsTouchedKeys = new Set<string>();
	startPolling();
	refreshCallback();
}

export async function saveSettings(startPolling: () => void, refreshCallback: () => void) {
	if (settingsRenderState.isSaving) return;
	updateRenderState({ isSaving: true, statusText: "Saving changes…" });

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
			updateRenderState({ isSaving: false, statusText: "No unsaved changes" });
			setDirty(false);
			closeSettings(startPolling, refreshCallback);
			return;
		}

		const result = await api.saveConfig(changed);
		const notice = buildSettingsNotice(result);
		updateRenderState({ isSaving: false, statusText: "Saved changes" });
		setDirty(false);
		closeSettings(startPolling, refreshCallback);
		showGlobalNotice(notice.message, notice.type);
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		updateRenderState({ isSaving: false, statusText: `Save failed: ${message}` });
	}
}

function formatAuthMethod(method: string): string {
	switch (method) {
		case "anthropic_consumer":
			return "OAuth (Claude Max/Pro)";
		case "codex_consumer":
			return "OAuth (ChatGPT subscription)";
		case "sdk_client":
			return "API key";
		case "claude_sidecar":
			return "Local Claude session";
		case "opencode_run":
			return "OpenCode sidecar";
		default:
			return method || "none";
	}
}

function formatCredentialSources(creds: Record<string, boolean>): string {
	const parts: string[] = [];
	if (creds.oauth) parts.push("OAuth");
	if (creds.api_key) parts.push("API key");
	if (creds.env_var) parts.push("env var");
	return parts.length ? parts.join(", ") : "none";
}

function formatFailureTimestamp(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "Unknown time";
	const ts = new Date(value);
	if (Number.isNaN(ts.getTime())) return value;
	return ts.toLocaleString();
}

function renderObserverStatusBanner(status: unknown) {
	updateRenderState({
		observerStatus:
			status && typeof status === "object" ? (status as Record<string, unknown>) : null,
	});
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

function onSelectValueChange<K extends keyof SettingsFormState>(field: K) {
	return (value: string) => {
		updateField(field, value as SettingsFormState[K]);
	};
}

function onSwitchInput<K extends keyof SettingsFormState>(field: K) {
	return (checked: boolean) => {
		updateField(field, checked as SettingsFormState[K]);
	};
}

function onAdvancedToggle(checked: boolean) {
	settingsShowAdvanced = checked;
	settingsController?.setShowAdvanced(checked);
}

type SettingsSwitchRowProps = {
	checked: boolean;
	disabled?: boolean;
	hidden?: boolean;
	id: string;
	label: string;
	onCheckedChange: (checked: boolean) => void;
	className?: string;
};

function SettingsSwitchRow({
	checked,
	className,
	disabled = false,
	hidden = false,
	id,
	label,
	onCheckedChange,
}: SettingsSwitchRowProps) {
	const labelId = `${id}Label`;
	return (
		<div
			className={
				className
					? `field-checkbox settings-switch-row ${className}`
					: "field-checkbox settings-switch-row"
			}
			hidden={hidden}
		>
			<label className="settings-switch-copy" htmlFor={id} id={labelId}>
				{label}
			</label>
			<RadixSwitch
				aria-labelledby={labelId}
				checked={checked}
				className="settings-switch"
				disabled={disabled}
				id={id}
				onCheckedChange={onCheckedChange}
				thumbClassName="settings-switch-thumb"
			/>
		</div>
	);
}

function hiddenUnlessAdvanced(): boolean {
	return !settingsShowAdvanced;
}

type ObserverStatusShape = {
	active?: {
		provider?: string;
		model?: string;
		auth?: {
			method?: string;
			token_present?: boolean;
		};
	} | null;
	available_credentials?: Record<string, Record<string, boolean>>;
	latest_failure?: {
		error_message?: string;
		observer_provider?: string;
		observer_model?: string;
		observer_runtime?: string;
		updated_at?: string;
		attempt_count?: number;
		impact?: string;
	} | null;
};

function ObserverStatusBanner() {
	const status = settingsRenderState.observerStatus as ObserverStatusShape | null;
	if (!status) {
		return <div id="observerStatusBanner" className="observer-status-banner" hidden />;
	}

	const active = status.active;
	const available = status.available_credentials || {};
	const failure = status.latest_failure;
	const credentialEntries = Object.entries(available).filter(
		([, creds]) => creds && typeof creds === "object",
	);

	return (
		<div id="observerStatusBanner" className="observer-status-banner">
			{active ? (
				<>
					<div className="status-label">Active observer</div>
					<div className="status-active">
						{String(active.provider || "unknown")} → {String(active.model || "")} via{" "}
						{formatAuthMethod(active.auth?.method || "none")}{" "}
						<span className={active.auth?.token_present === true ? "cred-ok" : "cred-none"}>
							{active.auth?.token_present === true ? "✓" : "✗"}
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
									{index > 0 ? " · " : null}
									<span className={hasAny ? "cred-ok" : "cred-none"}>{hasAny ? "✓" : "–"}</span>{" "}
									{String(provider)}: {formatCredentialSources(normalizedCreds)}
								</span>
							);
						})}
					</div>
				</>
			) : null}

			{failure && typeof failure === "object" ? (
				<>
					<div className="status-label">Latest processing issue</div>
					<div className="status-issue">
						<div className="status-issue-message">
							{typeof failure.error_message === "string" && failure.error_message.trim()
								? failure.error_message.trim()
								: "Raw-event processing failed."}
						</div>
						<div className="status-issue-meta">
							{[
								[
									typeof failure.observer_provider === "string"
										? failure.observer_provider.trim()
										: "",
									typeof failure.observer_model === "string" && failure.observer_model.trim()
										? `→ ${failure.observer_model.trim()}`
										: "",
									typeof failure.observer_runtime === "string" && failure.observer_runtime.trim()
										? `(${failure.observer_runtime.trim()})`
										: "",
								]
									.filter(Boolean)
									.join(" ")
									.replace(/\s+/g, " ")
									.trim(),
								`Last failure ${formatFailureTimestamp(failure.updated_at)}`,
								typeof failure.attempt_count === "number" && Number.isFinite(failure.attempt_count)
									? `Attempts ${failure.attempt_count}`
									: "",
							]
								.filter(Boolean)
								.join(" · ")}
						</div>
						{typeof failure.impact === "string" && failure.impact.trim() ? (
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
	className = "field",
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
	const observerMaxCharsDefault = state.configDefaults?.observer_max_chars || "";
	const showAuthFile = values.observerAuthSource === "file";
	const showAuthCommand = values.observerAuthSource === "command";
	const showTieredRouting = values.observerTierRoutingEnabled;
	const providerOptions = Array.from(
		new Set(
			settingsRenderState.providers.concat(
				values.observerProvider ? [values.observerProvider] : [],
			),
		),
	)
		.sort((left, right) => left.localeCompare(right))
		.map((provider) => ({ label: provider, value: provider }));

	return (
		<div className="modal-card">
			<div className="modal-header">
				<h2 id="settingsTitle">Settings</h2>
				<DialogCloseButton
					ariaLabel="Close settings"
					className="modal-close-button"
					onClick={() => {
						if (settingsStartPolling && settingsRefresh) {
							closeSettings(settingsStartPolling, settingsRefresh);
						}
					}}
				/>
			</div>
			<div className="modal-body">
				<div className="small" id="settingsDescription">
					Tune how codemem connects, processes work, and syncs with other devices.
				</div>
				<div className="settings-advanced-toolbar">
					<SettingsSwitchRow
						checked={settingsShowAdvanced}
						id="settingsAdvancedToggle"
						label="Show advanced controls"
						onCheckedChange={onAdvancedToggle}
					/>
					<button
						aria-label="About advanced controls"
						className="help-icon"
						data-tooltip="Advanced controls include JSON fields, tuning values, and network overrides."
						type="button"
					>
						<i aria-hidden="true" data-lucide="help-circle" />
					</button>
				</div>
				<SettingsHint hidden={!settingsShowAdvanced}>
					Advanced controls are visible. Leave JSON fields, tuning values, and network overrides
					alone unless you are debugging or matching a known deployment setup.
				</SettingsHint>

				<RadixTabs
					ariaLabel="Settings sections"
					listClassName="settings-tabs"
					onValueChange={setSettingsTab}
					tabs={SETTINGS_TABS}
					triggerClassName="settings-tab"
					value={settingsActiveTab}
				>
					<RadixTabsContent className="settings-panel" forceMount value="observer">
						<SettingsSectionIntro
							detail="Set how codemem reaches your model provider and where it should look for credentials."
							title="Connection and credentials"
						/>
						<ObserverStatusBanner />
						<div className="settings-group">
							<h3 className="settings-group-title">Connection</h3>
							<Field>
								<div className="field-label">
									<label htmlFor="observerProvider">Model provider</label>
									<button
										aria-label="About model provider"
										className="help-icon"
										data-tooltip="Choose where model requests are sent. Use auto for recommended defaults."
										type="button"
									>
										?
									</button>
								</div>
								<RadixSelect
									ariaLabel="Model provider"
									contentClassName="settings-select-content"
									id="observerProvider"
									itemClassName="settings-select-item"
									onValueChange={onSelectValueChange("observerProvider")}
									options={[{ label: "auto (default)", value: "" }, ...providerOptions]}
									placeholder="auto (default)"
									triggerClassName="settings-select-trigger"
									value={values.observerProvider}
									viewportClassName="settings-select-viewport"
								/>
								<div className="small">Use `auto` unless you need to pin a specific provider.</div>
							</Field>
							<Field>
								<div className="field-label">
									<label htmlFor="observerModel">{getObserverModelLabel()}</label>
									<button
										aria-label="About model defaults"
										className="help-icon"
										data-tooltip={getObserverModelTooltip()}
										type="button"
									>
										?
									</button>
								</div>
								<TextInput
									id="observerModel"
									onInput={onTextInput("observerModel")}
									placeholder="leave empty for default"
									value={values.observerModel}
								/>
								<div className="small">{getObserverModelDescription()}</div>
								<div className="small" id="observerModelHint">
									{getObserverModelHint()}
								</div>
							</Field>
							<Field>
								<div className="field-label">
									<label htmlFor="observerRuntime">Connection mode</label>
									<button
										aria-label="About connection mode"
										className="help-icon"
										data-tooltip="Direct API uses provider credentials. Local Claude session uses local Claude runtime auth."
										type="button"
									>
										?
									</button>
								</div>
								<RadixSelect
									ariaLabel="Connection mode"
									contentClassName="settings-select-content"
									id="observerRuntime"
									itemClassName="settings-select-item"
									onValueChange={onSelectValueChange("observerRuntime")}
									options={[
										{ label: "Direct API (default)", value: "api_http" },
										{ label: "Local Claude session", value: "claude_sidecar" },
									]}
									triggerClassName="settings-select-trigger"
									value={values.observerRuntime}
									viewportClassName="settings-select-viewport"
								/>
								<div className="small">
									Switch between provider API credentials and local Claude session auth.
								</div>
							</Field>
							<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="claudeCommand">Claude command (JSON argv)</label>
								<TextArea
									disabled
									id="claudeCommand"
									placeholder='["claude"]'
									rows={2}
									value={values.claudeCommand}
								/>
								<div className="small">{protectedConfigHelp("claude_command")}</div>
							</Field>
							<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="observerMaxChars">Request size limit (chars)</label>
								<TextInput
									id="observerMaxChars"
									min="1"
									onInput={onTextInput("observerMaxChars")}
									type="number"
									value={values.observerMaxChars}
								/>
								<div className="small" id="observerMaxCharsHint">
									{observerMaxCharsDefault ? `Default: ${observerMaxCharsDefault}` : ""}
								</div>
							</Field>
						</div>

						<div className="settings-group">
							<h3 className="settings-group-title">Authentication</h3>
							<Field>
								<div className="field-label">
									<label htmlFor="observerAuthSource">Authentication method</label>
									<button
										aria-label="About authentication method"
										className="help-icon"
										data-tooltip="Choose how credentials are resolved: environment, file, command, or none."
										type="button"
									>
										?
									</button>
								</div>
								<RadixSelect
									ariaLabel="Authentication method"
									contentClassName="settings-select-content"
									id="observerAuthSource"
									itemClassName="settings-select-item"
									onValueChange={onSelectValueChange("observerAuthSource")}
									options={[
										{ label: "auto (default)", value: "auto" },
										{ label: "env", value: "env" },
										{ label: "file", value: "file" },
										{ label: "command", value: "command" },
										{ label: "none", value: "none" },
									]}
									triggerClassName="settings-select-trigger"
									value={values.observerAuthSource}
									viewportClassName="settings-select-viewport"
								/>
								<div className="small">
									Use `auto` unless you need to force a file or command-based token source.
								</div>
							</Field>
							<Field hidden={!showAuthFile} id="observerAuthFileField">
								<label htmlFor="observerAuthFile">Token file path</label>
								<TextInput
									disabled
									id="observerAuthFile"
									placeholder="~/.codemem/work-token.txt"
									value={values.observerAuthFile}
								/>
								<div className="small">{protectedConfigHelp("observer_auth_file")}</div>
							</Field>
							<Field hidden={!showAuthCommand} id="observerAuthCommandField">
								<div className="field-label">
									<label htmlFor="observerAuthCommand">Token command</label>
									<button
										aria-label="About token command"
										className="help-icon"
										data-tooltip="Runs this command and uses stdout as the token. JSON argv only, no shell parsing."
										type="button"
									>
										?
									</button>
								</div>
								<TextArea
									disabled
									id="observerAuthCommand"
									placeholder='["iap-auth", "--audience", "gateway"]'
									rows={3}
									value={values.observerAuthCommand}
								/>
								<div className="small">{protectedConfigHelp("observer_auth_command")}</div>
							</Field>
							<div className="small" hidden={!showAuthCommand} id="observerAuthCommandNote">
								Command format: JSON string array, e.g. `["iap-auth", "--audience", "gateway"]`.
							</div>
							<SettingsHint hidden={hiddenUnlessAdvanced()}>
								These advanced credential overrides only matter when you need custom command timing,
								cached tokens, or extra request headers.
							</SettingsHint>
							<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="observerAuthTimeoutMs">Token command timeout (ms)</label>
								<TextInput
									id="observerAuthTimeoutMs"
									min="1"
									onInput={onTextInput("observerAuthTimeoutMs")}
									type="number"
									value={values.observerAuthTimeoutMs}
								/>
							</Field>
							<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="observerAuthCacheTtlS">Token cache time (s)</label>
								<TextInput
									id="observerAuthCacheTtlS"
									min="0"
									onInput={onTextInput("observerAuthCacheTtlS")}
									type="number"
									value={values.observerAuthCacheTtlS}
								/>
							</Field>
							<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<div className="field-label">
									<label htmlFor="observerHeaders">Request headers (JSON)</label>
									<button
										aria-label="About request headers"
										className="help-icon"
										data-tooltip={
											// biome-ignore lint/suspicious/noTemplateCurlyInString: literal documentation text describing the template placeholder syntax users can use in header values
											"Optional extra headers. Supports templates like ${auth.token}, ${auth.type}, ${auth.source}."
										}
										type="button"
									>
										?
									</button>
								</div>
								<TextArea
									disabled
									id="observerHeaders"
									placeholder='{"Authorization":"Bearer ${auth.token}"}'
									rows={4}
									value={values.observerHeaders}
								/>
								<div className="small">{protectedConfigHelp("observer_headers")}</div>
							</Field>
						</div>
					</RadixTabsContent>

					<RadixTabsContent className="settings-panel" forceMount value="queue">
						<SettingsSectionIntro
							detail="Control how often codemem processes queued work and, if needed, how it routes lighter vs richer model requests."
							title="Processing and routing"
						/>
						<div className="settings-group">
							<h3 className="settings-group-title">Processing</h3>
							<Field>
								<div className="field-label">
									<label htmlFor="rawEventsSweeperIntervalS">
										Background processing interval (seconds)
									</label>
									<button
										aria-label="About background processing interval"
										className="help-icon"
										data-tooltip="How often codemem checks for queued events to process in the background."
										type="button"
									>
										?
									</button>
								</div>
								<TextInput
									id="rawEventsSweeperIntervalS"
									min="1"
									onInput={onTextInput("rawEventsSweeperIntervalS")}
									type="number"
									value={values.rawEventsSweeperIntervalS}
								/>
								<div className="small">
									How often codemem checks for queued raw events in the background.
								</div>
							</Field>
						</div>
						<div className="settings-group">
							<h3 className="settings-group-title">Tiered observer routing</h3>
							<SettingsSwitchRow
								checked={values.observerTierRoutingEnabled}
								className="field"
								id="observerTierRoutingEnabled"
								label="Enable tiered routing"
								onCheckedChange={onSwitchInput("observerTierRoutingEnabled")}
							/>
							<div className="small">{getTieredRoutingHelperText()}</div>
							<SettingsHint hidden={!showTieredRouting || hiddenUnlessAdvanced()}>
								These advanced routing values are only useful when you are tuning model cost,
								latency, or output quality for a known workload.
							</SettingsHint>
							<Field hidden={!showTieredRouting}>
								<div className="field-label">
									<label htmlFor="observerSimpleModel">Simple tier model</label>
									<button
										aria-label="About simple tier model"
										className="help-icon"
										data-tooltip="Used for lighter replay batches. Leave blank to keep codemem's routing defaults or base observer fallback."
										type="button"
									>
										?
									</button>
								</div>
								<TextInput
									id="observerSimpleModel"
									onInput={onTextInput("observerSimpleModel")}
									placeholder="leave empty for default"
									value={values.observerSimpleModel}
								/>
								<div className="small">Used when a batch falls below rich-routing thresholds.</div>
							</Field>
							<Field hidden={!showTieredRouting}>
								<div className="field-label">
									<label htmlFor="observerRichModel">Rich tier model</label>
									<button
										aria-label="About rich tier model"
										className="help-icon"
										data-tooltip="Used for larger or more complex replay batches. Leave blank to keep codemem's rich-tier defaults."
										type="button"
									>
										?
									</button>
								</div>
								<TextInput
									id="observerRichModel"
									onInput={onTextInput("observerRichModel")}
									placeholder="leave empty for default"
									value={values.observerRichModel}
								/>
								<div className="small">Used when routing detects a richer replay batch.</div>
							</Field>
							<SettingsSwitchRow
								checked={values.observerRichOpenAIUseResponses}
								className="field"
								hidden={!showTieredRouting}
								id="observerRichOpenAIUseResponses"
								label="Use OpenAI Responses API for rich tier"
								onCheckedChange={onSwitchInput("observerRichOpenAIUseResponses")}
							/>
							<Field
								className="field settings-advanced"
								hidden={!showTieredRouting || hiddenUnlessAdvanced()}
							>
								<label htmlFor="observerSimpleTemperature">Simple tier temperature</label>
								<TextInput
									id="observerSimpleTemperature"
									min="0"
									onInput={onTextInput("observerSimpleTemperature")}
									step="0.1"
									type="number"
									value={values.observerSimpleTemperature}
								/>
							</Field>
							<Field
								className="field settings-advanced"
								hidden={!showTieredRouting || hiddenUnlessAdvanced()}
							>
								<label htmlFor="observerRichTemperature">Rich tier temperature</label>
								<TextInput
									id="observerRichTemperature"
									min="0"
									onInput={onTextInput("observerRichTemperature")}
									step="0.1"
									type="number"
									value={values.observerRichTemperature}
								/>
							</Field>
							<Field
								className="field settings-advanced"
								hidden={!showTieredRouting || hiddenUnlessAdvanced()}
							>
								<label htmlFor="observerRichReasoningEffort">Rich tier reasoning effort</label>
								<TextInput
									id="observerRichReasoningEffort"
									onInput={onTextInput("observerRichReasoningEffort")}
									placeholder="leave empty for default"
									value={values.observerRichReasoningEffort}
								/>
							</Field>
							<Field
								className="field settings-advanced"
								hidden={!showTieredRouting || hiddenUnlessAdvanced()}
							>
								<label htmlFor="observerRichReasoningSummary">Rich tier reasoning summary</label>
								<TextInput
									id="observerRichReasoningSummary"
									onInput={onTextInput("observerRichReasoningSummary")}
									placeholder="leave empty for default"
									value={values.observerRichReasoningSummary}
								/>
							</Field>
							<Field
								className="field settings-advanced"
								hidden={!showTieredRouting || hiddenUnlessAdvanced()}
							>
								<label htmlFor="observerRichMaxOutputTokens">Rich tier max output tokens</label>
								<TextInput
									id="observerRichMaxOutputTokens"
									min="1"
									onInput={onTextInput("observerRichMaxOutputTokens")}
									step="1"
									type="number"
									value={values.observerRichMaxOutputTokens}
								/>
							</Field>
						</div>
						<div className="settings-group settings-advanced" hidden={hiddenUnlessAdvanced()}>
							<h3 className="settings-group-title">Pack limits</h3>
							<SettingsHint hidden={hiddenUnlessAdvanced()}>
								Most users can keep these defaults. Change them only when you need smaller or larger
								default context packs.
							</SettingsHint>
							<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="packObservationLimit">Observation limit</label>
								<TextInput
									id="packObservationLimit"
									min="1"
									onInput={onTextInput("packObservationLimit")}
									type="number"
									value={values.packObservationLimit}
								/>
								<div className="small">Default number of observations to include in a pack.</div>
							</Field>
							<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="packSessionLimit">Session summary limit</label>
								<TextInput
									id="packSessionLimit"
									min="1"
									onInput={onTextInput("packSessionLimit")}
									type="number"
									value={values.packSessionLimit}
								/>
								<div className="small">
									Default number of session summaries to include in a pack.
								</div>
							</Field>
						</div>
					</RadixTabsContent>

					<RadixTabsContent className="settings-panel" forceMount value="sync">
						<SettingsSectionIntro
							detail="Choose whether this device syncs at all, how often it checks peers, and which coordinator group it should join."
							title="Device sync"
						/>
						<div className="settings-group">
							<h3 className="settings-group-title">Device Sync</h3>
							<SettingsSwitchRow
								checked={values.syncEnabled}
								className="field"
								id="syncEnabled"
								label="Enable sync"
								onCheckedChange={onSwitchInput("syncEnabled")}
							/>
							<div className="field">
								<label htmlFor="syncInterval">Sync interval (seconds)</label>
								<TextInput
									id="syncInterval"
									min="10"
									onInput={onTextInput("syncInterval")}
									type="number"
									value={values.syncInterval}
								/>
								<div className="small">
									How often this device checks for sync work when sync is enabled.
								</div>
							</div>
							<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="syncHost">Sync host</label>
								<TextInput
									id="syncHost"
									onInput={onTextInput("syncHost")}
									placeholder="127.0.0.1"
									value={values.syncHost}
								/>
							</div>
							<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="syncPort">Sync port</label>
								<TextInput
									id="syncPort"
									min="1"
									onInput={onTextInput("syncPort")}
									type="number"
									value={values.syncPort}
								/>
							</div>
							<SettingsSwitchRow
								checked={values.syncMdns}
								className="field settings-advanced"
								hidden={hiddenUnlessAdvanced()}
								id="syncMdns"
								label="Enable mDNS discovery"
								onCheckedChange={onSwitchInput("syncMdns")}
							/>
							<div className="field">
								<label htmlFor="syncCoordinatorUrl">Coordinator URL</label>
								<TextInput
									disabled
									id="syncCoordinatorUrl"
									placeholder="https://coord.example.com"
									value={values.syncCoordinatorUrl}
								/>
								<div className="small">{protectedConfigHelp("sync_coordinator_url")}</div>
							</div>
							<div className="field">
								<label htmlFor="syncCoordinatorGroup">Coordinator group</label>
								<TextInput
									id="syncCoordinatorGroup"
									onInput={onTextInput("syncCoordinatorGroup")}
									placeholder="team-alpha"
									value={values.syncCoordinatorGroup}
								/>
								<div className="small">
									Discovery namespace for peers using the same coordinator.
								</div>
							</div>
							<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<SettingsHint hidden={hiddenUnlessAdvanced()}>
									These network overrides are for unusual local-network setups. Leave them alone
									unless you know this device needs non-default sync discovery or coordinator
									timing.
								</SettingsHint>
							</div>
							<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="syncCoordinatorTimeout">Coordinator timeout (seconds)</label>
								<TextInput
									id="syncCoordinatorTimeout"
									min="1"
									onInput={onTextInput("syncCoordinatorTimeout")}
									type="number"
									value={values.syncCoordinatorTimeout}
								/>
							</div>
							<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
								<label htmlFor="syncCoordinatorPresenceTtl">Presence TTL (seconds)</label>
								<TextInput
									id="syncCoordinatorPresenceTtl"
									min="1"
									onInput={onTextInput("syncCoordinatorPresenceTtl")}
									type="number"
									value={values.syncCoordinatorPresenceTtl}
								/>
							</div>
						</div>
					</RadixTabsContent>
				</RadixTabs>

				<div className="small mono" id="settingsPath">
					{settingsRenderState.pathText}
				</div>
				<div className="small" id="settingsEffective">
					{settingsRenderState.effectiveText}
				</div>
				<div
					className="settings-note"
					hidden={!settingsRenderState.overridesVisible}
					id="settingsOverrides"
				>
					Some values are controlled outside this screen and take priority.
				</div>
				<div className="settings-note" hidden={settingsShowAdvanced}>
					Advanced controls are hidden right now to keep this screen focused on everyday settings.
				</div>
			</div>
			<div className="modal-footer">
				<div className="small" id="settingsStatus">
					{settingsRenderState.statusText}
				</div>
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
					{settingsRenderState.isSaving ? "Saving…" : "Save changes"}
				</button>
			</div>
		</div>
	);
}

export function initSettings(
	stopPolling: () => void,
	startPolling: () => void,
	refreshCallback: () => void,
) {
	settingsStartPolling = startPolling;
	settingsRefresh = refreshCallback;
	ensureSettingsShell();

	const settingsButton = $button("settingsButton");
	settingsButton?.addEventListener("click", () => openSettings(stopPolling));
}
