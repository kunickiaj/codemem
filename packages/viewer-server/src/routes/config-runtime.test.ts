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
