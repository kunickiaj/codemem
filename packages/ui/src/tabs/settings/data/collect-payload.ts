/* Flatten a SettingsFormState back into the config payload shape the
 * viewer expects. Validates JSON-array / number / temperature fields
 * and throws labeled errors for the save flow to surface. */

import { parseCommandArgv, parseObserverHeaders } from "./parse";
import type { SettingsFormState } from "./types";
import { normalizeTextValue } from "./value-helpers";

export interface CollectSettingsPayloadInput {
	values: SettingsFormState;
	touchedKeys: Set<string>;
	baseline: Record<string, unknown>;
	allowUntouchedParseErrors?: boolean;
}

export function collectSettingsPayload(
	input: CollectSettingsPayloadInput,
): Record<string, unknown> {
	const { values, touchedKeys, baseline } = input;
	const allowUntouchedParseErrors = input.allowUntouchedParseErrors === true;
	let claudeCommand: string[] = [];
	try {
		claudeCommand = parseCommandArgv(values.claudeCommand, {
			label: "claude command",
			normalize: true,
			requireNonEmpty: true,
		});
	} catch (error) {
		if (!allowUntouchedParseErrors || touchedKeys.has("claude_command")) {
			throw error;
		}
		const baselineValue = baseline.claude_command;
		claudeCommand = Array.isArray(baselineValue)
			? baselineValue
					.filter((item): item is string => typeof item === "string")
					.map((item) => item.trim())
					.filter((item) => item.length > 0)
			: [];
	}

	let authCommand: string[] = [];
	try {
		authCommand = parseCommandArgv(values.observerAuthCommand, { label: "observer auth command" });
	} catch (error) {
		if (!allowUntouchedParseErrors || touchedKeys.has("observer_auth_command")) {
			throw error;
		}
		const baselineValue = baseline.observer_auth_command;
		authCommand = Array.isArray(baselineValue)
			? baselineValue.filter((item): item is string => typeof item === "string")
			: [];
	}

	let headers: Record<string, string> = {};
	try {
		headers = parseObserverHeaders(values.observerHeaders);
	} catch (error) {
		if (!allowUntouchedParseErrors || touchedKeys.has("observer_headers")) {
			throw error;
		}
		const baselineValue = baseline.observer_headers;
		if (baselineValue && typeof baselineValue === "object" && !Array.isArray(baselineValue)) {
			Object.entries(baselineValue as Record<string, unknown>).forEach(([key, value]) => {
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
