import { describe, expect, it, vi } from "vitest";
import { ObserverAuthError, ObserverAuthRetryError, ObserverClient } from "./observer-client.js";
import { observeAndNormalizeObserverOutput } from "./observer-output.js";

function directClient(provider: "openai" | "anthropic"): ObserverClient {
	return new ObserverClient({
		observerProvider: provider,
		observerModel: provider === "openai" ? "gpt-test" : "claude-test",
		observerRuntime: "api_http",
		observerApiKey: `fixture-structured-${provider}-token`,
		observerBaseUrl: null,
		observerMaxChars: 12_000,
		observerMaxTokens: 4_000,
		observerHeaders: {},
		observerAuthSource: "auto",
		observerAuthFile: null,
		observerAuthCommand: [],
		observerAuthTimeoutMs: 1500,
		observerAuthCacheTtlS: 300,
	});
}

async function observeStructured(client: ObserverClient, user = "user") {
	return client.observeStructuredJson("system", user, "test_schema", { type: "object" });
}

describe("ObserverClient auth retry outcomes", () => {
	it("retains the initial auth failure after a successful retry", async () => {
		const previousFetch = globalThis.fetch;
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount += 1;
			if (callCount === 1) return new Response("Unauthorized", { status: 401 });
			return new Response(JSON.stringify({ status: "completed", output_text: '{"ok":true}' }), {
				status: 200,
			});
		}) as typeof fetch;
		try {
			const result = await observeStructured(directClient("openai"));
			expect(result.outcome).toEqual({
				status: "success",
				error: null,
				authRetry: {
					attempted: true,
					initialError: {
						code: "auth_failed",
						message: "OpenAI authentication failed. Refresh credentials and retry.",
					},
					retryError: null,
				},
			});
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("retains both auth failures when the retry is also unauthorized", async () => {
		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
		try {
			const operation = observeStructured(directClient("openai"));
			await expect(operation).rejects.toBeInstanceOf(ObserverAuthRetryError);
			await expect(operation).rejects.toMatchObject({
				initialError: { detail: { code: "auth_failed" } },
				retryError: { detail: { code: "auth_failed" } },
			});
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("retains a different failure returned by the auth retry", async () => {
		const previousFetch = globalThis.fetch;
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount += 1;
			return callCount === 1
				? new Response("Unauthorized", { status: 401 })
				: new Response("Unavailable", { status: 503 });
		}) as typeof fetch;
		try {
			const result = await observeStructured(directClient("openai"));
			expect(result.outcome?.authRetry).toMatchObject({
				initialError: { code: "auth_failed" },
				retryError: { code: "provider_request_failed" },
			});
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});

describe("ObserverClient empty and failed outcomes", () => {
	it("distinguishes malformed, timeout, and empty successful responses", async () => {
		const previousFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch;
			const malformed = await observeStructured(directClient("openai"));
			expect(malformed.outcome).toMatchObject({
				status: "failure",
				error: { code: "observer_call_failed" },
			});

			globalThis.fetch = (async () => {
				throw new DOMException("deadline reached", "TimeoutError");
			}) as typeof fetch;
			const timedOut = await observeStructured(directClient("openai"));
			expect(timedOut.outcome).toMatchObject({
				status: "failure",
				error: { code: "observer_timeout" },
			});

			globalThis.fetch = (async () =>
				new Response(JSON.stringify({ status: "completed", output: [] }), {
					status: 200,
				})) as typeof fetch;
			const empty = await observeStructured(directClient("openai"));
			expect(empty.outcome).toMatchObject({
				status: "empty",
				error: { code: "structured_output_missing" },
			});
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it.each([
		{ provider: "openai" as const, body: { status: "completed", output_text: "  \n\t" } },
		{
			provider: "anthropic" as const,
			body: { stop_reason: "end_turn", content: [{ type: "text", text: "  \n\t" }] },
		},
	])(
		"classifies blank $provider direct and structured responses as empty",
		async ({ provider, body }) => {
			const previousFetch = globalThis.fetch;
			globalThis.fetch = (async () =>
				new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
			try {
				const client = directClient(provider);
				await expect(client.observe("system", "user")).resolves.toMatchObject({
					raw: null,
					outcome: { status: "empty", error: { code: "empty_response" } },
				});
				await expect(observeStructured(client)).resolves.toMatchObject({
					raw: null,
					failureReason: "structured_output_missing",
					outcome: { status: "empty", error: { code: "structured_output_missing" } },
				});
			} finally {
				globalThis.fetch = previousFetch;
			}
		},
	);
});

describe("ObserverClient overlapping outcomes", () => {
	it("keeps each result independent from mutable status", async () => {
		const previousFetch = globalThis.fetch;
		let resolveFirst!: (response: Response) => void;
		let resolveSecond!: (response: Response) => void;
		let calls = 0;
		globalThis.fetch = (() => {
			calls += 1;
			return new Promise<Response>((resolve) => {
				if (calls === 1) resolveFirst = resolve;
				else resolveSecond = resolve;
			});
		}) as typeof fetch;
		try {
			const client = directClient("openai");
			const first = observeStructured(client, "first");
			const second = observeStructured(client, "second");
			resolveSecond(
				new Response(JSON.stringify({ status: "completed", output_text: '{"ok":true}' }), {
					status: 200,
				}),
			);
			resolveFirst(new Response("limited", { status: 429 }));

			const [failed, succeeded] = await Promise.all([first, second]);
			expect(failed.outcome).toMatchObject({
				status: "failure",
				error: { code: "rate_limited" },
			});
			expect(succeeded.outcome).toEqual({ status: "success", error: null, authRetry: null });
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});

it("retries a structured request timeout before reporting it", async () => {
	const observeStructuredJson = vi.fn(async () => ({
		raw: null,
		provider: "openai",
		model: "gpt-test",
		usedStructuredOutputs: true,
		failureReason: null,
		transportFailureCode: "observer_timeout",
	}));
	const client = {
		provider: "openai",
		model: "gpt-test",
		runtime: "api_http",
		openaiUseResponses: true,
		outputMode: "json_schema",
		hasCustomBaseUrl: false,
		maxChars: 12_000,
		getStatus: () => ({
			provider: "openai",
			model: "gpt-test",
			runtime: "api_http",
			auth: { source: "test", type: "api_direct", hasToken: true },
		}),
		observeStructuredJson,
	} as unknown as ObserverClient;

	await expect(observeAndNormalizeObserverOutput(client, "system", "user")).rejects.toMatchObject({
		code: "observer_timeout",
		diagnostics: { retryAttempted: true, retryReason: "observer_timeout" },
	});
	expect(observeStructuredJson).toHaveBeenCalledTimes(2);
});

it("retains a rejected legacy repair's typed status", async () => {
	const repairError = { code: "auth_failed", message: "Refresh credentials and retry." };
	const observe = vi
		.fn()
		.mockResolvedValueOnce({
			raw: "<observation><type>decision</type><title>Incomplete",
			provider: "openai",
			model: "gpt-test",
		})
		.mockRejectedValueOnce(new ObserverAuthError("auth", repairError));
	const client = {
		provider: "openai",
		model: "gpt-test",
		runtime: "api_http",
		openaiUseResponses: false,
		outputMode: "legacy_xml",
		hasCustomBaseUrl: false,
		maxChars: 12_000,
		getStatus: () => ({
			provider: "openai",
			model: "gpt-test",
			runtime: "api_http",
			auth: { source: "test", type: "api_direct", hasToken: true },
			lastError: { code: "stale_shared_error", message: "Stale" },
		}),
		observe,
	} as unknown as ObserverClient;

	const output = await observeAndNormalizeObserverOutput(client, "system", "user");
	expect(output.repairFailureStatus?.lastError).toEqual(repairError);
});
