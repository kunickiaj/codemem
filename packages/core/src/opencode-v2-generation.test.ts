import { afterEach, expect, it, vi } from "vitest";
import { generateWithOpenCodeV2, listOpenCodeV2Models } from "./opencode-v2-generation.js";

vi.mock("@opencode/client/service", () => ({
	Service: {
		discover: vi.fn(async () => ({ url: "http://127.0.0.1:9999", auth: "test" })),
		headers: vi.fn(() => ({ authorization: "Bearer test" })),
	},
}));

afterEach(() => vi.restoreAllMocks());

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

it("reports rejected models instead of trying another model or provider", async () => {
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response("{}", { status: 400 }));
	expect(
		await generateWithOpenCodeV2({ provider: "openai", model: "unknown", prompt: "OK" }),
	).toEqual({ text: null, error: "model_unavailable" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});

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
