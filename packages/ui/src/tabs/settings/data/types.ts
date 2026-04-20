/* Settings modal shared types. */

import type { ComponentChildren } from "preact";

export type SettingsTabId = "observer" | "queue" | "sync";

export type SettingsFormState = {
	claudeCommand: string;
	observerProvider: string;
	observerModel: string;
	observerTierRoutingEnabled: boolean;
	observerSimpleModel: string;
	observerSimpleTemperature: string;
	observerRichModel: string;
	observerRichTemperature: string;
	observerRichOpenAIUseResponses: boolean;
	observerRichReasoningEffort: string;
	observerRichReasoningSummary: string;
	observerRichMaxOutputTokens: string;
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

export type SettingsRenderState = {
	effectiveText: string;
	isSaving: boolean;
	observerStatus: unknown;
	overridesVisible: boolean;
	pathText: string;
	providers: string[];
	statusText: string;
	values: SettingsFormState;
};

export type SettingsSectionIntroProps = {
	title: string;
	detail: string;
};

export type SettingsHintProps = {
	children: ComponentChildren;
	hidden?: boolean;
};

export type SettingsTooltipState = {
	anchor: HTMLElement | null;
	content: string;
	visible: boolean;
};

export type SettingsController = {
	hideTooltip: () => void;
	setActiveTab: (tab: SettingsTabId) => void;
	setDirty: (dirty: boolean) => void;
	setOpen: (open: boolean) => void;
	setRenderState: (patch: Partial<SettingsRenderState>) => void;
	setShowAdvanced: (show: boolean) => void;
};
