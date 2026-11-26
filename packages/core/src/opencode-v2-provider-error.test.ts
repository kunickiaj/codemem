import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadObserverConfig, ObserverAuthError, ObserverClient } from "./observer-client.js";
import {
	clearOpenCodeV2ModelVariantCache,
	generateWithOpenCodeV2,
	providerErrorFromBody,
} from "./opencode-v2-generation.js";

/*
 * When a provider refuses a request, the OpenCode service answers 502 with a
 * ProviderRequestError. Codemem keeps its reason code, upstream status and provider
 * ID, and never the provider's message text.
 */

vi.mock("@opencode/client/service", () => ({
	Service: {
		discover: vi.fn(async () => ({ url: "http://127.0.0.1:4199", auth: undefined })),
		headers: () => ({}),
	},
}));

const PROVIDER_TEXT = "SYNTHETIC_PROVIDER_MESSAGE";
/** The shape the service returned for a provider rate limit. */
const RATE_LIMITED = {
	_tag: "ProviderRequestError",
	providerID: "anthropic",
	reason: "rate_limit",
	message: PROVIDER_TEXT,
	status: 429,
};

function serviceAnswering(status: number, body: unknown) {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
		new URL(String(input)).pathname === "/api/model"
			? new Response(JSON.stringify({ data: [] }))
			: new Response(JSON.stringify(body), { status }),
	);
}

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-provider-error-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	clearOpenCodeV2ModelVariantCache();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("provider refusals from the OpenCode service", () => {
	it("keeps only the reason, upstream status and provider of a refusal", async () => {
		serviceAnswering(502, RATE_LIMITED);

		const result = await generateWithOpenCodeV2({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			prompt: "Hi",
		});

		expect(result).toMatchObject({
			error: "request_failed",
			providerError: { reason: "rate_limit", status: 429, providerId: "anthropic" },
		});
		expect(JSON.stringify(result)).not.toContain(PROVIDER_TEXT);
	});

	it.each([
		["an unknown tag", { ...RATE_LIMITED, _tag: "SomethingElse" }],
		["a free-text reason", { ...RATE_LIMITED, reason: "Rate limited, retry later" }],
		["a plain-text body", "Bad Gateway"],
	])("falls back to request_failed for %s", async (_name, body) => {
		serviceAnswering(502, body);

		const result = await generateWithOpenCodeV2({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			prompt: "Hi",
		});

		expect(result.error).toBe("request_failed");
		expect(result).not.toHaveProperty("providerError");
	});

	it("drops an upstream status or provider ID outside the expected shape", () => {
		expect(
			providerErrorFromBody({ ...RATE_LIMITED, status: "429", providerID: "an thropic!" }),
		).toEqual({ reason: "rate_limit", status: null, providerId: null });
	});
});

describe("observer status for a provider refusal", () => {
	const observer = () =>
		new ObserverClient(
			loadObserverConfig({
				observer_runtime: "opencode_v2",
				observer_provider: "anthropic",
				observer_model: "claude-haiku-5-5",
			}),
		);

	it("shows the provider's reason instead of only request_failed", async () => {
		serviceAnswering(502, RATE_LIMITED);
		const client = observer();

		const error = await client.observe("system", "user").catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ObserverAuthError);
		const lastError = client.getStatus().lastError;
		expect(lastError).toMatchObject({
			code: "request_failed",
			providerError: { reason: "rate_limit", status: 429, providerId: "anthropic" },
		});
		expect(lastError?.message).toContain(
			"the anthropic provider reported rate_limit (upstream status 429)",
		);
		expect((error as ObserverAuthError).message).toContain("reported rate_limit");
		expect(JSON.stringify(client.getStatus())).not.toContain(PROVIDER_TEXT);
	});

	it("keeps request_failed for an unknown error shape", async () => {
		serviceAnswering(502, { error: "boom" });
		const client = observer();

		await client.observe("system", "user").catch(() => undefined);

		const lastError = client.getStatus().lastError;
		expect(lastError?.code).toBe("request_failed");
		expect(lastError).not.toHaveProperty("providerError");
		expect(lastError?.message).toContain("OpenCode account request failed: request_failed.");
	});
});
