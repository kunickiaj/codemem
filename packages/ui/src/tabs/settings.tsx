/* Settings modal — observer config, sync settings. */

import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { RadixDialog } from "../components/primitives/radix-dialog";
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

import { SettingsModalContent } from "./settings/components/SettingsModalContent";
import { EMPTY_FORM_STATE, PROTECTED_VIEWER_CONFIG_KEYS } from "./settings/data/constants";
import { createSettingsEventHandlers } from "./settings/data/event-handlers";
import type {
	SettingsController,
	SettingsFormState,
	SettingsPanelProps,
	SettingsRenderState,
	SettingsTabId,
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

import {
	getObserverModelDescription as getObserverModelDescriptionRaw,
	getObserverModelHint as getObserverModelHintRaw,
	getObserverModelLabel as getObserverModelLabelRaw,
	getObserverModelTooltip as getObserverModelTooltipRaw,
	getTieredRoutingHelperText as getTieredRoutingHelperTextRaw,
	hiddenUnlessAdvanced as hiddenUnlessAdvancedRaw,
	isProtectedConfigKey as isProtectedConfigKeyRaw,
	protectedConfigHelp,
} from "./settings/data/model-accessors";
import {
	loadAdvancedPreference,
	mergeOverrideBaseline,
	persistAdvancedPreference,
	toProviderList,
} from "./settings/data/value-helpers";

const getObserverModelHint = (): string =>
	getObserverModelHintRaw(settingsRenderState.values, settingsEnvOverrides);
const getTieredRoutingHelperText = (): string =>
	getTieredRoutingHelperTextRaw(settingsRenderState.values);
const getObserverModelLabel = (): string => getObserverModelLabelRaw(settingsRenderState.values);
const getObserverModelTooltip = (): string =>
	getObserverModelTooltipRaw(settingsRenderState.values);
const getObserverModelDescription = (): string =>
	getObserverModelDescriptionRaw(settingsRenderState.values);

import { focusSettingsDialog } from "./settings/data/dom";
import { useHelpTooltip } from "./settings/hooks/use-help-tooltip";

function hideHelpTooltip() {
	settingsController?.hideTooltip();
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
	const { tooltipPortal, setTooltip } = useHelpTooltip();

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

import { buildSettingsNotice } from "./settings/data/notice";

const isProtectedConfigKey = (key: string): boolean =>
	isProtectedConfigKeyRaw(key, settingsProtectedKeys, PROTECTED_VIEWER_CONFIG_KEYS);

import { type ConfigPayload, formStateFromPayload } from "./settings/data/form-state";

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

import { collectSettingsPayload as collectSettingsPayloadRaw } from "./settings/data/collect-payload";
import { diffSettingsPayload } from "./settings/data/diff-payload";

function collectSettingsPayload(
	options: { allowUntouchedParseErrors?: boolean } = {},
): Record<string, unknown> {
	return collectSettingsPayloadRaw({
		values: settingsRenderState.values,
		touchedKeys: settingsTouchedKeys,
		baseline: settingsBaseline,
		allowUntouchedParseErrors: options.allowUntouchedParseErrors,
	});
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
		const changed = diffSettingsPayload({
			current,
			baseline: settingsBaseline,
			envOverrides: settingsEnvOverrides,
			touchedKeys: settingsTouchedKeys,
			isProtected: isProtectedConfigKey,
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

const { onTextInput, onSelectValueChange, onSwitchInput } = createSettingsEventHandlers({
	getTouchedKeys: () => settingsTouchedKeys,
	getValues: () => settingsRenderState.values,
	updateFormState,
	setDirty: (dirty) => setDirty(dirty),
});

function onAdvancedToggle(checked: boolean) {
	settingsShowAdvanced = checked;
	settingsController?.setShowAdvanced(checked);
}

const hiddenUnlessAdvanced = (): boolean => hiddenUnlessAdvancedRaw(settingsShowAdvanced);

import {
	ObserverStatusBanner as ObserverStatusBannerComponent,
	type ObserverStatusShape,
} from "./settings/components/ObserverStatusBanner";

function ObserverStatusBanner() {
	const status = settingsRenderState.observerStatus as ObserverStatusShape | null;
	return <ObserverStatusBannerComponent status={status} />;
}

function SettingsDialogContent() {
	const values = settingsRenderState.values;
	const observerMaxCharsDefault = String(state.configDefaults?.observer_max_chars || "");
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

	const panelProps: SettingsPanelProps = {
		values,
		observerMaxCharsDefault,
		providerOptions,
		showAuthFile,
		showAuthCommand,
		showTieredRouting,
		hiddenUnlessAdvanced,
		onTextInput,
		onSelectValueChange,
		onSwitchInput,
		getObserverModelLabel,
		getObserverModelTooltip,
		getObserverModelDescription,
		getObserverModelHint,
		getTieredRoutingHelperText,
		protectedConfigHelp,
	};

	return (
		<SettingsModalContent
			panelProps={panelProps}
			activeTab={settingsActiveTab}
			showAdvanced={settingsShowAdvanced}
			renderState={settingsRenderState}
			settingsDirty={state.settingsDirty}
			onClose={() => {
				if (settingsStartPolling && settingsRefresh) {
					closeSettings(settingsStartPolling, settingsRefresh);
				}
			}}
			onSave={() => {
				if (settingsStartPolling && settingsRefresh) {
					void saveSettings(settingsStartPolling, settingsRefresh);
				}
			}}
			onActiveTabChange={setSettingsTab}
			onAdvancedToggle={onAdvancedToggle}
			observerStatusBannerSlot={<ObserverStatusBanner />}
		/>
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
