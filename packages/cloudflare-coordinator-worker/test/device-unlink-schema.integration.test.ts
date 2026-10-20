import type { D1Database } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { changeFixture } from "./account-change-fixture.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import type { AuthLinkBackend } from "../../core/src/coordinator-auth-link.js";
import { ACCOUNT_UNLINK_MIGRATION_STATEMENTS, PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS, readConnectionSchemaState } from "../../core/src/coordinator-account-connection-schema.js";

it("native D1 atomically upgrades the exact prior 38-statement schema without changing existing rows or proof bytes",async()=>{
 const db=(env as unknown as {COORDINATOR_DB:D1Database}).COORDINATOR_DB;
 const backend:AuthLinkBackend={first:({sql,values})=>db.prepare(sql).bind(...values).first(),run:async({sql,values})=>(await db.prepare(sql).bind(...values).run()).meta.changes,batch:statements=>db.batch(statements.map(({sql,values})=>db.prepare(sql).bind(...values)))};
 const names=["coordinator_auth_account_links","coordinator_auth_link_attempts","coordinator_auth_device_claims","coordinator_auth_sessions","coordinator_auth_session_receipts","coordinator_auth_link_profiles","coordinator_auth_account_profiles","enrolled_devices","coordinator_identity_group_grants"];
 const snapshot=()=>Promise.all(names.map(async name=>{
  const definition=await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<{sql:string}>();
  const columns=definition?.sql.includes("WITHOUT ROWID") ? "*" : "rowid,*";
  return (await db.prepare(`SELECT ${columns} FROM ${name}`).all()).results;
 }));
 let before:Awaited<ReturnType<typeof snapshot>>=[];
 await changeFixture(new D1CoordinatorStore(db,{authClock:()=>1791028800000}),backend,"device_claim",async()=>{
  await backend.batch(PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.map(sql=>({sql,values:[]})));
  before=await snapshot();
  const schema=(await db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).results;
  const faulty=ACCOUNT_UNLINK_MIGRATION_STATEMENTS.map(sql=>({sql,values:[]}));
  faulty.splice(-1,0,{sql:"INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) VALUES(NULL,0)",values:[]});
  await expect(backend.batch(faulty)).rejects.toThrow();
  expect((await db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).results).toEqual(schema);
  expect(await snapshot()).toEqual(before);
 });
 expect(await readConnectionSchemaState(backend)).toBe("ready");
 expect(await snapshot()).toEqual(before);
 await expect(backend.run({sql:PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.at(-1) ?? "",values:[]})).rejects.toThrow();
});
