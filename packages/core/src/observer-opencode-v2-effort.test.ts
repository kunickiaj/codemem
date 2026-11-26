import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractionReplayObserverIdentity } from "./extraction-replay.js";
import { buildTieredObserverConfig } from "./extraction-tier-routing.js";
import { loadObserverConfig, ObserverAuthError, ObserverClient } from "./observer-client.js";
import { clearOpenCodeV2ModelVariantCache } from "./opencode-v2-generation.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";

/*
 * The OpenCode service selects reasoning effort through a model variant. These
 * tests run the real observer and transport against a fake local service.
 */

const discover = vi.hoisted(() => vi.fn());
vi.mock("@opencode/client/service", () => ({
	Service: { discover, headers: () => ({}) },
}));

const FIRST = "http://127.0.0.1:4101";
const SECOND = "http://127.0.0.1:4102";
const SKIP = '<skip_summary reason="low-signal"/>';

interface FakeService {
	/** Variant IDs per `provider/model`; undefined omits the field, as older services do. */
	variants: Record<string, string[] | undefined>;
	catalogStatus?: number;
	/** Answer every generation with this status and body instead of generating. */
	failure?: { status: number; body: unknown };
}

let services: Record<string, FakeService>;
let catalogFetches: string[];
let generations: Array<{ origin: string; variant: string | undefined }>;

function catalog(service: FakeService) {
	return Object.entries(service.variants).map(([key, variants]) => {
		const [providerID, id] = key.split("/");
		return { providerID, id, ...(variants ? { variants: variants.map((v) => ({ id: v })) } : {}) };
	});
}

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status });
}

function fakeFetch(input: string | URL | Request, init?: RequestInit) {
	const url = new URL(String(input));
	const service = services[url.origin];
	if (!service) return Promise.reject(new Error("connection refused"));
	if (url.pathname === "/api/model") {
		catalogFetches.push(url.origin);
		return Promise.resolve(json(service.catalogStatus ?? 200, { data: catalog(service) }));
	}
	const body = JSON.parse(String(init?.body)) as {
		model: { providerID: string; id: string; variant?: string };
	};
	const { providerID, id, variant } = body.model;
	generations.push({ origin: url.origin, variant });
	if (service.failure) return Promise.resolve(json(service.failure.status, service.failure.body));
	const known = service.variants[`${providerID}/${id}`] ?? [];
	if (variant && !known.includes(variant)) {
		return Promise.resolve(
			json(400, {
				_tag: "InvalidRequestError",
				message: `Variant unavailable for ${providerID}/${id}: ${variant}`,
				field: "model.variant",
			}),
		);
	}
	return Promise.resolve(json(200, { data: { text: SKIP } }));
}

function serveAt(origin: string) {
	discover.mockResolvedValue({ url: origin, auth: undefined });
}

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-opencode-effort-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	for (const key of [
		"CODEMEM_OBSERVER_RUNTIME",
		"CODEMEM_OBSERVER_REASONING_EFFORT",
		"CODEMEM_OBSERVER_RICH_REASONING_EFFORT",
	])
		vi.stubEnv(key, undefined);
	clearOpenCodeV2ModelVariantCache();
	services = {
		[FIRST]: {
			variants: {
				"openai/gpt-5.6": ["none", "low", "medium", "high", "xhigh"],
				// The built-in tier models.
				"openai/gpt-6-luna": ["none", "low", "medium", "high", "xhigh"],
				"openai/gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh"],
				"anthropic/claude-sonnet-4-6": ["high", "max"],
			},
		},
	};
	catalogFetches = [];
	generations = [];
	serveAt(FIRST);
	vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	discover.mockReset();
	rmSync(home, { recursive: true, force: true });
});

function serviceObserver(settings: Record<string, unknown>) {
	return new ObserverClient(
		loadObserverConfig({
			observer_runtime: "opencode_v2",
			observer_provider: "openai",
			observer_model: "gpt-5.6",
			...settings,
		}),
	);
}

function tierObserver(settings: Record<string, unknown>, tier: "simple" | "rich") {
	const base = serviceObserver({ observer_tier_routing_enabled: true, ...settings }).toConfig();
	return new ObserverClient(buildTieredObserverConfig(base, { tier, observer: {}, reasons: [] }));
}

const sentVariants = () => generations.map((generation) => generation.variant);

function effortOf(observer: ObserverClient) {
	const status = observer.getStatus();
	return {
		requested: status.requestedReasoningEffort,
		applied: status.actualReasoningEffort,
		outcome: status.reasoningEffortOutcome,
		fallback: status.reasoningEffortFallbackApplied,
		reason: status.reasoningEffortFallbackReason,
	};
}

describe("reasoning effort on the OpenCode service", () => {
	it("sends the shared effort as the request variant", async () => {
		const observer = serviceObserver({ observer_reasoning_effort: "high" });

		await observer.observe("system", "user");

		expect(sentVariants()).toEqual(["high"]);
		expect(effortOf(observer)).toEqual({
			requested: "high",
			applied: "high",
			outcome: "accepted",
			fallback: false,
			reason: null,
		});
	});

	it("sends nothing and looks up nothing when no effort is configured", async () => {
		const observer = serviceObserver({});

		await observer.observe("system", "user");

		expect(sentVariants()).toEqual([undefined]);
		expect(catalogFetches).toEqual([]);
		expect(effortOf(observer)).toMatchObject({ requested: null, applied: null, outcome: null });
	});

	it.each([
		["simple", { observer_reasoning_effort: "low" }, "low"],
		[
			"simple",
			{ observer_reasoning_effort: "low", observer_rich_reasoning_effort: "xhigh" },
			"low",
		],
		[
			"rich",
			{ observer_reasoning_effort: "low", observer_rich_reasoning_effort: "xhigh" },
			"xhigh",
		],
		["rich", { observer_reasoning_effort: "low" }, "low"],
	] as const)("sends the %s tier's effort from %j", async (tier, settings, expected) => {
		await tierObserver(settings, tier).observe("system", "user");

		expect(sentVariants()).toEqual([expected]);
	});

	it("sends the configured effort on an Anthropic tier too", async () => {
		const observer = tierObserver(
			{
				observer_provider: "anthropic",
				observer_model: "claude-sonnet-4-6",
				observer_rich_reasoning_effort: "high",
			},
			"rich",
		);

		await observer.observe("system", "user");

		expect(sentVariants()).toEqual(["high"]);
	});

	it.each(["simple", "rich"] as const)(
		"sends no tier default effort on the %s tier when none is configured",
		async (tier) => {
			await tierObserver({}, tier).observe("system", "user");

			expect(sentVariants()).toEqual([undefined]);
			expect(catalogFetches).toEqual([]);
		},
	);

	it("sends a replay or benchmark effort override ahead of the saved setting", async () => {
		// The replay and benchmark commands put --reasoning-effort into the shared setting.
		const saved = serviceObserver({ observer_reasoning_effort: "low" }).toConfig();
		const overridden = { ...saved, observerReasoningEffort: "medium" };

		await new ObserverClient(overridden).observe("system", "user");
		await new ObserverClient(
			buildTieredObserverConfig(
				{ ...overridden, observerTierRoutingEnabled: true },
				{ tier: "simple", observer: {}, reasons: [] },
			),
		).observe("system", "user");

		expect(sentVariants()).toEqual(["medium", "medium"]);
	});

	it("sends the variant ID the model lists when only the case differs", async () => {
		services[FIRST] = { variants: { "openai/gpt-5.6": ["High"] } };

		await serviceObserver({ observer_reasoning_effort: "high" }).observe("system", "user");

		expect(sentVariants()).toEqual(["High"]);
	});

	it.each([
		[
			"the model does not list the variant",
			{ variants: { "openai/gpt-5.6": ["low"] } },
			"variant_not_listed",
		],
		[
			"the service lists no variants",
			{ variants: { "openai/gpt-5.6": undefined } },
			"variant_not_listed",
		],
		[
			"the model catalog is unavailable",
			{ variants: {}, catalogStatus: 503 },
			"variants_unavailable",
		],
	] as const)(
		"sends nothing and uses the service default when %s",
		async (_case, service, reason) => {
			services[FIRST] = service;
			const observer = serviceObserver({ observer_reasoning_effort: "max" });

			const response = await observer.observe("system", "user");

			expect(response.raw).toBe(SKIP);
			expect(sentVariants()).toEqual([undefined]);
			expect(effortOf(observer)).toEqual({
				requested: "max",
				applied: null,
				outcome: "not_sent",
				fallback: true,
				reason,
			});
		},
	);
});

describe("a variant the service no longer accepts", () => {
	it("retries once without it after the service drops it between calls", async () => {
		const observer = serviceObserver({ observer_reasoning_effort: "high" });
		await observer.observe("system", "user");
		services[FIRST] = { variants: { "openai/gpt-5.6": ["low"] } };

		const response = await observer.observe("system", "user");

		expect(response.raw).toBe(SKIP);
		expect(sentVariants()).toEqual(["high", "high", undefined]);
		expect(effortOf(observer)).toEqual({
			requested: "high",
			applied: null,
			outcome: "rejected_retried",
			fallback: true,
			reason: "variant_rejected",
		});

		// The rejection dropped the stale list, so the next call checks the catalog again.
		await observer.observe("system", "user");
		expect(catalogFetches).toEqual([FIRST, FIRST]);
		expect(sentVariants().at(-1)).toBeUndefined();
		expect(effortOf(observer).outcome).toBe("not_sent");
	});

	it("does not use one service's variant list for another service", async () => {
		services[SECOND] = { variants: { "openai/gpt-5.6": ["low"] } };
		const observer = serviceObserver({ observer_reasoning_effort: "high" });
		await observer.observe("system", "user");

		serveAt(SECOND);
		await observer.observe("system", "user");

		expect(catalogFetches).toEqual([FIRST, SECOND]);
		expect(generations).toEqual([
			{ origin: FIRST, variant: "high" },
			{ origin: SECOND, variant: undefined },
		]);
		expect(effortOf(observer).reason).toBe("variant_not_listed");
	});

	it.each([
		["another invalid request", 400, { _tag: "InvalidRequestError", message: "Prompt too long" }],
		[
			"a variant error for another model",
			400,
			{ _tag: "InvalidRequestError", message: "Variant unavailable for openai/other: high" },
		],
		["a server error", 500, { error: "boom" }],
	])("does not retry %s", async (_case, status, body) => {
		services[FIRST] = {
			...services[FIRST],
			variants: { "openai/gpt-5.6": ["high"] },
			failure: { status, body },
		};
		const observer = serviceObserver({ observer_reasoning_effort: "high" });

		await expect(observer.observe("system", "user")).rejects.toBeInstanceOf(ObserverAuthError);

		expect(sentVariants()).toEqual(["high"]);
		expect(effortOf(observer).outcome).toBe("accepted");
	});
});

describe("recording what was sent", () => {
	it("reports no applied effort when the service could not be reached", async () => {
		const observer = serviceObserver({ observer_reasoning_effort: "high" });
		await observer.observe("system", "user");
		discover.mockResolvedValue(undefined);

		await expect(observer.observe("system", "user")).rejects.toBeInstanceOf(ObserverAuthError);

		expect(effortOf(observer)).toEqual({
			requested: "high",
			applied: null,
			outcome: null,
			fallback: false,
			reason: null,
		});
	});

	it("shares one catalog fetch between concurrent first requests", async () => {
		const first = serviceObserver({ observer_reasoning_effort: "high" });
		const second = serviceObserver({ observer_reasoning_effort: "low" });

		await Promise.all([first.observe("system", "user"), second.observe("system", "user")]);

		expect(catalogFetches).toEqual([FIRST]);
		expect(sentVariants().sort()).toEqual(["high", "low"]);
	});

	it("checks again after a minute when the model lacked the variant", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		services[FIRST] = { variants: { "openai/gpt-5.6": ["low"] } };
		const observer = serviceObserver({ observer_reasoning_effort: "high" });
		await observer.observe("system", "user");
		services[FIRST] = { variants: { "openai/gpt-5.6": ["low", "high"] } };

		vi.advanceTimersByTime(59_000);
		await observer.observe("system", "user");
		vi.advanceTimersByTime(2_000);
		await observer.observe("system", "user");

		expect(catalogFetches).toEqual([FIRST, FIRST]);
		expect(sentVariants()).toEqual([undefined, undefined, "high"]);
	});
});

describe("live status for tier-routed requests", () => {
	let directory: string;
	let store: MemoryStore;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-opencode-effort-store-"));
		store = new MemoryStore(join(directory, "test.sqlite"));
	});
	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("keeps each tier's outcome on the configured client", async () => {
		services[FIRST] = { variants: { "openai/gpt-5.6": ["low"] } };
		const observer = serviceObserver({
			observer_tier_routing_enabled: true,
			observer_simple_model: "gpt-5.6",
			observer_reasoning_effort: "high",
		});
		store.recordRawEvent({
			opencodeSessionId: "tiered",
			eventId: "prompt",
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: "Check the queue" },
		});

		await flushRawEvents(store, { observer }, { opencodeSessionId: "tiered" }).catch(
			() => undefined,
		);

		expect(generations).toEqual([{ origin: FIRST, variant: undefined }]);
		expect(observer.getStatus().tierReasoningEfforts).toEqual({
			simple: {
				requestedReasoningEffort: "high",
				actualReasoningEffort: null,
				reasoningEffortOutcome: "not_sent",
				reasoningEffortFallbackApplied: true,
				reasoningEffortFallbackReason: "variant_not_listed",
			},
		});
	});
});

describe("replay metadata for the OpenCode service", () => {
	it("reports the sent effort and marks other request settings as not transmitted", async () => {
		const observer = serviceObserver({
			observer_reasoning_effort: "high",
			observer_temperature: 0.2,
			observer_max_tokens: 4000,
		});
		await observer.observe("system", "user");

		expect(extractionReplayObserverIdentity(observer, null)).toMatchObject({
			transport: "opencode_v2",
			reasoningEffort: "high",
			requestedReasoningEffort: "high",
			reasoningEffortFallbackApplied: false,
			reasoningSummary: null,
			maxOutputTokens: null,
			temperature: null,
		});
	});

	it("reports an effort that fell back as requested, not applied", async () => {
		services[FIRST] = { variants: { "openai/gpt-5.6": ["low"] } };
		const observer = serviceObserver({ observer_reasoning_effort: "xhigh" });
		await observer.observe("system", "user");

		expect(extractionReplayObserverIdentity(observer, "rich")).toMatchObject({
			reasoningEffort: null,
			requestedReasoningEffort: "xhigh",
			reasoningEffortFallbackApplied: true,
			reasoningEffortFallbackReason: "variant_not_listed",
		});
	});
});
