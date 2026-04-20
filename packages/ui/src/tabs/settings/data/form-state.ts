/* Convert a viewer /settings config payload into the flat
 * SettingsFormState the UI renders from. Pure — no module state. */

import type { SettingsFormState } from "./types";
import { asBooleanValue, asInputString, effectiveOrConfigured } from "./value-helpers";

export interface ConfigPayload {
	config?: Record<string, unknown>;
	effective?: Record<string, unknown>;
	defaults?: Record<string, unknown>;
	env_overrides?: Record<string, unknown>;
	protected_keys?: unknown;
	providers?: unknown;
	path?: string;
}

export function formStateFromPayload(payload: ConfigPayload): SettingsFormState {
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
