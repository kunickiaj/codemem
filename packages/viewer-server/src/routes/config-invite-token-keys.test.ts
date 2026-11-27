import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configRoutes } from "./config.js";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	env = process.env;
	home = mkdtempSync(join(tmpdir(), "codemem-invite-key-config-"));
	process.env = { HOME: home, CODEMEM_CONFIG: join(home, "config.json") };
});
afterEach(() => {
	process.env = env;
	rmSync(home, { recursive: true, force: true });
});

const key = () => randomBytes(32).toString("hex");
const configPath = () => join(home, "config.json");

async function readConfig() {
	const response = await configRoutes().request("/api/config");
	expect(response.status).toBe(200);
	return response.text();
}

function saveConfig() {
	return configRoutes().request("/api/config", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ config: { observer_model: "gpt-4.1-mini" } }),
	});
}

it("never returns invitation token keys from the config file on GET or POST", async () => {
	// Arrange
	const [current, previous] = [key(), key()];
	writeFileSync(
		configPath(),
		JSON.stringify({
			sync_coordinator_invite_token_key: current,
			sync_coordinator_invite_token_key_previous: previous,
		}),
	);
	// Act
	const read = await readConfig();
	const saved = await saveConfig();
	const savedText = await saved.text();
	// Assert
	expect(saved.status).toBe(200);
	for (const text of [read, savedText]) {
		expect(text).not.toContain(current);
		expect(text).not.toContain(previous);
		const body = JSON.parse(text) as Record<string, Record<string, unknown>>;
		for (const section of ["config", "effective"]) {
			expect(body[section]?.sync_coordinator_invite_token_key).toBe("[redacted]");
			expect(body[section]?.sync_coordinator_invite_token_key_previous).toBe("[redacted]");
		}
	}
	// Saving other settings keeps the keys in the file as they were.
	expect(JSON.parse(readFileSync(configPath(), "utf8"))).toMatchObject({
		sync_coordinator_invite_token_key: current,
		sync_coordinator_invite_token_key_previous: previous,
	});
});

it("never returns invitation token keys from the environment on GET or POST", async () => {
	// Arrange
	const [current, previous] = [key(), key()];
	writeFileSync(configPath(), "{}");
	process.env.CODEMEM_INVITE_TOKEN_KEY = current;
	process.env.CODEMEM_INVITE_TOKEN_KEY_PREVIOUS = previous;
	// Act
	const read = await readConfig();
	const saved = await (await saveConfig()).text();
	// Assert
	for (const text of [read, saved]) {
		expect(text).not.toContain(current);
		expect(text).not.toContain(previous);
		expect((JSON.parse(text) as { effective: Record<string, unknown> }).effective).toMatchObject({
			sync_coordinator_invite_token_key: "[redacted]",
			sync_coordinator_invite_token_key_previous: "[redacted]",
		});
	}
});

it("refuses to change an invitation token key from the viewer", async () => {
	// Arrange
	const current = key();
	writeFileSync(configPath(), JSON.stringify({ sync_coordinator_invite_token_key: current }));
	// Act
	const response = await configRoutes().request("/api/config", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ config: { sync_coordinator_invite_token_key: key() } }),
	});
	// Assert
	expect(response.status).toBe(403);
	expect(JSON.parse(readFileSync(configPath(), "utf8")).sync_coordinator_invite_token_key).toBe(
		current,
	);
});
