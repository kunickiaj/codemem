import { afterEach, expect, it, vi } from "vitest";
import { configRoutes } from "./config.js";

const mocks = vi.hoisted(() => ({
	generate: vi.fn(),
	models: vi.fn(),
}));

vi.mock("@codemem/core", async (importActual) => ({
	...(await importActual<typeof import("@codemem/core")>()),
	generateWithOpenCodeV2: mocks.generate,
	listOpenCodeV2Models: mocks.models,
}));

afterEach(() => vi.resetAllMocks());

it("separates catalog listing from request-verified availability", async () => {
	mocks.models.mockResolvedValue([{ provider: "openai", model: "gpt-6-luna" }]);
	mocks.generate.mockResolvedValue({ text: "OK", error: null });
	const app = configRoutes();
	const catalog = await app.request("/api/observer-model-catalog");
	expect(await catalog.json()).toEqual({
		models: [{ provider: "openai", model: "gpt-6-luna" }],
		availability: "catalog_only",
	});
	expect(mocks.generate).not.toHaveBeenCalled();
	const check = await app.request("/api/observer-model-check", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "openai", model: "gpt-6-luna" }),
	});
	expect((await check.json()).available).toBe(true);
	expect(mocks.generate).toHaveBeenCalledWith({
		provider: "openai",
		model: "gpt-6-luna",
		prompt: "Reply exactly OK.",
	});
});

it("fails visibly for unavailable models and limits checks", async () => {
	mocks.generate.mockResolvedValue({ text: null, error: "model_unavailable" });
	const app = configRoutes();
	const request = () =>
		app.request("/api/observer-model-check", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "openai", model: "gpt-6-luna" }),
		});
	const first = await request();
	expect((await first.json()).status).toBe("model_unavailable");
	await request();
	expect((await request()).status).toBe(429);
	expect(mocks.generate).toHaveBeenCalledTimes(2);
});
