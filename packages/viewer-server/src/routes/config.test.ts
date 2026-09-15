import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configRoutes } from "./config.js";

describe("config mutation routes", () => {
	let configDir: string;
	let configPath: string;
	let previousConfigPath: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "codemem-config-route-"));
		configPath = join(configDir, "config.json");
		previousConfigPath = process.env.CODEMEM_CONFIG;
		process.env.CODEMEM_CONFIG = configPath;
	});

	afterEach(() => {
		if (previousConfigPath == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = previousConfigPath;
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
});
