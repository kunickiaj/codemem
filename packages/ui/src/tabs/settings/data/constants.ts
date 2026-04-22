/* Settings modal constants — tab ids, localStorage keys, defaults,
 * config-key mapping tables, and the empty form state. */

import type { RadixTabOption } from "../../../components/primitives/radix-tabs";
import type { SettingsFormState } from "./types";

export const SETTINGS_ADVANCED_KEY = "codemem-settings-advanced";

export const DEFAULT_OPENAI_MODEL = "gpt-5.1-codex-mini";
export const DEFAULT_ANTHROPIC_MODEL = "claude-4.5-haiku";

export const SETTINGS_TABS: RadixTabOption[] = [
	{ value: "observer", label: "Connection" },
	{ value: "queue", label: "Processing" },
	{ value: "sync", label: "Device Sync" },
];

export const INPUT_TO_CONFIG_KEY: Record<keyof SettingsFormState, string> = {
	claudeCommand: "claude_command",
	observerProvider: "observer_provider",
	observerModel: "observer_model",
	observerTierRoutingEnabled: "observer_tier_routing_enabled",
	observerSimpleModel: "observer_simple_model",
	observerSimpleTemperature: "observer_simple_temperature",
	observerRichModel: "observer_rich_model",
	observerRichTemperature: "observer_rich_temperature",
	observerRichReasoningEffort: "observer_rich_reasoning_effort",
	observerRichReasoningSummary: "observer_rich_reasoning_summary",
	observerRichMaxOutputTokens: "observer_rich_max_output_tokens",
	observerRuntime: "observer_runtime",
	observerAuthSource: "observer_auth_source",
	observerAuthFile: "observer_auth_file",
	observerAuthCommand: "observer_auth_command",
	observerAuthTimeoutMs: "observer_auth_timeout_ms",
	observerAuthCacheTtlS: "observer_auth_cache_ttl_s",
	observerHeaders: "observer_headers",
	observerMaxChars: "observer_max_chars",
	packObservationLimit: "pack_observation_limit",
	packSessionLimit: "pack_session_limit",
	rawEventsSweeperIntervalS: "raw_events_sweeper_interval_s",
	syncEnabled: "sync_enabled",
	syncHost: "sync_host",
	syncPort: "sync_port",
	syncInterval: "sync_interval_s",
	syncMdns: "sync_mdns",
	syncCoordinatorUrl: "sync_coordinator_url",
	syncCoordinatorGroup: "sync_coordinator_group",
	syncCoordinatorTimeout: "sync_coordinator_timeout_s",
	syncCoordinatorPresenceTtl: "sync_coordinator_presence_ttl_s",
};

export const PROTECTED_VIEWER_CONFIG_KEYS = new Set([
	"claude_command",
	"observer_base_url",
	"observer_auth_file",
	"observer_auth_command",
	"observer_headers",
	"sync_coordinator_url",
]);

export const EMPTY_FORM_STATE: SettingsFormState = {
	claudeCommand: "",
	observerProvider: "",
	observerModel: "",
	observerTierRoutingEnabled: false,
	observerSimpleModel: "",
	observerSimpleTemperature: "",
	observerRichModel: "",
	observerRichTemperature: "",
	observerRichReasoningEffort: "",
	observerRichReasoningSummary: "",
	observerRichMaxOutputTokens: "",
	observerRuntime: "api_http",
	observerAuthSource: "auto",
	observerAuthFile: "",
	observerAuthCommand: "",
	observerAuthTimeoutMs: "",
	observerAuthCacheTtlS: "",
	observerHeaders: "",
	observerMaxChars: "",
	packObservationLimit: "",
	packSessionLimit: "",
	rawEventsSweeperIntervalS: "",
	syncEnabled: false,
	syncHost: "",
	syncPort: "",
	syncInterval: "",
	syncMdns: false,
	syncCoordinatorUrl: "",
	syncCoordinatorGroup: "",
	syncCoordinatorTimeout: "",
	syncCoordinatorPresenceTtl: "",
};
