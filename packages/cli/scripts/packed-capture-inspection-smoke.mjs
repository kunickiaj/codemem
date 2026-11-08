import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function forbidServices(home, cli) {
	const marker = join(home, "unexpected-service-access");
	const preload = join(home, "forbid-services.mjs");
	writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
const forbidden = () => {
  writeFileSync(${JSON.stringify(marker)}, "unexpected service access");
  throw new Error("HTTP and SQLite are forbidden during capture inspection");
};
globalThis.fetch = forbidden;
http.request = http.get = https.request = https.get = forbidden;
net.Socket.prototype.connect = forbidden;
syncBuiltinESMExports();
const require = createRequire(${JSON.stringify(cli)});
const sqlite = require.resolve("better-sqlite3");
require(sqlite);
require.cache[sqlite].exports = forbidden;
`, { mode: 0o600 });
	return { preload, marker };
}

/** Reuse the lexical installation. No plugin package or workspace imports are available. */
export function smokeCaptureInspection(installDir, isolatedRoot, { runtimeEnv }) {
	// Arrange: seed only the documented disk format in a private disposable home.
	const cli = join(installDir, "node_modules/codemem/dist/index.js");
	assert.equal(existsSync(join(installDir, "node_modules/@codemem/opencode-plugin")), false);
	assert.doesNotMatch(readFileSync(cli, "utf8"), /(?:from\s*|import\s*\()["']\.\.\/\.\.\/\.\.\/opencode-plugin\//u);
	const home = join(isolatedRoot, "capture-inspection-home");
	const env = runtimeEnv(home);
	const directory = join(home, ".codemem", "opencode-raw-event-spool");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const eventId = "packed-private-event";
	const receipt = `rejected-${createHash("sha256").update(eventId).digest("hex")}-400-invalid_payload.json`;
	const serialized = ` ${JSON.stringify({ event_id: eventId, session_id: "packed-private-session",
		payload: { text: "packed-private-payload café\u001b[31m\n\t\u0085\u202e" } }, null, 2)}\n`;
	const path = join(directory, receipt);
	writeFileSync(path, serialized, { mode: 0o600 });
	const before = statSync(path);
	const { preload, marker } = forbidServices(home, cli);
	const invoke = (args, status = 0, { textOnly = false } = {}) => {
		// Act: execute the installed entrypoint with its actual argv and isolated environment.
		const result = spawnSync(process.execPath, ["--import", preload, cli, "capture", ...args], {
			cwd: installDir, env, encoding: "utf8",
		});
		// Assert after every command, including error cases.
		assert.ifError(result.error);
		assert.equal(result.status, status, result.stderr || result.stdout);
		assert.equal(result.stderr, "");
		assert.equal(existsSync(marker), false, "Inspection attempted HTTP or SQLite access");
		assert.equal(existsSync(env.CODEMEM_DB), false, "Inspection created a database");
		assert.equal(readFileSync(path, "utf8"), serialized);
		assert.equal(statSync(path).mtimeMs, before.mtimeMs);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(statSync(directory).mode & 0o777, 0o700);
		assert.deepEqual(readdirSync(directory), [receipt]);
		assert.equal(result.stdout.includes(home), false);
		return { text: result.stdout, value: textOnly ? undefined : JSON.parse(result.stdout) };
	};
	const metadata = { receipt, bytes: Buffer.byteLength(serialized), status: 400, reason: "invalid_payload" };
	const listed = invoke(["list-rejected", "--json"]);
	assert.deepEqual(listed.value, { format: "opencode-raw-event-v1",
		entries: [{ ...metadata, validation: "not_checked" }] });
	const shown = invoke(["show-rejected", receipt, "--json"]);
	assert.deepEqual(shown.value, { format: "opencode-raw-event-v1", ...metadata, validation: "valid" });
	const human = invoke(["show-rejected", receipt], 0, { textOnly: true });
	assert.match(human.text, /valid/u);
	assert.match(human.text, /\d+ bytes/u);
	assert.throws(() => JSON.parse(human.text));
	for (const result of [listed, shown, human]) {
		assert.doesNotMatch(result.text, /packed-private-|"(?:event_id|session_id|payload|raw|serialized|path)"/u);
	}
	const raw = invoke(["show-rejected", receipt, "--raw"]);
	assert.deepEqual(raw.value, { ...shown.value, raw: serialized });
	assert.doesNotMatch(raw.text.trimEnd(), /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u);
	const invalid = invoke(["show-rejected", "../packed-private-payload", "--raw", "--json"], 2);
	assert.deepEqual(invalid.value, { error: "invalid_receipt", message: "Use a receipt from capture list-rejected." });
	assert.doesNotMatch(invalid.text, /packed-private-|\.\.\//u);
	for (const flags of [[], ["--db-path", env.CODEMEM_DB]]) {
		const denied = invoke(["recover-rejected", receipt, "--json", ...flags], 2);
		assert.equal(denied.value.ok, false);
		assert.equal(denied.value.error, "usage_error");
		assert.match(denied.value.message, /--db-path/u);
		assert.match(denied.value.message, /current target/u);
		assert.match(denied.value.message, /-y/u);
		assert.doesNotMatch(denied.text, /packed-private-|"(?:event_id|session_id|payload|raw|serialized|path)"/u);
	}
	process.stdout.write("Packed capture inspection: metadata, escaped raw output, safe errors, and unchanged files passed\n");
}
