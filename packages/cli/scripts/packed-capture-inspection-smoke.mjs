import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
	const invoke = (args, status = 0, { textOnly = false, recoveryPreload } = {}) => {
		// Act: execute the installed entrypoint with its actual argv and isolated environment.
		const imports = recoveryPreload ? ["--import", recoveryPreload] : [];
		const result = spawnSync(process.execPath, ["--import", preload, ...imports, cli, "capture", ...args], {
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
	// Arrange: native receipts use the provider's configured directory and writer basename.
	const nativeDir = join(home, "native-spool");
	mkdirSync(nativeDir, { mode: 0o700 });
	env.CODEMEM_CLAUDE_HOOK_SPOOL_DIR = nativeDir;
	const nativeReceipt = "rejected-400-invalid_payload-hook-1730000000-123-1234.json.retained";
	const nativePath = join(nativeDir, nativeReceipt);
	const nativeText = ` ${JSON.stringify({ session_id: "packed-private-native", prompt: "packed-private-payload café\u001b\n\u0085\u202e" }, null, 2)}\n`;
	writeFileSync(nativePath, nativeText, { mode: 0o600 });
	const nativeBefore = statSync(nativePath);
	const nativeFlags = ["--format", "native-hook-v1", "--provider", "claude"];
	const nativeMetadata = { receipt: nativeReceipt, bytes: Buffer.byteLength(nativeText), status: 400, reason: "invalid_payload" };
	const nativeShown = { format: "native-hook-v1", provider: "claude", ...nativeMetadata, validation: "valid" };
	for (const action of ["list", "show", "raw", "invalid"]) {
		// Act: retain the same service-denying preload and OpenCode preservation assertions.
		let args = ["show-rejected", nativeReceipt, ...nativeFlags, "--json"];
		if (action === "list") args = ["list-rejected", ...nativeFlags, "--json"];
		if (action === "raw") args.push("--raw");
		if (action === "invalid") args = ["show-rejected", "../packed-private-native", ...nativeFlags, "--raw"];
		const result = invoke(args, action === "invalid" ? 2 : 0);
		// Assert: native inspection neither discloses metadata payloads nor modifies either spool.
		if (action === "list") assert.deepEqual(result.value, { format: "native-hook-v1", provider: "claude", entries: [{ ...nativeMetadata, validation: "not_checked" }] });
		if (action === "show") assert.deepEqual(result.value, nativeShown);
		if (action === "raw") {
			assert.deepEqual(result.value, { ...nativeShown, raw: nativeText });
			assert.doesNotMatch(result.text.trimEnd(), /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u);
		} else assert.doesNotMatch(result.text, /packed-private-|"(?:session_id|payload|raw|serialized|path)"/u);
		if (action === "invalid") assert.equal(result.value.error, "invalid_receipt");
		assert.equal(readFileSync(nativePath, "utf8"), nativeText);
		const after = statSync(nativePath);
		for (const field of ["dev", "ino", "mode", "mtimeMs", "size"]) assert.equal(after[field], nativeBefore[field]);
		assert.deepEqual(readdirSync(nativeDir), [nativeReceipt]);
	}
	// Arrange: replace only fetch with a narrow in-process viewer. Socket and SQLite bans remain active.
	const recoveryPreload = join(home, "native-recovery.mjs");
	const requests = join(home, "native-recovery-requests");
	env.CODEMEM_EMBEDDING_DISABLED = env.CODEMEM_EMBEDDING_OFFLINE = "1";
	env.CODEMEM_VIEWER_HOST = "127.0.0.1";
	env.CODEMEM_VIEWER_PORT = "38888";
	writeFileSync(recoveryPreload, `
import ${JSON.stringify(pathToFileURL(preload).href)};
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { buildViewerIdentityTarget } from ${JSON.stringify(pathToFileURL(join(installDir, "node_modules/@codemem/core/dist/index.js")).href)};
const forbidden = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "http://127.0.0.1:38888") return forbidden();
  appendFileSync(${JSON.stringify(requests)}, url.pathname + "\\n");
  assert.equal(init.redirect, "error");
  assert(init.signal instanceof AbortSignal);
  if (url.pathname === "/api/prompt-pack-profile" && !init.method)
    return Response.json({ service: "codemem-viewer", protocol_version: 1, min_supported_protocol_version: 1,
      db_path: process.env.CODEMEM_DB, identity_target: buildViewerIdentityTarget() });
  if (url.pathname === "/api/raw-events/status" && !init.method)
    return Response.json({ ingest: { available: true, max_body_bytes: 1048576 } });
  if (url.pathname !== "/api/claude-hooks" || init.method !== "POST") return forbidden();
  const body = JSON.parse(init.body);
  assert.equal(body.db_path, process.env.CODEMEM_DB);
  assert.deepEqual(body.identity_target, buildViewerIdentityTarget());
  assert.equal(body.session_id, "packed-private-native");
  assert.equal(typeof body.prompt, "string");
  assert.equal(Object.hasOwn(body, "events"), false);
  return Response.json({ accepted: 1, queued: 1 }, { status: 202 });
};
`, { mode: 0o600 });
	// Act: use the installed CLI and retain the acknowledged receipt explicitly.
	const recoveryArgs = ["recover-rejected", nativeReceipt, ...nativeFlags, "--db-path", env.CODEMEM_DB, "-y", "--json"];
	const kept = invoke([...recoveryArgs, "--keep-receipt"], 0, { recoveryPreload });
	// Assert: accepted delivery cannot modify evidence when retention was requested.
	assert.equal(kept.value.ok, true);
	assert.deepEqual(kept.value.recovery, { delivery: "accepted", acknowledgement: "queued", cleanup: "kept", lock: "released" });
	assert.equal(readFileSync(nativePath, "utf8"), nativeText);
	for (const field of ["dev", "ino", "mode", "mtimeMs", "size"]) assert.equal(statSync(nativePath)[field], nativeBefore[field]);
	assert.deepEqual(readFileSync(requests, "utf8").trim().split("\n"), ["/api/prompt-pack-profile", "/api/raw-events/status", "/api/claude-hooks"]);
	assert.doesNotMatch(kept.text, /packed-private-|"(?:session_id|payload|raw|serialized|path)"/u);
	// Arrange: any saved Pi cutoff is unsupported, including null, without consulting a viewer.
	env.CODEMEM_PI_HOOK_SPOOL_DIR = nativeDir;
	const piText = JSON.stringify({ piEvent: "session_shutdown", sessionId: "packed-private-native", _codememBoundaryThroughEventSeq: null });
	writeFileSync(nativePath, piText);
	const piBefore = statSync(nativePath);
	const requestsBefore = readFileSync(requests, "utf8");
	// Act
	const unsupported = invoke(["recover-rejected", nativeReceipt, "--format", "native-hook-v1", "--provider", "pi", "--db-path", env.CODEMEM_DB, "-y", "--json"], 1, { recoveryPreload });
	// Assert
	assert.equal(unsupported.value.ok, false);
	assert.equal(unsupported.value.error, "pi_boundary_snapshot_unsupported");
	assert.equal(readFileSync(requests, "utf8"), requestsBefore);
	assert.equal(readFileSync(nativePath, "utf8"), piText);
	for (const field of ["dev", "ino", "mode", "mtimeMs", "size"]) assert.equal(statSync(nativePath)[field], piBefore[field]);
	// Act: ordinary recovery removes only the acknowledged native receipt by default.
	writeFileSync(nativePath, nativeText);
	const removed = invoke(recoveryArgs, 0, { recoveryPreload });
	// Assert
	assert.equal(removed.value.ok, true);
	assert.deepEqual(removed.value.recovery, { delivery: "accepted", acknowledgement: "queued", cleanup: "removed", lock: "released" });
	assert.deepEqual(readdirSync(nativeDir), []);
	process.stdout.write("Packed capture: inspection, queued native recovery, retained bytes, and unsupported Pi cutoff passed\n");
}
