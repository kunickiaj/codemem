import type { D1Database } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { changeFixture, changeTable, config, hash, input, protectedTables } from "./account-change-fixture.js";
import { otherKey } from "./device-claim-eligibility-fixture.js";
import type { AuthLinkBackend } from "../../core/src/coordinator-auth-link.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

it("native D1 compiles current-authority predicates and atomically refreshes/disconnects with fault rollback and exact retries", async () => {
 const db = (env as unknown as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
 const backend: AuthLinkBackend = {
  first: ({ sql, values }) => db.prepare(sql).bind(...values).first(),
  run: async ({ sql, values }) => (await db.prepare(sql).bind(...values).run()).meta.changes,
  batch: (statements) => db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values))),
 };
 const store = new D1CoordinatorStore(db, { authClock: () => 1791028800000 });
 const f = await changeFixture(store, backend);
 const rows = async (table: string) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
 const snapshot = () => Promise.all([...protectedTables, "coordinator_auth_link_profiles", "coordinator_auth_account_profiles", changeTable].map(rows));
 await f.prepare(1, "refresh", { displayName: "Native fresh" });
 const protectedBefore = await Promise.all(protectedTables.map(rows));
 expect(await f.operations.finalize(f.proof(), config)).toMatchObject({ intent: "refresh" });
 expect(await Promise.all(protectedTables.map(rows))).toEqual(protectedBefore);
 expect(await rows("coordinator_auth_link_profiles")).toMatchObject([{ display_name: "Native fresh", source_change_attempt_id: "change-1", source_order: 2 }]);
 // A current reviewed key is independent of the original device-claim key.
 const signer = { groupId: input.signer.groupId,deviceId: "unrelated-device",publicKey: otherKey,fingerprint: "b".repeat(64) };
 await f.exec("UPDATE enrolled_devices SET identity_id = ? WHERE device_id = ?",input.identityId,signer.deviceId);
 expect(await store.createAuthControllerAttestation({ coordinatorId: config.coordinatorId,identityId: input.identityId,...signer,attestationId: "current",reviewReceiptId: "current-review",evidenceDigest: hash(888) })).toMatchObject({ kind: "created" });
 const reviewedRequest = { ...f.request(2,"refresh"),signer };
 expect(await f.operations.create(reviewedRequest,config)).toBe(true);
 expect(await f.operations.create(reviewedRequest,config)).toBe(true);
 await f.operations.claimBrowser(f.materials(2),config);
 await f.operations.consumeCallback(f.materials(2),config);
 await f.operations.recordVerifiedCallback(f.verified(2),config);
 await f.exec("UPDATE coordinator_auth_controller_attestations SET revoked_at = 'now' WHERE attestation_id = 'current'");
 expect(await f.operations.finalize({ ...f.proof(2),signer },config)).toBeNull();
 expect(await f.operations.cancel(reviewedRequest,config)).toBe(true);
 const admissions = await Promise.all([3,4,5].map((n) => f.operations.create(f.request(n),config)));
 expect(admissions.filter(Boolean)).toHaveLength(2);
 const winners = [3,4,5].filter((_n,index) => admissions[index]);
 const failed = winners[0], expired = winners[1];
 if (failed === undefined || expired === undefined) throw new Error("native quota winners missing");
 await f.operations.claimBrowser(f.materials(failed),config);
 expect(await f.operations.hasPendingCallback(f.materials(failed),config)).toBe(true);
 await f.operations.consumeCallback(f.materials(failed),config);
 expect(await f.operations.failConsumed({ ...f.materials(failed),binderHash: hash(999) },config)).toBe(false);
 expect(await f.operations.failConsumed(f.materials(failed),config)).toBe(true);
 await f.operations.claimBrowser(f.materials(expired),config);
 f.clock.now += 600000;
 const receipt = (await rows(changeTable))[0];
 expect(await f.operations.maintainExpired(config.coordinatorId,1)).toBe(1);
 expect((await rows(changeTable))[0]).toEqual(receipt);
 expect((await rows(changeTable)).find((a) => a.attempt_id === `change-${expired}`)).toMatchObject({ state: "expired",nonce: null,pkce_verifier: null });
 await f.prepare(6, "disconnect");
 await db.prepare("CREATE TRIGGER fail_change_profile_delete BEFORE DELETE ON coordinator_auth_link_profiles BEGIN SELECT RAISE(ABORT,'injected'); END").run();
 const before = await snapshot();
 expect(await f.operations.finalize(f.proof(6), config)).toBeNull();
 expect(await snapshot()).toEqual(before);
 await db.prepare("DROP TRIGGER fail_change_profile_delete").run();
 const results = await Promise.all([f.operations.finalize(f.proof(6), config), f.operations.finalize(f.proof(6), config)]);
 expect(results[0]).toMatchObject({ intent: "disconnect" });
 expect(results[1]).toEqual(results[0]);
 const committed = await snapshot();
 expect(await f.operations.finalize(f.proof(6), config)).toEqual(results[0]);
 expect(await snapshot()).toEqual(committed);
 expect(await rows("coordinator_auth_account_links")).toEqual([]);
 expect(await rows("coordinator_auth_account_connection_history")).toMatchObject([{ end_attempt_id: "change-6" }]);
 expect(await rows("coordinator_auth_sessions")).toMatchObject([{ revoked_at_ms: f.clock.now }]);
 expect(await rows("coordinator_auth_link_profiles")).toEqual([]);
 expect((await rows(changeTable)).filter((a) => a.state === 'completed')).toMatchObject([{ display_name: null }, { display_name: null }]);
});
