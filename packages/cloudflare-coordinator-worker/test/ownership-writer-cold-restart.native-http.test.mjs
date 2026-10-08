import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";

const require = createRequire(new URL("../package.json", import.meta.url));
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
const { build } = runtimeRequire("esbuild");
const migrations = await readD1Migrations(fileURLToPath(new URL("../migrations", import.meta.url)));
// Standalone runs require `pnpm --filter @codemem/core build` first; test:worker rebuilds Core.
const bundled = await build({
  stdin: {
    contents: `
import { D1CoordinatorStore } from '@codemem/core/internal/cloudflare-coordinator';
import { lifecycleOperation } from '../../core/src/shared-ownership-writer-lifecycle-test-harness.ts';
import { revocationInput } from '../../core/src/coordinator-device-revocation-test-harness.ts';
import { fingerprintPublicKey } from '../../core/src/sync-fingerprint.ts';
import { UNRELATED_PUBLIC_KEY } from '../../core/src/coordinator-enrollment-revocation-test-harness.ts';
const allowed = ['enrollDevice','setDeviceEnabled','consumeRecipientInvite','consumeProjectInvite','reviewJoinRequest'];
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-06T00:00:00.000Z'])); }
  static now() { return RealDate.parse('2026-10-06T00:00:00.000Z'); }
};
export default { async fetch(request, env) {
  const store = new D1CoordinatorStore(env.DB);
  const body = await request.json();
  try {
    if (body.prepare) {
      const input = { ...revocationInput('cold-owner'), ...body.input };
      if (body.evidence === 'current key') input.publicKey = UNRELATED_PUBLIC_KEY;
      input.fingerprint = fingerprintPublicKey(input.publicKey);
      return Response.json({ operation: await lifecycleOperation({store, input}, body.prepare), publicKey: input.publicKey });
    }
    if (!allowed.includes(body.operation.method)) throw new Error('Unknown fixture method');
    return Response.json({result: await store[body.operation.method](...body.operation.args)});
  } catch (error) { return Response.json({error: error.message}, {status: 403}); }
} };`,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    sourcefile: "test-only-owned-cold-entry.ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  external: ["node:buffer", "node:crypto", "node:path"],
  alias: { "@codemem/core/internal/cloudflare-coordinator": fileURLToPath(new URL("../../core/dist/internal/cloudflare-coordinator.js", import.meta.url)) },
  plugins: [{
    name: "fixture-registration-not-in-worker",
    setup(builder) {
      // Only pure fixture preparation is used in workerd; Vitest registration is not.
      builder.onResolve({filter: /^vitest$/}, () => ({path: "vitest", namespace: "fixture"}));
      builder.onLoad({filter: /.*/, namespace: "fixture"}, () => ({contents: "export const expect = () => { throw new Error('Unexpected test assertion in worker'); }; export const it = {}; export const vi = {};", loader: "js"}));
    },
  }],
});
const baseOptions = convertV4MiniflareOptions({
  modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: "2026-03-28", compatibilityFlags: ["nodejs_compat"],
  d1Databases: {DB: "a1880bb6-f014-4aa3-9cb5-ea51d4dd9c94"},
  cf: false, host: "127.0.0.1", port: 0,
  outboundService: () => { throw new Error("network forbidden"); },
});
async function snapshot(db) {
  const {results} = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  return Promise.all(results.map(async ({name}) => [name, (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results]));
}
for (const writer of ["enroll", "enable", "add_device", "team_member", "project", "join"]) {
  for (const evidence of ["ID", "incoming key", "current key"]) {
    if (writer === "enable" && evidence === "incoming key") continue;
    if (evidence === "current key" && !["enroll", "enable", "join"].includes(writer)) continue;
    for (const owned of [false, true]) {
      test(`native persisted cold restart: enroll -> ${writer}, ${evidence}, owned=${owned}`, async t => {
        // Arrange: the first runtime writes a clean enrollment and prepares the next writer.
        const directory = await mkdtemp(join(tmpdir(), "ownership-d1-cold-"));
        // Installed Miniflare 5 alpha forwards resourcePersistencePath, not d1Persist.
        const options = {...baseOptions, resourcePersistencePath: directory};
        let mf;
        t.after(async () => {
          try { await mf?.dispose(); }
          finally { await rm(directory, {recursive: true, force: true}); }
        });
        mf = new Miniflare(options);
        let db = await mf.getD1Database("DB");
        for (const migration of migrations) await db.batch(migration.queries.map(sql => db.prepare(sql)));
        const request = async body => {
          const response = await mf.dispatchFetch("http://fixture.invalid/", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
          return {status: response.status, body: await response.json()};
        };
        const first = await request({prepare: "enroll"});
        assert.equal(first.status, 200);
        assert.equal((await request({operation: first.body.operation})).status, 200);
        const original = first.body.operation.args[1];
        await db.prepare("UPDATE enrolled_devices SET identity_id = NULL, enabled = 0 WHERE device_id = ?").bind(original.deviceId).run();
        const input = {...original};
        if (evidence === "incoming key") { input.deviceId += "-new-id"; input.publicKey += " cold-alias"; }
        const prepared = await request({prepare: writer, input, evidence});
        assert.equal(prepared.status, 200);
        if (owned) await db.prepare("INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) VALUES (?,?,?,?,?,?,?,?)").bind(evidence === "ID" ? original.deviceId : "other-retained-device", evidence === "ID" ? "b".repeat(64) : "6db5e9b8a1bace1cdd9a7c6adb9e9396acc5073465d9fe8e3a0ef6d9c60d6d4f", "recipient-identity", "coordinator-a", "binding-a", "owner_enrollment", "raw-fixture-not-proof", "2026-10-07T00:00:00.000Z").run();
        const before = await snapshot(db);
        // A new Miniflare object replaces the disposed runtime and reopens native D1 storage.
        await mf.dispose();
        mf = new Miniflare(options);
        db = await mf.getD1Database("DB");
        assert.deepEqual(await snapshot(db), before);
        // Act: replay the captured operation inside the new Worker's request context.
        const result = await request({operation: prepared.body.operation});
        // Assert: retained evidence denies without altering any persisted application rows.
        if (owned) {
          assert.deepEqual(result, {status: 403, body: {error: "device_ownership_requires_verified_identity"}});
          assert.deepEqual(await snapshot(db), before);
        } else {
          assert.equal(result.status, 200);
          const enrollment = await db.prepare("SELECT enabled, public_key FROM enrolled_devices WHERE device_id = ?").bind(input.deviceId).first();
          assert.equal(enrollment.enabled, 1);
          assert.equal(enrollment.public_key, writer === "enable" ? original.publicKey : prepared.body.publicKey);
        }
      });
    }
  }
}
