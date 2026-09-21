import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadObserverConfig, normalizeObserverRuntime, ObserverAuthAdapter } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configRoutes } from "./config.js";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	env = process.env;
	home = mkdtempSync(join(tmpdir(), "codemem-config-runtime-"));
	process.env = { HOME: home, CODEMEM_CONFIG: join(home, "config.json") };
	mkdirSync(join(home, ".codex"));
	writeFileSync(join(home, ".codex", "auth.json"), "{}");
	vi.spyOn(ObserverAuthAdapter.prototype, "resolve").mockImplementation(() => {
		throw new Error("must not resolve credentials");
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(() => {
		throw new Error("must not make network calls");
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = env;
	rmSync(home, { recursive: true, force: true });
});

it.each([
	{ claude: true, runtime: undefined, override: undefined, expected: "claude_sidecar" },
	{ claude: false, runtime: undefined, override: undefined, expected: "codex_sidecar" },
	{ claude: true, runtime: "api_http", override: undefined, expected: "api_http" },
	{ claude: true, runtime: "api_http", override: " CoDeX_SiDeCaR ", expected: "codex_sidecar" },
	{ claude: false, runtime: "api_http", override: " CLAUDE_SIDECAR ", expected: "claude_sidecar" },
	{ claude: true, runtime: undefined, override: "invalid", expected: "api_http" },
	{ claude: true, runtime: undefined, override: "   ", expected: "api_http" },
	{ claude: true, runtime: "api_http", override: "", expected: "claude_sidecar" },
])("reports shared resolved runtime without initializing auth: %j", async (scenario) => {
	if (scenario.claude) process.env.CLAUDE_CODE_SESSION = "fixture-session";
	if (scenario.override !== undefined) process.env.CODEMEM_OBSERVER_RUNTIME = scenario.override;
	const config = { observer_runtime: scenario.runtime, codex_command: [process.execPath] };
	writeFileSync(join(home, "config.json"), JSON.stringify(config));
	const response = await configRoutes().request("/api/config");
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.resolved_observer_runtime).toBe(scenario.expected);
	expect(body.resolved_observer_runtime).toBe(
		normalizeObserverRuntime(loadObserverConfig().observerRuntime),
	);
	expect(body.config).toEqual(JSON.parse(JSON.stringify(config)));
	if (scenario.override !== undefined) {
		expect(body.env_overrides.observer_runtime).toBe("CODEMEM_OBSERVER_RUNTIME");
	}
	expect(ObserverAuthAdapter.prototype.resolve).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("returns resolved runtime after saving an explicit API choice", async () => {
	process.env.CLAUDE_CODE_SESSION = "fixture-session";
	writeFileSync(join(home, "config.json"), "{}");
	const response = await configRoutes().request("/api/config", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ config: { observer_runtime: "api_http" } }),
	});
	expect(response.status).toBe(200);
	expect((await response.json()).resolved_observer_runtime).toBe("api_http");
	expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({
		observer_runtime: "api_http",
	});
});

async function runtimePreview(config: Record<string, unknown> = {}) {
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({ codex_command: [process.execPath], ...config }),
	);
	const response = await configRoutes().request("/api/config");
	expect(response.status).toBe(200);
	expect(ObserverAuthAdapter.prototype.resolve).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	return response.json();
}

it("previews auth changes through the shared resolver and preserves omitted runtime on save", async () => {
	const body = await runtimePreview();
	expect(body.observer_runtime_by_auth_source).toEqual({
		auto: "codex_sidecar",
		env: "codex_sidecar",
		none: "codex_sidecar",
		command: "api_http",
		file: "api_http",
	});
	for (const source of ["command", "auto"]) {
		const response = await configRoutes().request("/api/config", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { observer_auth_source: source } }),
		});
		expect((await response.json()).resolved_observer_runtime).toBe(
			body.observer_runtime_by_auth_source[source],
		);
		expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).not.toHaveProperty(
			"observer_runtime",
		);
	}
});

it.each([
	{ observer_api_key: "fixture-api-key" },
	{ observer_auth_file: "fixture-auth-file" },
	{ observer_auth_command: [process.execPath] },
	{ codex_command: ["/nonexistent/codex"] },
	{ observer_runtime: "api_http" },
])("honors saved auto-selection dependency %j in every preview", async (config) => {
	const body = await runtimePreview(config);
	expect(new Set(Object.values(body.observer_runtime_by_auth_source))).toEqual(
		new Set(["api_http"]),
	);
});

it.each([
	"CODEMEM_OBSERVER_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
	"CODEX_API_KEY",
	"CODEMEM_OBSERVER_AUTH_FILE",
])("honors environment dependency %s in every preview", async (key) => {
	process.env[key] = "fixture-value";
	const body = await runtimePreview();
	expect(new Set(Object.values(body.observer_runtime_by_auth_source))).toEqual(
		new Set(["api_http"]),
	);
});

it.each([
	["CODEMEM_OBSERVER_AUTH_COMMAND", JSON.stringify([process.execPath])],
	["CODEMEM_CODEX_COMMAND", JSON.stringify(["/nonexistent/codex"])],
	["CODEMEM_OBSERVER_AUTH_SOURCE", "command"],
	["CODEMEM_OBSERVER_RUNTIME", "api_http"],
] as const)("honors environment override %s", async (key, value) => {
	process.env[key] = value;
	const body = await runtimePreview();
	expect(new Set(Object.values(body.observer_runtime_by_auth_source))).toEqual(
		new Set(["api_http"]),
	);
});

it.each(["CLAUDE_CODE_SESSION", "CLAUDE_CODE_ENTRYPOINT"])(
	"retains automatic Claude precedence from %s",
	async (key) => {
		process.env[key] = "fixture-session";
		const body = await runtimePreview();
		expect(new Set(Object.values(body.observer_runtime_by_auth_source))).toEqual(
			new Set(["claude_sidecar"]),
		);
	},
);

it("requires Codex login presence for automatic preview", async () => {
	rmSync(join(home, ".codex", "auth.json"));
	const body = await runtimePreview();
	expect(body.observer_runtime_by_auth_source.auto).toBe("api_http");
});

it("respects usable OpenCode OAuth cache in automatic preview", async () => {
	const directory = join(home, ".local", "share", "opencode");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "auth.json"),
		JSON.stringify({
			openai: { type: "oauth", access: "fixture-access", expires: Date.now() + 60_000 },
		}),
	);
	const body = await runtimePreview();
	expect(body.observer_runtime_by_auth_source.auto).toBe("api_http");
});

it("does not treat provider or base URL edits as automatic-runtime dependencies", async () => {
	const body = await runtimePreview({
		observer_provider: "anthropic",
		observer_base_url: "https://gateway.example/v1",
	});
	expect(body.observer_runtime_by_auth_source.auto).toBe("codex_sidecar");
	expect(body.observer_runtime_by_auth_source.command).toBe("api_http");
});

it("still previews auth selection when an empty runtime environment override requests auto-selection", async () => {
	process.env.CODEMEM_OBSERVER_RUNTIME = "";
	const body = await runtimePreview({ observer_runtime: "claude_sidecar" });
	expect(body.observer_runtime_by_auth_source.auto).toBe("codex_sidecar");
	expect(body.observer_runtime_by_auth_source.command).toBe("api_http");
});
