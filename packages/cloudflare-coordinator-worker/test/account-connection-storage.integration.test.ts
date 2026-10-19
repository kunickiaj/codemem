import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { beforeAll, expect, it } from "vitest";
import {
 ACCOUNT_CONNECTION_STORAGE_STATEMENTS, CONNECTION_ALLOCATE_ORDER_SQL, CONNECTION_ARCHIVED_CURRENT_MATCH_SQL, CONNECTION_ASSERT_ONE_WRITE_SQL,
 CONNECTION_BIRTH_COLUMNS, CONNECTION_DISCONNECTED_HEAD_SQL,
} from "../../core/src/coordinator-account-connection-storage.js";

const db = (env as unknown as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
const current = "coordinator_auth_account_links";
const history = "coordinator_auth_account_connection_history";
const orders = "coordinator_auth_account_connection_orders";
const columns = CONNECTION_BIRTH_COLUMNS.join(",");
const hash = "a".repeat(64);
const assertOne = () => db.prepare(CONNECTION_ASSERT_ONE_WRITE_SQL);
const rows = async (table: string, coordinator: string) => (await db.prepare(`SELECT * FROM ${table} WHERE coordinator_id = ?`).bind(coordinator).all()).results;

beforeAll(async () => {
 await db.batch(ACCOUNT_CONNECTION_STORAGE_STATEMENTS.map((sql) => db.prepare(sql)));
 // Fixture-only future column: no production schema activation.
 await db.prepare("ALTER TABLE coordinator_auth_browser_transactions ADD COLUMN start_order INTEGER").run();
});

// Seeded storage facts only. Core tests exercise the actual V2 link producer.
async function seed(coordinator: string) {
 await db.prepare(`INSERT INTO ${current} (${columns}) VALUES (?,'A','issuer','account-A','identity','birth','controller',?,0,NULL,'controller_attestation',NULL)`).bind(coordinator, hash).run();
}
function move(coordinator: string) {
 return [
  db.prepare(`INSERT INTO ${history} (${columns},original_rowid,ended_at_ms,end_attempt_id) SELECT ${columns},rowid,1,'fixture-end' FROM ${current} WHERE coordinator_id = ? AND link_id = 'A'`).bind(coordinator), assertOne(),
  db.prepare(`DELETE FROM ${current} AS c WHERE coordinator_id = ? AND link_id = 'A' AND EXISTS (SELECT 1 FROM ${history} h WHERE h.coordinator_id = ? AND h.link_id = 'A' AND h.end_attempt_id = 'fixture-end' AND ${CONNECTION_ARCHIVED_CURRENT_MATCH_SQL})`).bind(coordinator, coordinator), assertOne(),
 ];
}
function reconnect(coordinator: string, id: string) {
 const projection = CONNECTION_BIRTH_COLUMNS.map((c) => {
  if (c === "link_id" || c === "subject" || c === "attempt_id") return "?";
  return `h.${c}`;
 }).join(",");
 return [
  db.prepare(`INSERT INTO ${current} (${columns}) SELECT ${projection} FROM (${CONNECTION_DISCONNECTED_HEAD_SQL}) h`).bind(id, id, id, coordinator, "A"), assertOne(),
  db.prepare(`UPDATE ${history} SET successor_link_id = ? WHERE coordinator_id = ? AND link_id = 'A' AND successor_link_id IS NULL`).bind(id, coordinator), assertOne(),
 ];
}

it("native D1 MOVE preserves raw birth/rowid, rolls back faults, and invalidates real session joins", async () => {
 const coordinator = "native-move";
 await seed(coordinator);
 const before = await db.prepare(`SELECT rowid AS original_rowid,* FROM ${current} WHERE coordinator_id = ?`).bind(coordinator).first();
 await db.prepare(`INSERT INTO coordinator_auth_sessions (coordinator_id,session_id,credential_hash,browser_transaction_hash,link_id,identity_id,issuer,subject,auth_config_revision,created_at_ms,expires_at_ms) VALUES (?,'session',?,?,'A','identity','issuer','account-A',?,0,28800000)`).bind(coordinator, hash, hash, hash).run();
 const joined = () => db.prepare(`SELECT count(*) AS n FROM coordinator_auth_sessions s JOIN ${current} l ON l.coordinator_id = s.coordinator_id AND l.link_id = s.link_id WHERE s.coordinator_id = ?`).bind(coordinator).first();
 expect(await joined()).toEqual({ n: 1 });
 const writes = move(coordinator);
 await expect(db.batch([...writes.slice(0, 2), db.prepare(`INSERT INTO ${orders} DEFAULT VALUES`), ...writes.slice(2)])).rejects.toThrow();
 expect(await rows(history, coordinator)).toEqual([]);
 expect(await joined()).toEqual({ n: 1 });
 await db.batch(writes);
 expect(await rows(history, coordinator)).toEqual([{ ...before, ended_at_ms: 1, end_attempt_id: "fixture-end", successor_link_id: null }]);
 expect(await joined()).toEqual({ n: 0 });
 await expect(db.batch(move(coordinator))).rejects.toThrow();
});

it("native D1 competing atomic reconnect batches have exactly one CAS winner and no loser row", async () => {
 const coordinator = "native-race";
 await seed(coordinator);
 await db.batch(move(coordinator));
 // Real concurrent native batch calls; no mock success or manually serialized calls.
 const outcomes = await Promise.allSettled([db.batch(reconnect(coordinator, "B")), db.batch(reconnect(coordinator, "C"))]);
 expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
 expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
 const active = await rows(current, coordinator);
 expect(active).toHaveLength(1);
 expect(await rows(history, coordinator)).toMatchObject([{ link_id: "A", successor_link_id: active[0]?.link_id }]);
 await db.prepare(`UPDATE ${history} SET revoked_at_ms = 2 WHERE coordinator_id = ?`).bind(coordinator).run();
 await db.prepare(`DELETE FROM ${current} WHERE coordinator_id = ?`).bind(coordinator).run();
 await expect(db.batch(reconnect(coordinator, "D"))).rejects.toThrow();
 expect(await rows(current, coordinator)).toEqual([]);
});

it("native D1 rejects rowid and head REPLACE collisions while normal archive remains valid", async () => {
 const coordinator = "native-replace";
 await seed(coordinator);
 await db.batch(move(coordinator));
 await db.batch(reconnect(coordinator, "B"));
 const before = await rows(history, coordinator);
 const archive = (rowid: string, end: string) => db.prepare(`INSERT OR REPLACE INTO ${history} (rowid,${columns},original_rowid,ended_at_ms,end_attempt_id) SELECT ${rowid},${columns},rowid,1,? FROM ${current} WHERE coordinator_id=?`).bind(end, coordinator);
 const old = await db.prepare(`SELECT rowid AS id FROM ${history} WHERE coordinator_id=?`).bind(coordinator).first<{id:number}>();
 await expect(archive(String(old?.id), "end-B").run()).rejects.toThrow(/connection_archive_source_invalid/);
 for (const rowid of ["-2", "-1", "0"]) await expect(archive(rowid, "end-B").run()).rejects.toThrow(/connection_archive_source_invalid/);
 expect(await rows(history, coordinator)).toEqual(before);
 await db.prepare(`INSERT INTO ${history} (${columns},original_rowid,ended_at_ms,end_attempt_id) SELECT ${columns},rowid,1,'end-B' FROM ${current} WHERE coordinator_id=?`).bind(coordinator).run();
 await db.prepare(`CREATE UNIQUE INDEX connection_history_head ON ${history}(coordinator_id,identity_id) WHERE successor_link_id IS NULL`).run();
 const both = await rows(history, coordinator);
 await db.prepare(`DELETE FROM ${current} WHERE coordinator_id=?`).bind(coordinator).run();
 await db.prepare(`INSERT INTO ${current} (${columns}) SELECT ${CONNECTION_BIRTH_COLUMNS.map(c => c === "link_id" || c === "attempt_id" ? "'C'" : c).join(",")} FROM ${history} WHERE coordinator_id=? AND link_id='B'`).bind(coordinator).run();
 await expect(archive("999", "end-C").run()).rejects.toThrow(/connection_archive_source_invalid/);
 await expect(db.prepare(`UPDATE OR REPLACE ${history} SET rowid=999 WHERE coordinator_id=?`).bind(coordinator).run()).rejects.toThrow(/connection_history_immutable/);
 expect(await rows(history, coordinator)).toEqual(both);
});

it("native D1 start allocation shares its browser-row transaction, survives cleanup and fails overflow atomically", async () => {
 const coordinator = "native-orders";
 await db.prepare(`INSERT INTO ${orders} VALUES (?,0)`).bind(coordinator).run();
 const start = () => [
  db.prepare(CONNECTION_ALLOCATE_ORDER_SQL).bind(coordinator), assertOne(),
  db.prepare(`INSERT INTO coordinator_auth_browser_transactions (coordinator_id,browser_transaction_hash,purpose,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms,start_order)
   SELECT coordinator_id,?,'signin',?,?,'issuer',?,'https://example.test/callback','pending',?,?,0,600000,last_order FROM ${orders} WHERE coordinator_id = ?`).bind(hash, hash, hash, hash, "n".repeat(43), "p".repeat(43), coordinator), assertOne(),
 ];
 await db.batch(start());
 await db.prepare("DELETE FROM coordinator_auth_browser_transactions WHERE coordinator_id = ?").bind(coordinator).run();
 await expect(db.batch([...start(), db.prepare(`INSERT INTO ${orders} DEFAULT VALUES`)])).rejects.toThrow();
 expect(await rows(orders, coordinator)).toEqual([{ coordinator_id: coordinator, last_order: 1 }]);
 await db.batch(start());
 expect(await rows(orders, coordinator)).toEqual([{ coordinator_id: coordinator, last_order: 2 }]);
 // Fixture boundary seed only; production has no reset helper.
 await db.prepare("DROP TRIGGER account_connection_order_update").run();
 await db.prepare(`UPDATE ${orders} SET last_order = ? WHERE coordinator_id = ?`).bind(Number.MAX_SAFE_INTEGER, coordinator).run();
 await db.prepare(ACCOUNT_CONNECTION_STORAGE_STATEMENTS.find((sql) => sql.startsWith("CREATE TRIGGER account_connection_order_update")) as string).run();
 await expect(db.batch(start())).rejects.toThrow(/CHECK constraint failed/);
 expect(await rows(orders, coordinator)).toEqual([{ coordinator_id: coordinator, last_order: Number.MAX_SAFE_INTEGER }]);
 expect(await rows("coordinator_auth_browser_transactions", coordinator)).toHaveLength(1);
});
