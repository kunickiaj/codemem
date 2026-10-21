import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Run outside Vitest's rejection listeners: a response alone cannot detect a later Node crash.
const childSource = `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
const { createCoordinatorApp } = await import(process.argv[1]);
const { BetterSqliteCoordinatorStore } = await import(process.argv[2]);
const [mode, dbPath] = process.argv.slice(3);
const controller = new AbortController();
let digestCalls = 0, verified = false, abortedDuringDigest = false;
let storeOpens = 0, cancellations = 0, reads = 0, networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("network forbidden"); };
const digest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (...args) => digest(...args).then((result) => {
  digestCalls++;
  if (mode === "during-auth" && !controller.signal.aborted) {
    abortedDuringDigest = true;
    controller.abort();
  }
  return result;
});
const verify = crypto.subtle.verify.bind(crypto.subtle);
crypto.subtle.verify = (...args) => verify(...args).then((result) => {
  verified = result;
  return result;
});
const app = createCoordinatorApp({
  storeFactory: (options) => {
    storeOpens++;
    return new BetterSqliteCoordinatorStore(dbPath, options);
  },
  deviceRevocation: { coordinatorId: "coordinator-a" },
  runtime: { adminSecret: () => "test-secret", now: () => "2026-10-20T00:00:00Z" },
  requestVerifier: () => false,
});
const body = new ReadableStream({
  start(stream) {
    stream.enqueue(new TextEncoder().encode(JSON.stringify({ group_id: "group-a", device_id: "device-a" })));
  },
  pull() { reads++; },
  cancel() { cancellations++; return new Promise(() => {}); },
}, { highWaterMark: 0 });
const request = new Request("https://coordinator.example.test/v1/admin/devices/revoke-preview", {
  method: "POST", duplex: "half", body, signal: controller.signal,
  headers: { "Content-Type": "application/json", "X-Codemem-Coordinator-Admin": "test-secret" },
});
assert.equal(existsSync(dbPath), false);
if (mode === "pre-aborted") controller.abort();
const response = await app.fetch(request);
console.log(JSON.stringify({ phase: "response", status: response.status }));
assert.equal(response.status, 503);
assert.deepEqual(await response.json(), { error: "device_revocation_incomplete" });
assert.equal(verified, true);
assert.equal(digestCalls, 2);
assert.equal(abortedDuringDigest, mode === "during-auth");
assert.equal(storeOpens, 0);
assert.equal(existsSync(dbPath), false);
assert.equal(cancellations, 1);
assert.equal(reads, 0);
assert.equal(networkCalls, 0);
// An orphan rejection must crash strict Node before this event-loop checkpoint.
await setImmediate();
console.log(JSON.stringify({ phase: "alive", storeOpens, cancellations, verified }));
`;

it.each(["pre-aborted", "during-auth"])(
	"keeps strict Node alive after a mounted SQLite request aborts %s",
	(mode) => {
		// Arrange: the real SQLite factory must stay lazy even after real WebCrypto authenticates.
		const directory = mkdtempSync(join(tmpdir(), "codemem-revocation-abort-"));
		try {
			// Act: no process.exit or global rejection/exception listeners in the child.
			const child = spawnSync(
				process.execPath,
				[
					"--unhandled-rejections=strict",
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					childSource,
					new URL("./coordinator-api.ts", import.meta.url).href,
					new URL("./better-sqlite-coordinator-store.ts", import.meta.url).href,
					mode,
					join(directory, "must-not-create.sqlite"),
				],
				{ encoding: "utf8", timeout: 4000 },
			);
			// Assert: natural exit after a real event-loop tick, including never-settling cancellation.
			expect(child.error).toBeUndefined();
			expect(child.signal).toBeNull();
			expect(child.status, child.stderr).toBe(0);
			expect(child.stderr).toBe("");
			expect(
				child.stdout
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toEqual([
				{ phase: "response", status: 503 },
				{ phase: "alive", storeOpens: 0, cancellations: 1, verified: true },
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
