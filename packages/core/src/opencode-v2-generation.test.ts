import { Service } from "@opencode/client/service";
import { afterEach, expect, it, vi } from "vitest";
import { generateWithOpenCodeV2, listOpenCodeV2Models } from "./opencode-v2-generation.js";

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
		expect(result).toEqual({ text: "OK", error: null });
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
		await expect(result).resolves.toEqual({ text: null, error: "service_unavailable" });
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
	expect(result).toEqual({ text: "OK", error: null });
	const [url, options] = fetcher.mock.calls[0] ?? [];
	expect(String(url)).toBe("http://127.0.0.1:9999/api/experimental/generate");
	expect(JSON.parse(String(options?.body))).toEqual({
		model: { providerID: "openai", id: "gpt-6-luna" },
		prompt: "Reply OK",
	});
	expect(options?.headers).toHaveProperty("authorization", "Bearer test");
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
	expect(await result).toEqual({ text: "OK", error: null });
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
	).toEqual({ text: null, error: "request_failed" });
	expect(
		await generateWithOpenCodeV2({ provider: "openai", model: "other", prompt: "OK" }),
	).toEqual({ text: null, error: "request_failed" });
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it("stops retrying a permanently unavailable model within a short deadline", async () => {
	vi.useFakeTimers();
	const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => unavailable());
	const result = generateWithOpenCodeV2({ provider: "openai", model: "gpt-6-luna", prompt: "OK" });
	await vi.advanceTimersByTimeAsync(15_000);
	expect(await result).toEqual({ text: null, error: "model_unavailable" });
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
		expect(await result).toEqual({ text: null, error });
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
		},
	);
});

it("bounds catalog response bytes before parsing or showing model suggestions", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ data: [{ id: "x".repeat(1024 * 1024), providerID: "openai" }] })),
	);
	expect(await listOpenCodeV2Models()).toEqual([]);
});
