import { buildObserverRepairPrompt } from "./ingest-prompts.js";
import type { ParsedOutput } from "./ingest-types.js";
import {
	parseObserverResponse,
	shouldPreferRepairedObserverResponse,
	shouldRepairObserverResponse,
} from "./ingest-xml-parser.js";
import type {
	ObserverCallOutcome,
	ObserverClient,
	ObserverResponse,
	ObserverStatus,
	ObserverStructuredJsonResponse,
	ObserverTokenUsage,
} from "./observer-client.js";
import { ObserverAuthError } from "./observer-client.js";
import {
	normalizeObserverEnvelopeV1,
	OBSERVER_ENVELOPE_JSON_SCHEMA,
	OBSERVER_ENVELOPE_SCHEMA_NAME,
	OBSERVER_ENVELOPE_SCHEMA_VERSION,
	type ObserverEnvelopeFailureReason,
	parseObserverEnvelopeV1,
} from "./observer-output-schema.js";

export type ObserverOutputMode = "json_schema" | "forced_tool" | "legacy_xml";
export type ObserverOutputValidation = "valid" | "invalid" | "not_applicable";
export type ObserverOutputRetryReason =
	| "structured_output_truncated"
	| "rate_limited"
	| "provider_request_failed"
	| "observer_call_failed"
	| "observer_timeout";

export type ObserverOutputCapabilityReason =
	| "openai_responses_api_direct"
	| "anthropic_api_key_direct"
	| "configured_custom_gateway_json_schema"
	| "configured_legacy_xml"
	| "client_capability_unspecified"
	| "unsupported_auth_path"
	| "unsupported_custom_gateway"
	| "unsupported_provider"
	| "unsupported_runtime"
	| "openai_responses_disabled";

export interface ObserverOutputCapability {
	requestedMode: ObserverOutputMode;
	actualMode: Exclude<ObserverOutputMode, "forced_tool">;
	capabilityReason: ObserverOutputCapabilityReason;
	fallbackApplied: boolean;
	fallbackReason: ObserverOutputCapabilityReason | null;
}

export interface ObserverOutputDiagnostics extends ObserverOutputCapability {
	schemaVersion: number | null;
	validation: ObserverOutputValidation;
	failureReason: ObserverEnvelopeFailureReason | null;
	repairAttempted: boolean;
	retryAttempted: boolean;
	retryReason: ObserverOutputRetryReason | null;
}

export interface ObserverOutputAttempt {
	raw: string | null;
	parsed: ParsedOutput;
	provider: string;
	model: string;
	elapsedMs: number | null;
	usage: ObserverTokenUsage | null;
	status: ObserverStatus;
}

export interface NormalizedObserverOutput {
	initial: ObserverOutputAttempt;
	repaired: ObserverOutputAttempt | null;
	final: ObserverOutputAttempt;
	repairApplied: boolean;
	retryApplied: boolean;
	repairFailureStatus: ObserverStatus | null;
	diagnostics: ObserverOutputDiagnostics;
}

export interface ObserverOutputFailureTelemetry {
	totalElapsedMs: number | null;
	totalUsage: ObserverTokenUsage | null;
}

export class ObserverOutputError extends Error {
	readonly reason: ObserverEnvelopeFailureReason;
	readonly diagnostics: ObserverOutputDiagnostics;
	readonly telemetry: ObserverOutputFailureTelemetry;
	readonly outcome: ObserverCallOutcome | null;

	constructor(
		reason: ObserverEnvelopeFailureReason,
		diagnostics: ObserverOutputDiagnostics,
		telemetry: ObserverOutputFailureTelemetry,
		outcome: ObserverCallOutcome | null = null,
	) {
		super(`observer output failed validation (${reason})`);
		this.name = "ObserverOutputError";
		this.reason = reason;
		this.diagnostics = diagnostics;
		this.telemetry = telemetry;
		this.outcome = outcome;
	}
}

export class ObserverOutputTransportError extends Error {
	readonly code: string;
	readonly diagnostics: ObserverOutputDiagnostics;
	readonly telemetry: ObserverOutputFailureTelemetry;
	readonly outcome: ObserverCallOutcome | null;

	constructor(
		code: string,
		diagnostics: ObserverOutputDiagnostics,
		telemetry: ObserverOutputFailureTelemetry,
		outcome: ObserverCallOutcome | null = null,
	) {
		super(`observer request failed (${code})`);
		this.name = "ObserverOutputTransportError";
		this.code = code;
		this.diagnostics = diagnostics;
		this.telemetry = telemetry;
		this.outcome = outcome;
	}
}

function snapshotObserverStatus(
	observer: ObserverClient,
	response?: ObserverResponse,
): ObserverStatus {
	const status = observer.getStatus();
	const callError = response?.outcome?.error;
	const fallbackError = response?.outcome ? null : status.lastError;
	const snapshot: ObserverStatus = {
		...status,
		auth: { ...status.auth },
	};
	if (callError) snapshot.lastError = { ...callError };
	else if (fallbackError) snapshot.lastError = { ...fallbackError };
	else delete snapshot.lastError;
	return snapshot;
}

function snapshotObserverFailureStatus(observer: ObserverClient, error: unknown): ObserverStatus {
	const status = snapshotObserverStatus(observer);
	if (error instanceof ObserverAuthError) status.lastError = { ...error.detail };
	return status;
}

function isDirectOpenAIResponses(observer: ObserverClient, status: ObserverStatus): boolean {
	if (observer.provider !== "openai" || !observer.openaiUseResponses) return false;
	if (observer.runtime !== "api_http") return false;
	if (status.auth.type === "codex_consumer") return false;
	if (observer.hasCustomBaseUrl) return observer.outputMode === "json_schema";
	return status.auth.type === "api_direct";
}

function unsupportedCapabilityReason(
	observer: ObserverClient,
	status: ObserverStatus,
): ObserverOutputCapabilityReason {
	if (observer.runtime !== "api_http") return "unsupported_runtime";
	if (status.auth.type === "codex_consumer" || status.auth.type === "anthropic_consumer") {
		return "unsupported_auth_path";
	}
	if (observer.provider !== "openai" && observer.provider !== "anthropic") {
		return "unsupported_provider";
	}
	if (observer.hasCustomBaseUrl && observer.outputMode !== "json_schema") {
		return "unsupported_custom_gateway";
	}
	if (observer.provider === "openai" && !observer.openaiUseResponses) {
		return "openai_responses_disabled";
	}
	return "unsupported_auth_path";
}

export function resolveObserverOutputCapability(
	observer: ObserverClient,
): ObserverOutputCapability {
	if (observer.outputMode == null) {
		return {
			requestedMode: "legacy_xml",
			actualMode: "legacy_xml",
			capabilityReason: "client_capability_unspecified",
			fallbackApplied: false,
			fallbackReason: null,
		};
	}
	if (observer.outputMode === "legacy_xml") {
		return {
			requestedMode: "legacy_xml",
			actualMode: "legacy_xml",
			capabilityReason: "configured_legacy_xml",
			fallbackApplied: false,
			fallbackReason: null,
		};
	}

	const status = observer.getStatus();
	if (isDirectOpenAIResponses(observer, status)) {
		const capabilityReason = observer.hasCustomBaseUrl
			? "configured_custom_gateway_json_schema"
			: "openai_responses_api_direct";
		return {
			requestedMode: "json_schema",
			actualMode: "json_schema",
			capabilityReason,
			fallbackApplied: false,
			fallbackReason: null,
		};
	}
	if (
		observer.provider === "anthropic" &&
		observer.runtime === "api_http" &&
		status.auth.type === "api_direct" &&
		(!observer.hasCustomBaseUrl ||
			(observer.hasCustomAnthropicEndpoint && observer.outputMode === "json_schema"))
	) {
		return {
			requestedMode: "json_schema",
			actualMode: "json_schema",
			capabilityReason: observer.hasCustomBaseUrl
				? "configured_custom_gateway_json_schema"
				: "anthropic_api_key_direct",
			fallbackApplied: false,
			fallbackReason: null,
		};
	}

	const reason = unsupportedCapabilityReason(observer, status);
	return {
		requestedMode: "json_schema",
		actualMode: "legacy_xml",
		capabilityReason: reason,
		fallbackApplied: true,
		fallbackReason: reason,
	};
}

function emptyParsedOutput(): ParsedOutput {
	return { observations: [], summary: null, skipSummaryReason: null };
}

function toAttempt(
	observer: ObserverClient,
	response: ObserverResponse,
	parsed: ParsedOutput,
): ObserverOutputAttempt {
	return {
		raw: response.raw,
		parsed,
		provider: response.provider,
		model: response.model,
		elapsedMs: response.elapsedMs ?? null,
		usage: response.usage ?? null,
		status: snapshotObserverStatus(observer, response),
	};
}

function buildDiagnostics(
	capability: ObserverOutputCapability,
	overrides: Partial<
		Pick<
			ObserverOutputDiagnostics,
			"validation" | "failureReason" | "repairAttempted" | "retryAttempted" | "retryReason"
		>
	>,
): ObserverOutputDiagnostics {
	return {
		...capability,
		schemaVersion:
			capability.actualMode === "json_schema" ? OBSERVER_ENVELOPE_SCHEMA_VERSION : null,
		validation: overrides.validation ?? "not_applicable",
		failureReason: overrides.failureReason ?? null,
		repairAttempted: overrides.repairAttempted ?? false,
		retryAttempted: overrides.retryAttempted ?? false,
		retryReason: overrides.retryReason ?? null,
	};
}

function observerOutputRetryReason(
	response: ObserverStructuredJsonResponse,
): ObserverOutputRetryReason | null {
	if (response.failureReason === "structured_output_truncated") {
		return "structured_output_truncated";
	}
	if (
		response.transportFailureCode === "rate_limited" ||
		response.transportFailureCode === "observer_call_failed" ||
		response.transportFailureCode === "observer_timeout"
	) {
		return response.transportFailureCode;
	}
	if (
		response.transportFailureCode === "provider_request_failed" &&
		response.httpStatus != null &&
		(response.httpStatus === 408 || response.httpStatus === 425 || response.httpStatus >= 500)
	) {
		return "provider_request_failed";
	}
	return null;
}

function sumObserverUsage(
	first: ObserverTokenUsage | null | undefined,
	second: ObserverTokenUsage | null | undefined,
): ObserverTokenUsage | null {
	if (first == null || second === null) return null;
	if (second === undefined) return { ...first };
	return {
		inputTokens: first.inputTokens + second.inputTokens,
		outputTokens: first.outputTokens + second.outputTokens,
		totalTokens:
			(first.totalTokens ?? first.inputTokens + first.outputTokens) +
			(second.totalTokens ?? second.inputTokens + second.outputTokens),
		cacheReadInputTokens: (first.cacheReadInputTokens ?? 0) + (second.cacheReadInputTokens ?? 0),
		cacheCreationInputTokens:
			(first.cacheCreationInputTokens ?? 0) + (second.cacheCreationInputTokens ?? 0),
	};
}

export function observerOutputTotalUsage(
	output: NormalizedObserverOutput,
): ObserverTokenUsage | null {
	if (observerOutputAttemptCount(output) > 1 && output.repaired == null) return null;
	return sumObserverUsage(output.initial.usage, output.repaired?.usage);
}

export function observerOutputAttemptCount(output: NormalizedObserverOutput): number {
	return output.diagnostics.repairAttempted || output.diagnostics.retryAttempted ? 2 : 1;
}

function failureTelemetry(
	first: ObserverStructuredJsonResponse,
	second: ObserverStructuredJsonResponse | null,
): ObserverOutputFailureTelemetry {
	const secondAttempted = second != null;
	const totalElapsedMs =
		first.elapsedMs != null && (!secondAttempted || second.elapsedMs != null)
			? first.elapsedMs + (second?.elapsedMs ?? 0)
			: null;
	return {
		totalElapsedMs,
		totalUsage: sumObserverUsage(first.usage, second === null ? undefined : second.usage),
	};
}

function structuredResponseFailure(
	response: ObserverStructuredJsonResponse,
	capability: ObserverOutputCapability,
	retryDiagnostics: Pick<ObserverOutputDiagnostics, "retryAttempted" | "retryReason">,
	telemetry: ObserverOutputFailureTelemetry,
): ObserverOutputError | ObserverOutputTransportError | null {
	if (response.transportFailureCode) {
		return new ObserverOutputTransportError(
			response.transportFailureCode,
			buildDiagnostics(capability, { validation: "invalid", ...retryDiagnostics }),
			telemetry,
			response.outcome ?? null,
		);
	}
	if (response.failureReason) {
		return new ObserverOutputError(
			response.failureReason,
			buildDiagnostics(capability, {
				validation: "invalid",
				failureReason: response.failureReason,
				...retryDiagnostics,
			}),
			telemetry,
			response.outcome ?? null,
		);
	}
	if (response.usedStructuredOutputs && response.raw != null) return null;
	return new ObserverOutputError(
		"structured_output_missing",
		buildDiagnostics(capability, {
			validation: "invalid",
			failureReason: "structured_output_missing",
			...retryDiagnostics,
		}),
		telemetry,
		response.outcome ?? null,
	);
}

async function observeJsonSchema(
	observer: ObserverClient,
	system: string,
	user: string,
	capability: ObserverOutputCapability,
): Promise<NormalizedObserverOutput> {
	const invoke = () =>
		observer.observeStructuredJson(
			system,
			user,
			OBSERVER_ENVELOPE_SCHEMA_NAME,
			OBSERVER_ENVELOPE_JSON_SCHEMA,
		);
	const firstResponse = await invoke();
	const retryReason = observerOutputRetryReason(firstResponse);
	const retryResponse = retryReason ? await invoke() : null;
	const response = retryResponse ?? firstResponse;
	const retryDiagnostics = {
		retryAttempted: retryReason != null,
		retryReason,
	};
	const telemetry = failureTelemetry(firstResponse, retryResponse);
	const responseFailure = structuredResponseFailure(
		response,
		capability,
		retryDiagnostics,
		telemetry,
	);
	if (responseFailure) throw responseFailure;

	const parsedEnvelope = parseObserverEnvelopeV1(response.raw as string);
	if (!parsedEnvelope.ok) {
		throw new ObserverOutputError(
			parsedEnvelope.reason,
			buildDiagnostics(capability, {
				validation: "invalid",
				failureReason: parsedEnvelope.reason,
				...retryDiagnostics,
			}),
			telemetry,
			response.outcome ?? null,
		);
	}

	const finalAttempt = toAttempt(
		observer,
		response,
		normalizeObserverEnvelopeV1(parsedEnvelope.envelope),
	);
	return {
		initial: retryReason ? toAttempt(observer, firstResponse, emptyParsedOutput()) : finalAttempt,
		repaired: retryReason ? finalAttempt : null,
		final: finalAttempt,
		repairApplied: false,
		retryApplied: retryReason != null,
		repairFailureStatus: null,
		diagnostics: buildDiagnostics(capability, {
			validation: "valid",
			retryAttempted: retryReason != null,
			retryReason,
		}),
	};
}

function failedLegacyRepairOutput(
	initial: ObserverOutputAttempt,
	capability: ObserverOutputCapability,
	repairFailureStatus: ObserverStatus,
): NormalizedObserverOutput {
	return {
		initial,
		repaired: null,
		final: initial,
		repairApplied: false,
		retryApplied: false,
		repairFailureStatus,
		diagnostics: buildDiagnostics(capability, {
			repairAttempted: true,
			failureReason: "legacy_xml_lossy",
		}),
	};
}

async function observeLegacyXml(
	observer: ObserverClient,
	system: string,
	user: string,
	capability: ObserverOutputCapability,
): Promise<NormalizedObserverOutput> {
	const firstResponse = await observer.observe(system, user);
	const firstParsed = firstResponse.raw
		? parseObserverResponse(firstResponse.raw)
		: emptyParsedOutput();
	const initial = toAttempt(observer, firstResponse, firstParsed);
	if (!shouldRepairObserverResponse(firstResponse.raw, firstParsed)) {
		return {
			initial,
			repaired: null,
			final: initial,
			repairApplied: false,
			retryApplied: false,
			repairFailureStatus: null,
			diagnostics: buildDiagnostics(capability, {}),
		};
	}

	const repairPrompt = buildObserverRepairPrompt(
		system,
		user,
		firstResponse.raw as string,
		observer.maxChars,
	);
	let repairResponse: ObserverResponse;
	try {
		repairResponse = await observer.observe(repairPrompt.system, repairPrompt.user);
	} catch (error) {
		return failedLegacyRepairOutput(
			initial,
			capability,
			snapshotObserverFailureStatus(observer, error),
		);
	}
	const repairedParsed = repairResponse.raw
		? parseObserverResponse(repairResponse.raw)
		: emptyParsedOutput();
	const repaired = toAttempt(observer, repairResponse, repairedParsed);
	const repairApplied = shouldPreferRepairedObserverResponse(
		firstParsed,
		repairResponse.raw,
		repairedParsed,
		firstResponse.raw,
	);
	const final = repairApplied ? repaired : initial;
	const failureReason = shouldRepairObserverResponse(final.raw, final.parsed)
		? "legacy_xml_lossy"
		: null;
	return {
		initial,
		repaired,
		final,
		repairApplied,
		retryApplied: false,
		repairFailureStatus: null,
		diagnostics: buildDiagnostics(capability, { repairAttempted: true, failureReason }),
	};
}

export function observerOutputFailureStatus(output: NormalizedObserverOutput): ObserverStatus {
	return output.repairFailureStatus ?? output.repaired?.status ?? output.final.status;
}

export async function observeAndNormalizeObserverOutput(
	observer: ObserverClient,
	system: string,
	user: string,
	capability = resolveObserverOutputCapability(observer),
): Promise<NormalizedObserverOutput> {
	if (capability.actualMode === "json_schema") {
		return observeJsonSchema(observer, system, user, capability);
	}
	return observeLegacyXml(observer, system, user, capability);
}

export function observerOutputMetadata(output: NormalizedObserverOutput): Record<string, unknown> {
	const { diagnostics } = output;
	const repairAttempt = diagnostics.repairAttempted ? output.repaired : null;
	const retryAttempt = diagnostics.retryAttempted ? output.repaired : null;
	return {
		observer_requested_output_mode: diagnostics.requestedMode,
		observer_output_mode: diagnostics.actualMode,
		observer_output_schema_version: diagnostics.schemaVersion,
		observer_output_capability_reason: diagnostics.capabilityReason,
		observer_output_fallback_applied: diagnostics.fallbackApplied,
		observer_output_fallback_reason: diagnostics.fallbackReason,
		observer_output_validation: diagnostics.validation,
		observer_output_failure_reason: diagnostics.failureReason,
		observer_output_repair_attempted: diagnostics.repairAttempted,
		observer_output_retry_attempted: diagnostics.retryAttempted,
		observer_output_retry_reason: diagnostics.retryReason,
		observer_output_initial_elapsed_ms: output.initial.elapsedMs,
		observer_output_initial_usage: output.initial.usage,
		observer_output_repair_elapsed_ms: repairAttempt?.elapsedMs ?? null,
		observer_output_repair_usage: repairAttempt?.usage ?? null,
		observer_output_retry_elapsed_ms: retryAttempt?.elapsedMs ?? null,
		observer_output_retry_usage: retryAttempt?.usage ?? null,
	};
}
