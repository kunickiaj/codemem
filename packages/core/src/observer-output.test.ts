import { describe, expect, it, vi } from "vitest";
import type { ObserverClient, ObserverStatus } from "./observer-client.js";
import {
	type ObserverOutputError,
	observeAndNormalizeObserverOutput,
	observerOutputMetadata,
	resolveObserverOutputCapability,
} from "./observer-output.js";

const status = (overrides: Partial<ObserverStatus> = {}): ObserverStatus => ({
	provider: "openai",
	model: "test-model",
	runtime: "api_http",
	auth: { source: "test", type: "api_direct", hasToken: true },
	...overrides,
});

function fakeObserver(
	overrides: Partial<ObserverClient> & {
		status?: ObserverStatus;
		structuredRaw?: string | null;
		structuredFailure?: ObserverOutputError["reason"] | null;
		transportFailureCode?: string | null;
		httpStatus?: number | null;
	} = {},
): ObserverClient {
	const observerStatus = overrides.status ?? status();
	return {
		provider: observerStatus.provider,
		model: observerStatus.model,
		runtime: observerStatus.runtime,
		openaiUseResponses: true,
		outputMode: "auto",
		hasCustomBaseUrl: false,
		maxChars: 12_000,
		getStatus: () => observerStatus,
		observe: vi.fn(async () => ({
			raw: null,
			parsed: null,
			provider: observerStatus.provider,
			model: observerStatus.model,
			elapsedMs: 2,
			usage: null,
		})),
		observeStructuredJson: vi.fn(async () => ({
			raw: overrides.structuredRaw ?? null,
			parsed: null,
			provider: observerStatus.provider,
			model: observerStatus.model,
			elapsedMs: 3,
			usage: null,
			usedStructuredOutputs: true,
			failureReason: overrides.structuredFailure ?? null,
			transportFailureCode: overrides.transportFailureCode ?? null,
			httpStatus: overrides.httpStatus ?? null,
		})),
		...overrides,
	} as unknown as ObserverClient;
}

const capturedEnvelope = JSON.stringify({
	schema_version: 1,
	status: "captured",
	observations: [
		{
			kind: "decision",
			title: "Use schema output",
			narrative: "The observer now uses a versioned envelope.",
			subtitle: null,
			facts: ["The schema version is one."],
			concepts: ["what-changed"],
			files_read: [],
			files_modified: ["packages/core/src/observer-output.ts"],
		},
	],
	summary: null,
	skip_reason: null,
});

describe("resolveObserverOutputCapability", () => {
	it("selects native JSON Schema only for proven direct API paths", () => {
		expect(resolveObserverOutputCapability(fakeObserver()).actualMode).toBe("json_schema");

		const anthropic = fakeObserver({
			provider: "anthropic",
			openaiUseResponses: false,
			status: status({
				provider: "anthropic",
				auth: { source: "test", type: "api_direct", hasToken: true },
			}),
		});
		expect(resolveObserverOutputCapability(anthropic)).toEqual(
			expect.objectContaining({
				actualMode: "json_schema",
				capabilityReason: "anthropic_api_key_direct",
			}),
		);
	});

	it("preselects XML for OAuth, sidecars, and unknown custom gateways", () => {
		const oauth = fakeObserver({
			status: status({
				auth: { source: "oauth", type: "codex_consumer", hasToken: true },
			}),
		});
		const sidecar = fakeObserver({
			runtime: "claude_sidecar",
			status: status({
				runtime: "claude_sidecar",
				auth: { source: "none", type: "claude_sidecar", hasToken: false },
			}),
		});
		const custom = fakeObserver({ hasCustomBaseUrl: true, openaiUseResponses: false });

		expect(resolveObserverOutputCapability(oauth).actualMode).toBe("legacy_xml");
		expect(resolveObserverOutputCapability(sidecar).actualMode).toBe("legacy_xml");
		expect(resolveObserverOutputCapability(custom)).toEqual(
			expect.objectContaining({
				actualMode: "legacy_xml",
				fallbackApplied: true,
				fallbackReason: "unsupported_custom_gateway",
			}),
		);
	});

	it("allows an explicitly Responses-enabled custom gateway to use JSON Schema", () => {
		const observer = fakeObserver({
			hasCustomBaseUrl: true,
			openaiUseResponses: true,
			outputMode: "json_schema",
		});
		expect(resolveObserverOutputCapability(observer)).toEqual(
			expect.objectContaining({
				actualMode: "json_schema",
				fallbackApplied: false,
				capabilityReason: "configured_custom_gateway_json_schema",
			}),
		);
	});

	it("preselects XML for an Anthropic custom gateway unless JSON Schema is explicit", () => {
		const observer = fakeObserver({
			provider: "anthropic",
			openaiUseResponses: false,
			hasCustomBaseUrl: true,
			status: status({
				provider: "anthropic",
				auth: { source: "test", type: "api_direct", hasToken: true },
			}),
		});

		expect(resolveObserverOutputCapability(observer)).toEqual(
			expect.objectContaining({
				actualMode: "legacy_xml",
				fallbackReason: "unsupported_custom_gateway",
			}),
		);

		const explicitObserver = fakeObserver({
			provider: "anthropic",
			openaiUseResponses: false,
			hasCustomBaseUrl: true,
			hasCustomAnthropicEndpoint: true,
			outputMode: "json_schema",
			status: status({
				provider: "anthropic",
				auth: { source: "test", type: "api_direct", hasToken: true },
			}),
		});
		expect(resolveObserverOutputCapability(explicitObserver)).toEqual(
			expect.objectContaining({
				actualMode: "json_schema",
				fallbackApplied: false,
				capabilityReason: "configured_custom_gateway_json_schema",
			}),
		);
	});

	it("supports a configuration-only rollback to legacy XML", () => {
		const observer = fakeObserver({ outputMode: "legacy_xml" });
		expect(resolveObserverOutputCapability(observer)).toEqual({
			requestedMode: "legacy_xml",
			actualMode: "legacy_xml",
			capabilityReason: "configured_legacy_xml",
			fallbackApplied: false,
			fallbackReason: null,
		});
	});
});

describe("observeAndNormalizeObserverOutput", () => {
	it("normalizes a valid constrained envelope without XML repair", async () => {
		const observer = fakeObserver({ structuredRaw: capturedEnvelope });
		const output = await observeAndNormalizeObserverOutput(observer, "system", "user");

		expect(output.final.parsed.observations).toEqual([
			expect.objectContaining({
				kind: "decision",
				title: "Use schema output",
				filesModified: ["packages/core/src/observer-output.ts"],
			}),
		]);
		expect(output.diagnostics).toEqual(
			expect.objectContaining({
				actualMode: "json_schema",
				schemaVersion: 1,
				validation: "valid",
				repairAttempted: false,
			}),
		);
		expect(observer.observe).not.toHaveBeenCalled();
	});
});

describe("observeAndNormalizeObserverOutput failures and compatibility", () => {
	it.each([
		"structured_output_refused",
		"structured_output_truncated",
		"structured_output_missing",
	] as const)("fails closed for %s", async (reason) => {
		const observer = fakeObserver({ structuredFailure: reason });
		const promise = observeAndNormalizeObserverOutput(observer, "system", "user");
		await expect(promise).rejects.toMatchObject({
			name: "ObserverOutputError",
			reason,
			diagnostics: { failureReason: reason, validation: "invalid" },
		});
		expect(observer.observe).not.toHaveBeenCalled();
	});

	it("retries a transient transport failure before reporting it", async () => {
		const observer = fakeObserver({ transportFailureCode: "rate_limited" });
		const promise = observeAndNormalizeObserverOutput(observer, "system", "user");

		await expect(promise).rejects.toMatchObject({
			name: "ObserverOutputTransportError",
			code: "rate_limited",
		});
		expect(observer.observeStructuredJson).toHaveBeenCalledTimes(2);
	});

	it("does not retry deterministic provider request failures", async () => {
		const observer = fakeObserver({
			transportFailureCode: "provider_request_failed",
			httpStatus: 400,
		});

		await expect(
			observeAndNormalizeObserverOutput(observer, "system", "user"),
		).rejects.toMatchObject({
			name: "ObserverOutputTransportError",
			code: "provider_request_failed",
			diagnostics: { retryAttempted: false },
		});
		expect(observer.observeStructuredJson).toHaveBeenCalledTimes(1);
	});

	it("retries transient provider server failures", async () => {
		const observer = fakeObserver({
			transportFailureCode: "provider_request_failed",
			httpStatus: 503,
		});

		await expect(
			observeAndNormalizeObserverOutput(observer, "system", "user"),
		).rejects.toMatchObject({
			name: "ObserverOutputTransportError",
			code: "provider_request_failed",
			diagnostics: {
				retryAttempted: true,
				retryReason: "provider_request_failed",
			},
		});
		expect(observer.observeStructuredJson).toHaveBeenCalledTimes(2);
	});

	it("records a successful transport retry separately from XML repair", async () => {
		const observeStructuredJson = vi
			.fn()
			.mockResolvedValueOnce({
				raw: null,
				parsed: null,
				provider: "openai",
				model: "test-model",
				elapsedMs: 2,
				usage: null,
				usedStructuredOutputs: true,
				failureReason: null,
				transportFailureCode: "rate_limited",
			})
			.mockResolvedValueOnce({
				raw: capturedEnvelope,
				parsed: null,
				provider: "openai",
				model: "test-model",
				elapsedMs: 3,
				usage: null,
				usedStructuredOutputs: true,
				failureReason: null,
				transportFailureCode: null,
			});
		const output = await observeAndNormalizeObserverOutput(
			fakeObserver({ observeStructuredJson }),
			"system",
			"user",
		);

		expect(output.repairApplied).toBe(false);
		expect(output.retryApplied).toBe(true);
		expect(output.diagnostics).toEqual(
			expect.objectContaining({
				repairAttempted: false,
				retryAttempted: true,
				retryReason: "rate_limited",
			}),
		);
		expect(observerOutputMetadata(output)).toEqual(
			expect.objectContaining({
				observer_output_repair_elapsed_ms: null,
				observer_output_repair_usage: null,
				observer_output_retry_elapsed_ms: 3,
				observer_output_retry_usage: null,
			}),
		);
	});

	it("preserves retry diagnostics and telemetry when the retry output is invalid", async () => {
		const observeStructuredJson = vi
			.fn()
			.mockResolvedValueOnce({
				raw: null,
				parsed: null,
				provider: "openai",
				model: "test-model",
				elapsedMs: 2,
				usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
				usedStructuredOutputs: true,
				failureReason: "structured_output_truncated",
				transportFailureCode: null,
			})
			.mockResolvedValueOnce({
				raw: null,
				parsed: null,
				provider: "openai",
				model: "test-model",
				elapsedMs: 3,
				usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 },
				usedStructuredOutputs: true,
				failureReason: "structured_output_refused",
				transportFailureCode: null,
			});

		await expect(
			observeAndNormalizeObserverOutput(fakeObserver({ observeStructuredJson }), "system", "user"),
		).rejects.toMatchObject({
			reason: "structured_output_refused",
			diagnostics: {
				retryAttempted: true,
				retryReason: "structured_output_truncated",
			},
			telemetry: {
				totalElapsedMs: 5,
				totalUsage: { inputTokens: 18, outputTokens: 3, totalTokens: 21 },
			},
		});
	});

	it("classifies invalid JSON without reparsing it as XML", async () => {
		const observer = fakeObserver({ structuredRaw: "<observation>not json</observation>" });
		await expect(
			observeAndNormalizeObserverOutput(observer, "system", "user"),
		).rejects.toMatchObject({ reason: "structured_output_invalid_json" });
		expect(observer.observe).not.toHaveBeenCalled();
	});

	it("classifies schema-invalid JSON without invoking XML repair", async () => {
		const observer = fakeObserver({
			structuredRaw: JSON.stringify({ schema_version: 1, status: "captured" }),
		});
		await expect(
			observeAndNormalizeObserverOutput(observer, "system", "user"),
		).rejects.toMatchObject({ reason: "structured_output_schema_invalid" });
		expect(observer.observe).not.toHaveBeenCalled();
	});

	it("keeps legacy XML parsing and repair on the preselected XML path", async () => {
		const observe = vi
			.fn()
			.mockResolvedValueOnce({
				raw: "<observation><type>note</type><title>Use XML</title></observation>",
				parsed: null,
				provider: "openai",
				model: "test-model",
				elapsedMs: 2,
				usage: null,
			})
			.mockResolvedValueOnce({
				raw: "<observation><type>decision</type><title>Use XML</title></observation>",
				parsed: null,
				provider: "openai",
				model: "test-model",
				elapsedMs: 2,
				usage: null,
			});
		const observer = fakeObserver({ outputMode: "legacy_xml", observe });
		const output = await observeAndNormalizeObserverOutput(observer, "system", "user");

		expect(observe).toHaveBeenCalledTimes(2);
		expect(output.repairApplied).toBe(true);
		expect(output.diagnostics.repairAttempted).toBe(true);
		expect(output.final.parsed.observations[0]?.title).toBe("Use XML");
		expect(observerOutputMetadata(output)).toEqual(
			expect.objectContaining({
				observer_output_repair_elapsed_ms: 2,
				observer_output_repair_usage: null,
				observer_output_retry_elapsed_ms: null,
				observer_output_retry_usage: null,
			}),
		);
	});

	it("classifies a failed legacy repair without including observer content", async () => {
		const sensitive = "private observer wording";
		const observe = vi
			.fn()
			.mockResolvedValueOnce({
				raw: `${sensitive}<observation><type>decision</type><title>Incomplete`,
				parsed: null,
				provider: "openai",
				model: "test-model",
			})
			.mockRejectedValueOnce(new Error("repair failed"));
		const output = await observeAndNormalizeObserverOutput(
			fakeObserver({ outputMode: "legacy_xml", observe }),
			"system",
			"user",
		);

		expect(output.diagnostics.failureReason).toBe("legacy_xml_lossy");
		expect(JSON.stringify(observerOutputMetadata(output))).not.toContain(sensitive);
	});

	it("normalizes equivalent JSON and XML fixtures to the same domain shape", async () => {
		const jsonOutput = await observeAndNormalizeObserverOutput(
			fakeObserver({ structuredRaw: capturedEnvelope }),
			"system",
			"user",
		);
		const xml = `<observation>
			<type>decision</type>
			<title>Use schema output</title>
			<narrative>The observer now uses a versioned envelope.</narrative>
			<facts><fact>The schema version is one.</fact></facts>
			<concepts><concept>what-changed</concept></concepts>
			<files_read></files_read>
			<files_modified><file>packages/core/src/observer-output.ts</file></files_modified>
		</observation>`;
		const xmlObserver = fakeObserver({
			outputMode: "legacy_xml",
			observe: vi.fn(async () => ({
				raw: xml,
				parsed: null,
				provider: "openai",
				model: "test-model",
			})),
		});
		const xmlOutput = await observeAndNormalizeObserverOutput(xmlObserver, "system", "user");

		expect(xmlOutput.final.parsed).toEqual(jsonOutput.final.parsed);
	});
});
