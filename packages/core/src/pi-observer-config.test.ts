/**
 * Tests for pi-observer-config.ts — derive observer settings from pi agent config.
 *
 * Fixtures cover: api-key happy path, oauth-only, mixed auth, relocated home
 * (PI_CODING_AGENT_DIR / piDir), wire-api mapping, cheap-first selection,
 * explicit observer_* override detection, and secret non-leakage in status.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	describePiObserverStatus,
	hasExplicitObserverEnvOverride,
	type PiObserverResolveResult,
	resolvePiAgentDir,
	resolvePiObserverConfig,
} from "./pi-observer-config.js";

const FIXTURE_KEY = "sk-fixture-pi-observer-test-key-do-not-leak";
const OTHER_KEY = "sk-fixture-other-provider-key-secret";

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function makePiDir(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `codemem-pi-obs-${label}-`));
	return root;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		out.push(value);
		return out;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out);
		return out;
	}
	if (value != null && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) {
			collectStrings(item, out);
		}
	}
	return out;
}

function assertNoSecretLeak(result: PiObserverResolveResult, ...secrets: string[]): void {
	const status = describePiObserverStatus(result);
	for (const secret of secrets) {
		expect(status, `status must not contain ${secret}`).not.toContain(secret);
	}
	// Serialize the public-facing fields only (ok path still holds apiKey in memory —
	// status helper and error details must stay clean).
	if (!result.ok) {
		const blob = JSON.stringify(result);
		for (const secret of secrets) {
			expect(blob, `error result must not contain ${secret}`).not.toContain(secret);
		}
	} else {
		// ok path: apiKey is intentionally present on the object; status must redact.
		expect(status).not.toMatch(/sk-/);
		const { apiKey: _apiKey, ...publicFields } = result;
		const blob = JSON.stringify(publicFields);
		for (const secret of secrets) {
			expect(blob).not.toContain(secret);
		}
	}
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe("resolvePiAgentDir", () => {
	it("defaults to ~/.pi/agent under HOME", () => {
		const dir = resolvePiAgentDir({ env: { HOME: "/tmp/fake-home" } });
		expect(dir).toBe(join("/tmp/fake-home", ".pi", "agent"));
	});

	it("honors PI_CODING_AGENT_DIR", () => {
		const dir = resolvePiAgentDir({
			env: { HOME: "/tmp/fake-home", PI_CODING_AGENT_DIR: "/tmp/relocated-pi" },
		});
		expect(dir).toBe("/tmp/relocated-pi");
	});

	it("prefers explicit piDir over env", () => {
		const dir = resolvePiAgentDir({
			piDir: "/explicit/pi",
			env: { PI_CODING_AGENT_DIR: "/tmp/relocated-pi" },
		});
		expect(dir).toBe("/explicit/pi");
	});
});

// ---------------------------------------------------------------------------
// API-key happy path + wire API
// ---------------------------------------------------------------------------

describe("resolvePiObserverConfig — api-key happy path", () => {
	it("resolves OpenAI-completions provider endpoint, credential, and model id", () => {
		const piDir = makePiDir("happy");
		try {
			writeJson(join(piDir, "settings.json"), {
				defaultProvider: "acme",
				defaultModel: "acme/gpt-premium-ultra",
				enabledModels: ["acme/gpt-premium-ultra", "acme/gpt-4o-mini"],
			});
			writeJson(join(piDir, "models.json"), {
				providers: {
					acme: {
						baseUrl: "https://api.acme.test/v1",
						api: "openai-completions",
						models: [{ id: "gpt-premium-ultra" }, { id: "gpt-4o-mini" }],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				acme: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.provider).toBe("acme");
			expect(result.model).toBe("gpt-4o-mini"); // cheap-first, not default
			expect(result.baseUrl).toBe("https://api.acme.test/v1");
			expect(result.apiKey).toBe(FIXTURE_KEY);
			expect(result.wireApi).toBe("openai-completions");
			expect(result.openAIUseResponses).toBe(false);
			assertNoSecretLeak(result, FIXTURE_KEY);
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("maps openai-responses → openAIUseResponses true", () => {
		const piDir = makePiDir("responses");
		try {
			writeJson(join(piDir, "settings.json"), {});
			writeJson(join(piDir, "models.json"), {
				providers: {
					oai: {
						baseUrl: "https://api.openai.test/v1",
						api: "openai-responses",
						models: [{ id: "gpt-4.1-mini" }],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				oai: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.wireApi).toBe("openai-responses");
			expect(result.openAIUseResponses).toBe(true);
			assertNoSecretLeak(result, FIXTURE_KEY);
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("maps anthropic-messages wire API", () => {
		const piDir = makePiDir("anthropic");
		try {
			writeJson(join(piDir, "settings.json"), {});
			writeJson(join(piDir, "models.json"), {
				providers: {
					anth: {
						baseUrl: "https://api.anthropic.test",
						api: "anthropic-messages",
						models: [{ id: "claude-haiku-4-5" }],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				anth: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.wireApi).toBe("anthropic-messages");
			expect(result.openAIUseResponses).toBe(false);
			expect(result.model).toBe("claude-haiku-4-5");
			assertNoSecretLeak(result, FIXTURE_KEY);
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("accepts apiKey embedded in models.json without auth.json entry", () => {
		const piDir = makePiDir("embedded-key");
		try {
			writeJson(join(piDir, "settings.json"), {});
			writeJson(join(piDir, "models.json"), {
				providers: {
					local: {
						baseUrl: "http://127.0.0.1:11434/v1",
						api: "openai-completions",
						apiKey: FIXTURE_KEY,
						models: [{ id: "llama3.1:8b" }],
					},
				},
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.provider).toBe("local");
			expect(result.apiKey).toBe(FIXTURE_KEY);
			assertNoSecretLeak(result, FIXTURE_KEY);
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("reads models-store.json catalog when models.json is absent", () => {
		const piDir = makePiDir("store-only");
		try {
			writeJson(join(piDir, "settings.json"), {
				enabledModels: ["fw/accounts/fw/models/deepseek-flash"],
			});
			writeJson(join(piDir, "models-store.json"), {
				fw: {
					models: [
						{
							id: "accounts/fw/models/deepseek-flash",
							api: "openai-completions",
							baseUrl: "https://api.fw.test/v1",
							cost: { input: 0.1, output: 0.2 },
						},
						{
							id: "accounts/fw/models/deepseek-pro",
							api: "openai-completions",
							baseUrl: "https://api.fw.test/v1",
							cost: { input: 2, output: 4 },
						},
					],
				},
			});
			writeJson(join(piDir, "auth.json"), {
				fw: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.provider).toBe("fw");
			expect(result.model).toBe("accounts/fw/models/deepseek-flash");
			expect(result.baseUrl).toBe("https://api.fw.test/v1");
			assertNoSecretLeak(result, FIXTURE_KEY);
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Cheap-first selection (never interactive default)
// ---------------------------------------------------------------------------

describe("resolvePiObserverConfig — cheap-first model selection", () => {
	it("does not auto-use premium defaultModel when a cheaper model exists", () => {
		const piDir = makePiDir("cheap");
		try {
			writeJson(join(piDir, "settings.json"), {
				defaultProvider: "acme",
				defaultModel: "acme/claude-opus-4",
			});
			writeJson(join(piDir, "models.json"), {
				providers: {
					acme: {
						baseUrl: "https://api.acme.test",
						api: "anthropic-messages",
						models: [
							{ id: "claude-opus-4" },
							{ id: "claude-haiku-4-5" },
							{ id: "claude-sonnet-4" },
						],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				acme: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.model).toBe("claude-haiku-4-5");
			expect(result.model).not.toBe("claude-opus-4");
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("falls back to defaultModel only when it is the sole eligible candidate", () => {
		const piDir = makePiDir("only-default");
		try {
			writeJson(join(piDir, "settings.json"), {
				defaultModel: "acme/gpt-premium-ultra",
			});
			writeJson(join(piDir, "models.json"), {
				providers: {
					acme: {
						baseUrl: "https://api.acme.test/v1",
						api: "openai-completions",
						models: [{ id: "gpt-premium-ultra" }],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				acme: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.model).toBe("gpt-premium-ultra");
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("prefers lower declared cost from models-store over name alone", () => {
		const piDir = makePiDir("cost");
		try {
			writeJson(join(piDir, "settings.json"), {});
			writeJson(join(piDir, "models-store.json"), {
				acme: {
					models: [
						{
							id: "model-a",
							api: "openai-completions",
							baseUrl: "https://api.acme.test/v1",
							cost: { input: 5, output: 10 },
						},
						{
							id: "model-b",
							api: "openai-completions",
							baseUrl: "https://api.acme.test/v1",
							cost: { input: 0.05, output: 0.1 },
						},
					],
				},
			});
			writeJson(join(piDir, "auth.json"), {
				acme: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.model).toBe("model-b");
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("breaks same-tier/cost ties with localeCompare, never defaultModel", () => {
		// Two candidates, identical declared cost and name tier, neither cheaper.
		// Winner must be the localeCompare-first model id — and must NOT be the
		// interactive defaultModel even when it sorts later.
		const piDir = makePiDir("tie");
		try {
			writeJson(join(piDir, "settings.json"), {
				defaultModel: "acme/zeta-model",
			});
			writeJson(join(piDir, "models.json"), {
				providers: {
					acme: {
						baseUrl: "https://api.acme.test/v1",
						api: "openai-completions",
						models: [
							// Insert default first so array order alone would pick it.
							{ id: "zeta-model", cost: { input: 1, output: 1 } },
							{ id: "alpha-model", cost: { input: 1, output: 1 } },
							{ id: "beta-model", cost: { input: 1, output: 1 } },
						],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				acme: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			// Non-default candidates sort before default; among non-defaults,
			// localeCompare("alpha-model", "beta-model") < 0 → alpha wins.
			expect(result.model).toBe("alpha-model");
			expect(result.model).not.toBe("zeta-model");
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// OAuth-only + mixed
// ---------------------------------------------------------------------------

describe("resolvePiObserverConfig — oauth and mixed auth", () => {
	it("surfaces oauth-only when every provider is OAuth", () => {
		const piDir = makePiDir("oauth");
		try {
			writeJson(join(piDir, "settings.json"), {
				defaultModel: "openai-codex/gpt-5.4",
			});
			writeJson(join(piDir, "models-store.json"), {
				"openai-codex": {
					models: [
						{
							id: "gpt-5.4",
							api: "openai-responses",
							baseUrl: "https://chatgpt.com/backend-api",
						},
					],
				},
			});
			writeJson(join(piDir, "auth.json"), {
				"openai-codex": {
					type: "oauth",
					access: "oauth-access-token-fixture",
					refresh: "oauth-refresh-token-fixture",
					expires: Date.now() + 60_000,
				},
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.reason).toBe("oauth-only");
			expect(describePiObserverStatus(result)).toBe(
				"unconfigured (oauth-only); set observer_provider/observer_model explicitly",
			);
			assertNoSecretLeak(result, "oauth-access-token-fixture", "oauth-refresh-token-fixture");
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("skips OAuth providers and uses an api-key peer in mixed installs", () => {
		const piDir = makePiDir("mixed");
		try {
			writeJson(join(piDir, "settings.json"), {
				defaultModel: "openai-codex/gpt-5.4",
			});
			writeJson(join(piDir, "models.json"), {
				providers: {
					"openai-codex": {
						baseUrl: "https://chatgpt.com/backend-api",
						api: "openai-responses",
						models: [{ id: "gpt-5.4" }],
					},
					acme: {
						baseUrl: "https://api.acme.test/v1",
						api: "openai-completions",
						models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				"openai-codex": {
					type: "oauth",
					access: "oauth-access-token-fixture",
				},
				acme: { type: "api_key", key: OTHER_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.provider).toBe("acme");
			expect(result.model).toBe("gpt-4o-mini");
			expect(result.apiKey).toBe(OTHER_KEY);
			assertNoSecretLeak(result, OTHER_KEY, "oauth-access-token-fixture");
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("reports unsupported-api when api-key providers only speak google-generative-ai", () => {
		const piDir = makePiDir("unsupported");
		try {
			writeJson(join(piDir, "settings.json"), {});
			writeJson(join(piDir, "models.json"), {
				providers: {
					google: {
						baseUrl: "https://generativelanguage.googleapis.com/v1beta",
						api: "google-generative-ai",
						models: [{ id: "gemini-2.0-flash" }],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				google: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.reason).toBe("unsupported-api");
			assertNoSecretLeak(result, FIXTURE_KEY);
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("skips unsupported APIs when a supported candidate exists", () => {
		const piDir = makePiDir("skip-unsup");
		try {
			writeJson(join(piDir, "settings.json"), {});
			writeJson(join(piDir, "models.json"), {
				providers: {
					google: {
						baseUrl: "https://generativelanguage.googleapis.com/v1beta",
						api: "google-generative-ai",
						models: [{ id: "gemini-2.0-flash" }],
					},
					acme: {
						baseUrl: "https://api.acme.test/v1",
						api: "openai-completions",
						models: [{ id: "mini-model" }],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				google: { type: "api_key", key: FIXTURE_KEY },
				acme: { type: "api_key", key: OTHER_KEY },
			});

			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.provider).toBe("acme");
			expect(result.model).toBe("mini-model");
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Relocated home / PI_CODING_AGENT_DIR
// ---------------------------------------------------------------------------

describe("resolvePiObserverConfig — relocated pi dir", () => {
	it("honors PI_CODING_AGENT_DIR from env", () => {
		const piDir = makePiDir("relocated");
		try {
			writeJson(join(piDir, "settings.json"), {});
			writeJson(join(piDir, "models.json"), {
				providers: {
					acme: {
						baseUrl: "https://api.acme.test/v1",
						api: "openai-completions",
						models: [{ id: "gpt-4o-mini" }],
					},
				},
			});
			writeJson(join(piDir, "auth.json"), {
				acme: { type: "api_key", key: FIXTURE_KEY },
			});

			const result = resolvePiObserverConfig({
				env: {
					HOME: "/tmp/should-not-be-used-for-pi",
					PI_CODING_AGENT_DIR: piDir,
				},
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.model).toBe("gpt-4o-mini");
			assertNoSecretLeak(result, FIXTURE_KEY);
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("returns not-configured for an empty directory", () => {
		const piDir = makePiDir("empty");
		try {
			const result = resolvePiObserverConfig({ piDir });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.reason).toBe("not-configured");
			expect(describePiObserverStatus(result)).toBe("unconfigured (not-configured)");
		} finally {
			rmSync(piDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Explicit override detection + status redaction
// ---------------------------------------------------------------------------

describe("hasExplicitObserverEnvOverride", () => {
	it("is true when CODEMEM_OBSERVER_MODEL is set", () => {
		expect(hasExplicitObserverEnvOverride({ CODEMEM_OBSERVER_MODEL: "gpt-4o-mini" })).toBe(true);
	});

	it("is true when CODEMEM_OBSERVER_PROVIDER is set", () => {
		expect(hasExplicitObserverEnvOverride({ CODEMEM_OBSERVER_PROVIDER: "openai" })).toBe(true);
	});

	it("is false when neither is set", () => {
		expect(hasExplicitObserverEnvOverride({})).toBe(false);
	});

	it("is env-only — file-style keys on the env object do not count", () => {
		// Documents the rename: this helper does not inspect codemem config files.
		expect(
			hasExplicitObserverEnvOverride({
				observer_provider: "openai",
				observer_model: "gpt-4o",
			} as NodeJS.ProcessEnv),
		).toBe(false);
	});
});

describe("describePiObserverStatus", () => {
	it("never echoes credential material", () => {
		const ok: PiObserverResolveResult = {
			ok: true,
			provider: "acme",
			model: "gpt-4o-mini",
			baseUrl: "https://api.acme.test/v1",
			apiKey: FIXTURE_KEY,
			openAIUseResponses: false,
			wireApi: "openai-completions",
		};
		const status = describePiObserverStatus(ok);
		expect(status).toBe("pi:acme/gpt-4o-mini via openai-completions (api-key)");
		expect(status).not.toContain(FIXTURE_KEY);
		expect(status).not.toMatch(/sk-/);

		const all = collectStrings(ok);
		// apiKey is on the object in memory (point of use) — that's expected;
		// only the status string is user-facing.
		expect(all).toContain(FIXTURE_KEY);
		expect(describePiObserverStatus(undefined)).toContain("unconfigured");
	});
});
