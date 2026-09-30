import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configRoutes } from "./config.js";

describe("config mutation routes", () => {
	let configDir: string;
	let configPath: string;
	let previousConfigPath: string | undefined;
	let previousSyncMdns: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "codemem-config-route-"));
		configPath = join(configDir, "config.json");
		previousConfigPath = process.env.CODEMEM_CONFIG;
		previousSyncMdns = process.env.CODEMEM_SYNC_MDNS;
		process.env.CODEMEM_CONFIG = configPath;
		delete process.env.CODEMEM_SYNC_MDNS;
	});

	afterEach(() => {
		if (previousConfigPath == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = previousConfigPath;
		if (previousSyncMdns == null) delete process.env.CODEMEM_SYNC_MDNS;
		else process.env.CODEMEM_SYNC_MDNS = previousSyncMdns;
		rmSync(configDir, { recursive: true, force: true });
	});

	it("does not overwrite malformed config during save", async () => {
		const malformed = '{ "existing_secret": "fixture-value",';
		writeFileSync(configPath, malformed, "utf8");

		const response = await configRoutes().request("/api/config", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { observer_model: "gpt-4.1-mini" } }),
		});

		expect(response.status).toBe(409);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("not a valid JSON object");
		expect(body.error).not.toContain("fixture-value");
		expect(readFileSync(configPath, "utf8")).toBe(malformed);
	});

	it("reports the runtime mDNS default as disabled", async () => {
		const response = await configRoutes().request("/api/config");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			defaults: { sync_mdns: boolean };
			effective: { sync_mdns: boolean };
		};
		expect(body.defaults.sync_mdns).toBe(false);
		expect(body.effective.sync_mdns).toBe(false);
	});

	it.each(["api_key", "opencode_v2"])(
		"accepts explicit %s without replacing it with an automatic mode",
		async (runtime) => {
			const response = await configRoutes().request("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ config: { observer_runtime: runtime } }),
			});
			expect(response.status).toBe(200);
			expect((await response.json()).resolved_observer_runtime).toBe(runtime);
		},
	);

	it("reports live-apply capabilities and actual model defaults without scheduling an apply", async () => {
		let applies = 0;
		const response = await configRoutes({
			scheduleObserverApply: () => {
				applies++;
				return true;
			},
		}).request("/api/config");
		const body = await response.json();
		expect(body.restart_required_keys).toContain("sync_port");
		expect(body.restart_required_keys).not.toContain("observer_runtime");
		expect(body.restart_required_keys).not.toContain("raw_events_sweeper_interval_s");
		expect(body.restart_required_keys).not.toContain("pack_observation_limit");
		expect(body.restart_required_keys).not.toContain("pack_session_limit");
		expect(body.observer_model_defaults.simple.openai).toBe("gpt-6-luna");
		expect(body.observer_model_defaults.codex).toBe("gpt-6-luna");
		expect(applies).toBe(0);
	});

	it("saves inactive pack limits without requesting a restart", async () => {
		const response = await configRoutes().request("/api/config", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { pack_observation_limit: 51, pack_session_limit: 11 } }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.effects.saved_keys).toEqual(
			expect.arrayContaining(["pack_observation_limit", "pack_session_limit"]),
		);
		expect(body.effects.restart_required_keys).toEqual([]);
	});
});
