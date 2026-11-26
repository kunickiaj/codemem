import { Service } from "@opencode/client/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearOpenCodeV2ModelVariantCache,
	generateWithOpenCodeV2,
	listOpenCodeV2Models,
} from "./opencode-v2-generation.js";

vi.mock("@opencode/client/service", () => ({
	Service: {
		discover: vi.fn(async () => ({ url: "http://127.0.0.1:9999", auth: "test" })),
		headers: vi.fn(() => ({ authorization: "Bearer test" })),
	},
}));

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const localServiceUrls = [
	{ discovered: "http://0.0.0.0:9999", requested: "http://127.0.0.1:9999" },
	{ discovered: "http://[::]:9999", requested: "http://[::1]:9999" },
	{ discovered: "http://127.0.0.1:9999", requested: "http://127.0.0.1:9999" },
	{ discovered: "http://[::1]:9999", requested: "http://[::1]:9999" },
	{ discovered: "http://localhost:9999", requested: "http://localhost:9999" },
];

const rejectedServiceUrls = [
	"http://192.0.2.1:9999",
	"http://[2001:db8::1]:9999",
	"http://example.com:9999",
	"https://127.0.0.1:9999",
	"https://0.0.0.0:9999",
	"https://[::]:9999",
	"ftp://localhost:9999",
	"not a URL",
	"http://[invalid]:9999",
];

function discoveredEndpoint(url: string) {
	return {
		url,
		// Preserve the existing fake auth fixture without using a real credential.
		auth: "test" as unknown as NonNullable<Awaited<ReturnType<typeof Service.discover>>>["auth"],
	};
}

it.each(localServiceUrls)(
	"generates through $requested discovered as $discovered without changing service auth or discovery",
	async ({ discovered, requested }) => {
		// Arrange: wildcard listeners must use a matching loopback destination.
		const endpoint = discoveredEndpoint(discovered);
		vi.spyOn(Service, "discover").mockResolvedValueOnce(endpoint);
		const headers = vi.spyOn(Service, "headers").mockClear();
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: { text: "OK" } })));

		// Act
		const result = await generateWithOpenCodeV2({
			provider: "openai",
			model: "test",
			prompt: "OK",
		});

		// Assert: only the request URL changes; service-owned auth stays intact.
		expect(result).toEqual({ text: "OK", error: null, effort: null });
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, options] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(`${requested}/api/experimental/generate`);
		expect(options?.headers).toHaveProperty("authorization", "Bearer test");
		expect(headers).toHaveBeenCalledWith(endpoint);
		expect(headers.mock.calls[0]?.[0]).toBe(endpoint);
		expect(endpoint).toEqual({ url: discovered, auth: "test" });
	},
);

it.each(localServiceUrls)(
	"lists models through $requested discovered as $discovered without changing service auth or discovery",
	async ({ discovered, requested }) => {
		// Arrange: catalog requests share generation's local-only destination rules.
		const endpoint = discoveredEndpoint(discovered);
		vi.spyOn(Service, "discover").mockResolvedValueOnce(endpoint);
		const headers = vi.spyOn(Service, "headers").mockClear();
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ providerID: "openai", id: "test" }] })),
			);

		// Act
		const result = await listOpenCodeV2Models();

		// Assert
		expect(result).toEqual([{ provider: "openai", model: "test" }]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, options] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(`${requested}/api/model`);
		expect(options?.headers).toHaveProperty("authorization", "Bearer test");
		expect(headers).toHaveBeenCalledWith(endpoint);
		expect(headers.mock.calls[0]?.[0]).toBe(endpoint);
		expect(endpoint).toEqual({ url: discovered, auth: "test" });
	},
);

it.each(rejectedServiceUrls)(
	"rejects generation discovery URL %s without fetching",
	async (url) => {
		// Arrange: remote, non-HTTP, and malformed discovery must never reach the network.
		vi.spyOn(Service, "discover").mockResolvedValueOnce(discoveredEndpoint(url));
		const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

		// Act
		const result = generateWithOpenCodeV2({ provider: "openai", model: "test", prompt: "OK" });

		// Assert
		await expect(result).resolves.toEqual({
			text: null,
			error: "service_unavailable",
			effort: null,
		});
		expect(fetcher).not.toHaveBeenCalled();
	},
);

it.each(rejectedServiceUrls)("rejects catalog discovery URL %s without fetching", async (url) => {
	// Arrange
	vi.spyOn(Service, "discover").mockResolvedValueOnce(discoveredEndpoint(url));
	const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

	// Act
	const result = listOpenCodeV2Models();

	// Assert
	await expect(result).resolves.toEqual([]);
	expect(fetcher).not.toHaveBeenCalled();
});

it("requests the exact provider/model through the service without exporting credentials", async () => {
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(JSON.stringify({ data: { text: "OK" } }), { status: 200 }));
	const result = await generateWithOpenCodeV2({
		provider: "openai",
		model: "gpt-6-luna",
		prompt: "Reply OK",
	});
	expect(result).toEqual({ text: "OK", error: null, effort: null });
	const [url, options] = fetcher.mock.calls[0] ?? [];
	expect(String(url)).toBe("http://127.0.0.1:9999/api/experimental/generate");
	expect(JSON.parse(String(options?.body))).toEqual({
		model: { providerID: "openai", id: "gpt-6-luna" },
		prompt: "Reply OK",
	});
	expect(options?.headers).toHaveProperty("authorization", "Bearer test");
});

describe("reasoning effort variants", () => {
	const catalog = () =>
		new Response(
			JSON.stringify({
				data: [
					{ providerID: "openai", id: "gpt-6-luna", variants: [{ id: "low" }, { id: "high" }] },
					{ providerID: "anthropic", id: "claude-sonnet-4-6", variants: [{ id: "max" }] },
					{ providerID: "openai", id: "plain" },
				],
			}),
		);
	const route = () =>
		vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) =>
				new URL(String(input)).pathname === "/api/model"
					? catalog()
					: new Response(JSON.stringify({ data: { text: "OK" } })),
			);
	const generate = (provider: string, model: string, reasoningEffort: string) =>
		generateWithOpenCodeV2({ provider, model, prompt: "Hi", reasoningEffort });
	const catalogCalls = (fetcher: ReturnType<typeof route>) =>
		fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/model")).length;
	const sentModels = (fetcher: ReturnType<typeof route>) =>
		fetcher.mock.calls
			.filter(([url]) => String(url).endsWith("/api/experimental/generate"))
			.map(([, options]) => JSON.parse(String(options?.body)).model);

	beforeEach(() => {
		clearOpenCodeV2ModelVariantCache();
	});

	it("sends a listed effort inside the model reference and reports it", async () => {
		const fetcher = route();

		const result = await generate("openai", "gpt-6-luna", "high");

		expect(sentModels(fetcher)).toEqual([
			{ providerID: "openai", id: "gpt-6-luna", variant: "high" },
		]);
		expect(result).toEqual({
			text: "OK",
			error: null,
			effort: { attempted: "high", applied: "high", succeeded: true, fallbackReason: null },
		});
	});

	it("answers every listed model from one catalog fetch and checks a miss once", async () => {
		const fetcher = route();

		const efforts = [
			(await generate("openai", "gpt-6-luna", "high")).effort,
			(await generate("anthropic", "claude-sonnet-4-6", "max")).effort,
			(await generate("openai", "plain", "high")).effort,
			(await generate("openai", "plain", "high")).effort,
		];

		// The miss fetches the catalog once more; the second miss within a minute does not.
		expect(catalogCalls(fetcher)).toBe(2);
		expect(sentModels(fetcher).map((model) => model.variant)).toEqual([
			"high",
			"max",
			undefined,
			undefined,
		]);
		expect(efforts[3]?.fallbackReason).toBe("variant_not_listed");
		expect(efforts[2]).toEqual({
			attempted: null,
			applied: null,
			succeeded: true,
			fallbackReason: "variant_not_listed",
		});
	});

	it("fetches the catalog again after ten minutes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const fetcher = route();

		await generate("openai", "gpt-6-luna", "high");
		vi.advanceTimersByTime(10 * 60_000);
		await generate("openai", "gpt-6-luna", "high");
		vi.advanceTimersByTime(1);
		await generate("openai", "gpt-6-luna", "high");

		expect(catalogCalls(fetcher)).toBe(2);
	});

	it("does not cache an unavailable catalog and fetches it once more", async () => {
		const fetcher = route();
		fetcher.mockImplementationOnce(async () => new Response("{}", { status: 503 }));

		const first = await generate("openai", "gpt-6-luna", "high");
		const second = await generate("openai", "gpt-6-luna", "high");

		expect(first.effort?.applied).toBe("high");
		expect(second.effort?.applied).toBe("high");
		expect(catalogCalls(fetcher)).toBe(2);
	});

	it("reports the catalog as unavailable when the second fetch also fails", async () => {
		const fetcher = route();
		fetcher.mockImplementationOnce(async () => new Response("{}", { status: 503 }));
		fetcher.mockImplementationOnce(async () => new Response("{}", { status: 503 }));

		const first = await generate("openai", "gpt-6-luna", "high");

		expect(first.effort).toEqual({
			attempted: null,
			applied: null,
			succeeded: true,
			fallbackReason: "variants_unavailable",
		});
		expect(catalogCalls(fetcher)).toBe(2);
	});
});

describe("variant lookups against a stale or partial catalog", () => {
	type Entry = { providerID: string; id: string; variants?: Array<{ id: string }> };
	const luna = (...ids: string[]): Entry => ({
		providerID: "openai",
		id: "gpt-6-luna",
		variants: ids.map((id) => ({ id })),
	});
	const other: Entry = { providerID: "anthropic", id: "claude-sonnet-4-6", variants: [] };
	/** Serve each catalog fetch the next list; the last one repeats. */
	const serve = (...catalogs: Entry[][]) =>
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (new URL(String(input)).pathname !== "/api/model") {
				return new Response(JSON.stringify({ data: { text: "OK" } }));
			}
			const data = catalogs.length > 1 ? catalogs.shift() : catalogs[0];
			return new Response(JSON.stringify({ data }));
		});
	const generate = (reasoningEffort: string) =>
		generateWithOpenCodeV2({
			provider: "openai",
			model: "gpt-6-luna",
			prompt: "Hi",
			reasoningEffort,
		});
	const catalogCalls = (fetcher: ReturnType<typeof serve>) =>
		fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/model")).length;

	beforeEach(() => {
		clearOpenCodeV2ModelVariantCache();
	});

	it("applies an effort a cached catalog lacked once a fresh catalog lists it", async () => {
		const fetcher = serve([luna("low")], [luna("low", "high")]);
		await generate("low");

		const result = await generate("high");

		expect(result.effort).toEqual({
			attempted: "high",
			applied: "high",
			succeeded: true,
			fallbackReason: null,
		});
		expect(catalogCalls(fetcher)).toBe(2);
	});

	it.each([
		["an empty catalog", []],
		["a catalog without the model", [other]],
	])("does not let %s poison later calls", async (_name, partial) => {
		const fetcher = serve(partial, [other, luna("low", "high")]);

		const first = await generate("high");
		const second = await generate("high");

		expect(first.effort?.applied).toBe("high");
		expect(second.effort?.applied).toBe("high");
		// One extra fetch replaces the partial read; the full catalog then answers from cache.
		expect(catalogCalls(fetcher)).toBe(2);
	});

	it("does not remember a miss when the refresh fails", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		let failNext = false;
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (new URL(String(input)).pathname !== "/api/model") {
				return new Response(JSON.stringify({ data: { text: "OK" } }));
			}
			if (failNext) {
				failNext = false;
				return new Response("{}", { status: 503 });
			}
			return new Response(JSON.stringify({ data: [luna("low", "high")] }));
		});
		fetcher.mockImplementationOnce(
			async () => new Response(JSON.stringify({ data: [luna("low")] })),
		);
		await generate("low");
		vi.advanceTimersByTime(61_000);
		failNext = true;

		const during = await generate("high");
		const after = await generate("high");

		expect(during.effort?.fallbackReason).toBe("variants_unavailable");
		expect(after.effort?.applied).toBe("high");
	});

	it("falls back once for a variant the model does not list and reports it", async () => {
		const fetcher = serve([luna("low", "high")]);
		await generate("low");

		const first = await generate("xhigh");
		const second = await generate("xhigh");

		for (const result of [first, second]) {
			expect(result.effort).toEqual({
				attempted: null,
				applied: null,
				succeeded: true,
				fallbackReason: "variant_not_listed",
			});
		}
		// The miss is checked against one fresh catalog, then remembered for a minute.
		expect(catalogCalls(fetcher)).toBe(2);
	});
});

const unavailable = () =>
	new Response(
		JSON.stringify({
			_tag: "InvalidRequestError",
			message: "Model unavailable: openai/gpt-6-luna",
		}),
		{ status: 400 },
	);

it("retries only pre-generation model selection failures until the cold catalog is ready", async () => {
	vi.useFakeTimers();
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(unavailable())
		.mockResolvedValueOnce(new Response(JSON.stringify({ data: { text: "OK" } }), { status: 200 }));
	const result = generateWithOpenCodeV2({ provider: "openai", model: "gpt-6-luna", prompt: "OK" });
	await vi.advanceTimersByTimeAsync(10_000);
	expect(await result).toEqual({ text: "OK", error: null, effort: null });
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
});

it("does not retry an unrelated bad request or a model-selection error for a different model", async () => {
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ _tag: "InvalidRequestError", message: "Invalid prompt" }), {
				status: 400,
			}),
		)
		.mockResolvedValueOnce(unavailable());
	expect(
		await generateWithOpenCodeV2({ provider: "openai", model: "gpt-6-luna", prompt: "OK" }),
	).toEqual({ text: null, error: "request_failed", effort: null });
	expect(
		await generateWithOpenCodeV2({ provider: "openai", model: "other", prompt: "OK" }),
	).toEqual({ text: null, error: "request_failed", effort: null });
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it("stops retrying a permanently unavailable model within a short deadline", async () => {
	vi.useFakeTimers();
	const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => unavailable());
	const result = generateWithOpenCodeV2({ provider: "openai", model: "gpt-6-luna", prompt: "OK" });
	await vi.advanceTimersByTimeAsync(15_000);
	expect(await result).toEqual({ text: null, error: "model_unavailable", effort: null });
	expect(fetcher.mock.calls.length).toBeGreaterThan(1);
	expect(fetcher.mock.calls.length).toBeLessThanOrEqual(6);
});

it.each([
	{ status: 401, error: "auth_failed" },
	{ status: 500, error: "request_failed" },
])(
	"does not retry a $status response after a model-readiness rejection",
	async ({ status, error }) => {
		vi.useFakeTimers();
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(unavailable())
			.mockResolvedValueOnce(new Response("{}", { status }));
		const result = generateWithOpenCodeV2({
			provider: "openai",
			model: "gpt-6-luna",
			prompt: "OK",
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await result).toEqual({ text: null, error, effort: null });
		expect(fetcher).toHaveBeenCalledTimes(2);
	},
);

it("rejects responses larger than the local byte budget", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ data: { text: "x".repeat(1024 * 1024) } })),
	);
	expect(await generateWithOpenCodeV2({ provider: "openai", model: "test", prompt: "OK" })).toEqual(
		{
			text: null,
			error: "response_too_large",
			effort: null,
		},
	);
});

it("bounds catalog response bytes before parsing or showing model suggestions", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ data: [{ id: "x".repeat(1024 * 1024), providerID: "openai" }] })),
	);
	expect(await listOpenCodeV2Models()).toEqual([]);
});
