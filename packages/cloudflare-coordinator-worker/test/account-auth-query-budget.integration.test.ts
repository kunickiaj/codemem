import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { env } from "cloudflare:workers";
import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { afterEach, expect, it, vi } from "vitest";
import { changeFixture, config, input, NOW } from "./account-change-fixture.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../core/src/d1-coordinator-store.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { issueBrowserCookie, BROWSER_COOKIE_NAMES } from "../../core/src/coordinator-browser-credential.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { AUTH_ACCOUNT_CHANGE_PURPOSE } from "../../core/src/coordinator-account-change-contract.js";
import { createConfiguredCloudflareCoordinatorWorker } from "../src/index.js";
import { hasConnectionSessionSchema } from "../../core/src/coordinator-account-connection-session.js";
import { withCoordinatorAuthSchema, CoordinatorAuthSchemaUpgradeRequiredError } from "../../core/src/coordinator-auth-schema.js";
import { pendingOwnerRevokeKey } from "./account-owner-revoke-journey.js";
import { ownerEnrollmentStartMessage } from "../../core/src/owner-enrollment-start.js";
import { resetCeremony } from "./owner-ceremony-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fields = (html: string) => new URLSearchParams([...html.matchAll(/name="([^"]+)" value="([^"]+)"/g)].map((m) => [m[1] ?? "",m[2] ?? ""]));
function link(html: string) { const href=html.match(/href="([^"]+)"/)?.[1]; if (!href) throw new Error("missing link"); return href.replaceAll("&amp;","&"); }
function countedBinding(raw: D1DatabaseLike) {
 const counter = { statements: 0 };
 const originals = new WeakMap<D1PreparedStatementLike,D1PreparedStatementLike>();
  function wrap(statement: D1PreparedStatementLike): D1PreparedStatementLike {
  const wrapped: D1PreparedStatementLike = {
   bind: (...values) => wrap(statement.bind(...values)),
   first: <T>() => { counter.statements++; return statement.first<T>(); },
   all: <T>() => { counter.statements++; return statement.all<T>(); },
   raw: <T>() => { counter.statements++; return statement.raw<T>(); },
   run: () => { counter.statements++; return statement.run(); },
  };
  originals.set(wrapped,statement); return wrapped;
 }
 const db: D1DatabaseLike = { prepare: (sql) => wrap(raw.prepare(sql)), batch: async (statements) => {
  counter.statements += statements.length;
  const batch=raw.batch?.bind(raw); if (!batch) throw new Error("missing native batch");
  return batch(statements.map((s) => { const original=originals.get(s); if (!original) throw new Error("unknown statement"); return original; }));
 } };
 return { db, counter };
}
type Definition = { type: string; name: string; sql: string };
let initialAuthSchema: Definition[] | undefined;
async function fixture(authority?: "device_claim" | "controller_attestation") {
 const native = (env as unknown as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
 const definitions = (await native.prepare(`SELECT type,name,sql FROM sqlite_master
  WHERE (tbl_name GLOB 'coordinator_auth_*' OR tbl_name='coordinator_account_change_attempts')
  AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name`).all<Definition>()).results;
 if (!initialAuthSchema) initialAuthSchema = definitions;
 else {
  await resetCeremony();
  await native.batch([
   ...definitions.filter(row => row.type === "table").map(row => native.prepare(`DROP TABLE "${row.name}"`)),
   ...initialAuthSchema.map(row => native.prepare(row.sql)),
  ]);
 }
 vi.spyOn(Date,"now").mockReturnValue(NOW);
 const {db,counter}=countedBinding((env as unknown as { COORDINATOR_DB: D1Database }).COORDINATOR_DB);
 const store=new D1CoordinatorStore(db,{authClock:()=>NOW});
 const backend={first:<T>({sql,values}:{sql:string;values:(string|number|null)[]})=>db.prepare(sql).bind(...values).first<T>(),
   run:async ({sql,values}:{sql:string;values:(string|number|null)[]})=>((await db.prepare(authority && sql.includes("INSERT INTO enrolled_devices") ? sql.replace("a".repeat(64),fingerprintPublicKey(input.signer.publicKey)) : sql).bind(...values).run()) as D1Result).meta.changes,
  batch:(statements:{sql:string;values:(string|number|null)[]}[])=>db.batch?.(statements.map(({sql,values})=>db.prepare(sql).bind(...values))) ?? Promise.reject(new Error("missing batch"))};
 const issuer=config.issuer; config.issuer="https://accounts.google.com";
  const birthFingerprint = input.signer.fingerprint;
  if(authority) input.signer.fingerprint = fingerprintPublicKey(input.signer.publicKey);
  try { await changeFixture(store,backend,authority); } finally { config.issuer=issuer; input.signer.fingerprint=birthFingerprint; }
 const cfg={...config,issuer:"https://accounts.google.com",clientId:PROVIDER.clientId,redirectUri:PROVIDER.redirectUri};
 const provider=oidcFixture({issuer:cfg.issuer}); provider.claims.sub="account-A";
 vi.spyOn(globalThis,"fetch").mockImplementation((url,options)=>{
  if(typeof url!=="string") throw new Error("unexpected provider transport");
  return provider.fetch(url,options as Parameters<typeof provider.fetch>[1]);
 });
 const keys=generateKeyPairSync("ed25519"), raw=Buffer.from(keys.publicKey.export({type:"spki",format:"der"})).subarray(-32);
 const wire=Buffer.alloc(51); wire.writeUInt32BE(11,0); wire.write("ssh-ed25519",4); wire.writeUInt32BE(32,15); raw.copy(wire,19);
 const publicKey=`ssh-ed25519 ${wire.toString("base64")}`, fingerprint=fingerprintPublicKey(publicKey);
 await store.enrollDevice(input.signer.groupId,{deviceId:"budget-device",publicKey,fingerprint});
 await db.prepare("UPDATE enrolled_devices SET identity_id=? WHERE device_id=?").bind(input.identityId,"budget-device").run();
  if(!authority) expect(await store.createAuthControllerAttestation({ ...input.signer, deviceId:"budget-device", publicKey, fingerprint,
  identityId:input.identityId,coordinatorId:cfg.coordinatorId,attestationId:"budget-review",reviewReceiptId:"budget-receipt",evidenceDigest:"f".repeat(64)})).toMatchObject({kind:"created"});
 const session=await issueBrowserCookie("session");
 await db.prepare("UPDATE coordinator_auth_sessions SET credential_hash=?").bind(session.cookieHash).run();
 const sessionHeader=session.setCookie.split(";")[0] ?? "";
 const worker=createConfiguredCloudflareCoordinatorWorker(), origin=new URL(cfg.redirectUri).origin;
 const bindings={...env,COORDINATOR_DB:db,CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG:JSON.stringify({...cfg,ownerEnrollmentEnabled:true}),
   CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET:PROVIDER.clientSecret,CODEMEM_COORDINATOR_BROWSER_CSRF_KEY:"11".repeat(32),CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET:"budget-admin"};
 const request=(path:string,init:RequestInit={}, activeWorker=worker)=>{
  const headers=new Headers(init.headers); headers.set("CF-Connecting-IP","127.0.0.1");
  return activeWorker.fetch(new Request(new URL(path,origin),{...init,headers}),bindings);
 };
  // RFC 8032 test-vector seed matches the existing birth fixture's public key.
  const signingKey = authority ? createPrivateKey({format:"der",type:"pkcs8",key:Buffer.from("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60","hex")}) : keys.privateKey;
  const deviceId = authority ? input.signer.deviceId : "budget-device";
  const signed=async (path:string,body:unknown)=>{
   const text=JSON.stringify(body),timestamp=String(NOW/1000),nonce=Buffer.from(randomBytes(16)).toString("hex");
    const signature=Buffer.from(sign(null,buildCanonicalRequest("POST",path,timestamp,nonce,Buffer.from(text)),signingKey)).toString("base64");
   return request(path,{method:"POST",body:text,headers:{"content-type":"application/json","X-Opencode-Device":deviceId,
   "X-Opencode-Timestamp":timestamp,"X-Opencode-Nonce":nonce,"X-Opencode-Signature":`${SIGNATURE_VERSION}:${signature}`}});
 };
 const post=(path:string,cookie:string,body:URLSearchParams)=>request(path,{method:"POST",body,headers:{origin,cookie,"content-type":"application/x-www-form-urlencoded"}});
  return {db,backend,counter,provider,cfg,request,signed,post,sessionHeader,sessionHash:session.cookieHash,deviceId,fingerprint:authority ? fingerprintPublicKey(input.signer.publicKey) : fingerprint};
}
it("counts executed native D1 statements for configured auth with owner enrollment",async()=>{
 const f=await fixture();
 const counts: Record<string,number> = {};
 let liveSessionHeader=f.sessionHeader;
 for(const action of ["signin","signin-existing","signin-revoked","signin-unknown","refresh","disconnect"] as const) {
 const management=action==="refresh"||action==="disconnect";
 const runtime=Buffer.alloc(32,action==="disconnect"?18:17), start=Buffer.alloc(32,action==="disconnect"?8:7),attemptId=`budget-${action}`;
 const startPath=management?"/auth/account/change/start":"/auth/sign-in";
 if(management) expect((await f.signed("/v1/auth/account-changes",{group_id:input.signer.groupId,identity_id:input.identityId,intent:action,
  attempt_id:attemptId,runtime_verifier_hash:digest(runtime),browser_start_hash:digest(start),loopback_redirect:"http://127.0.0.1:4567/codemem/auth/complete"})).status).toBe(200);
 const page=await f.request(management?`${startPath}?attempt_id=${attemptId}&start_code=${start.toString("base64url")}`:startPath,
   {headers:{cookie:management?liveSessionHeader:""}});
 expect(page.status).toBe(200);
 const startCookie=page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
 const promoted=await f.post(startPath,[startCookie,management?liveSessionHeader:""].filter(Boolean).join("; "),fields(await page.text()));
 expect(promoted.status,await promoted.clone().text()).toBe(200);
 const transaction=promoted.headers.getSetCookie().find((v)=>v.startsWith(`${BROWSER_COOKIE_NAMES.transaction}=`))?.split(";")[0];
 if(!transaction) throw new Error("missing promoted transaction");
 const callback=f.provider.authorize(link(await promoted.text()));
 if(action==="signin-revoked") await f.db.prepare("UPDATE coordinator_auth_sessions SET revoked_at_ms=? WHERE credential_hash=?").bind(NOW,f.sessionHash).run();
 let callbackSession=action!=="signin"?liveSessionHeader:"";
 if(action==="signin-unknown") callbackSession=(await issueBrowserCookie("session")).setCookie.split(";")[0] ?? "";
 f.counter.statements=0;
 const response=await f.request(callback.href,{headers:{cookie:[transaction,callbackSession].filter(Boolean).join("; ")}},createConfiguredCloudflareCoordinatorWorker());
 const callbackCount=f.counter.statements;
 expect(response.status,await response.clone().text()).toBe(management?200:303);
 counts[`${action}-callback`]=callbackCount;
 if(action==="signin-revoked") {
  liveSessionHeader=response.headers.getSetCookie().find((value)=>value.startsWith(`${BROWSER_COOKIE_NAMES.session}=`))?.split(";")[0] ?? "";
  expect(liveSessionHeader).not.toBe("");
 }
 if(!management) continue;
 let html=await response.text();
 if(action==="disconnect") { const confirmed=await f.post("/auth/account/change/confirm",`${transaction}; ${liveSessionHeader}`,fields(html)); expect(confirmed.status).toBe(200); html=await confirmed.text(); }
 const completion=new URL(link(html)).searchParams.get("completion");
 if(!completion) throw new Error("missing verified completion");
 f.counter.statements=0;
 const finalized=await f.signed(`/v1/auth/account-changes/${attemptId}/finalize`,{purpose:AUTH_ACCOUNT_CHANGE_PURPOSE,coordinator_id:f.cfg.coordinatorId,
  attempt_id:attemptId,group_id:input.signer.groupId,identity_id:input.identityId,device_id:"budget-device",fingerprint:f.fingerprint,
  runtime_verifier:runtime.toString("base64url"),completion});
 expect(finalized.status,await finalized.clone().text()).toBe(200);
 counts[`${action}-finalize`]=f.counter.statements;
 }
  // Cold callbacks, including stale SESSION reads, retain five statements of headroom.
  expect(Math.max(...Object.values(counts)),JSON.stringify(counts)).toBeLessThanOrEqual(45);
 expect(counts).toEqual({"signin-callback":39,"signin-existing-callback":27,
  "signin-revoked-callback":44,"signin-unknown-callback":44,
   "refresh-callback":32,"disconnect-callback":32,"refresh-finalize":29,"disconnect-finalize":38});
 const wrapped=withCoordinatorAuthSchema(f.backend,{connections:true});
 f.counter.statements=0;
 expect(await hasConnectionSessionSchema(wrapped)).toBe(true);
 expect(f.counter.statements).toBe(2);
  const trigger = await f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='account_change_birth'").first<{sql:string}>();
  if (!trigger) throw new Error("missing birth trigger");
  await f.db.prepare("DROP TRIGGER account_change_birth").run();
 await expect(hasConnectionSessionSchema(wrapped)).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
 f.counter.statements=0;
 await expect(wrapped.run({sql:"UPDATE coordinator_auth_sessions SET revoked_at_ms=1",values:[]})).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
  expect(f.counter.statements).toBe(2); // Fresh schema reads only; no UPDATE executes.
  await f.db.prepare(trigger.sql).run(); // Restore the shared native schema for the next fixture.
});

it("native mounted callbacks reject cross-table collisions in both insertion orders without consuming PKCE",async()=>{
 for(const regularFirst of [true,false]) {
  const f=await fixture();
  const store=new D1CoordinatorStore(f.db,{authClock:()=>NOW});
  const operations=await store.getAccountChanges();
  const cookie=await issueBrowserCookie('transaction');
  const state='s'.repeat(43),stateHash=digest(Buffer.from(state));
  expect((await f.signed('/v1/auth/account-changes',{group_id:input.signer.groupId,identity_id:input.identityId,intent:'refresh',attempt_id:'collision',runtime_verifier_hash:'a'.repeat(64),browser_start_hash:'b'.repeat(64),loopback_redirect:'http://127.0.0.1:4567/codemem/auth/complete'})).status).toBe(200);
  const pins={attemptId:'collision',browserStartHash:'b'.repeat(64),stateHash,binderHash:cookie.cookieHash,nonce:'n'.repeat(43),pkceVerifier:'p'.repeat(43)};
  const ordinary=()=>store.startAuthBrowserTransaction({stateHash,binderHash:cookie.cookieHash,purpose:'signin',nonce:'o'.repeat(43),pkceVerifier:'q'.repeat(43)},f.cfg);
  if(regularFirst)expect((await ordinary()).kind).toBe('started');
  expect(await operations.claimBrowser(pins,f.cfg)).toBe(true);
  if(!regularFirst)expect((await ordinary()).kind).toBe('started');
  const response=await f.request(`/auth/callback?state=${state}&code=unused`,{headers:{cookie:cookie.setCookie.split(';')[0]??''}});
  expect(response.status).toBe(403);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await f.db.prepare('SELECT state,nonce,pkce_verifier FROM coordinator_account_change_attempts WHERE attempt_id=?').bind('collision').first()).toEqual({state:'browser_pending',nonce:'n'.repeat(43),pkce_verifier:'p'.repeat(43)});
  expect(await f.db.prepare('SELECT state,nonce,pkce_verifier FROM coordinator_auth_browser_transactions WHERE state_hash=? AND binder_hash=?').bind(stateHash,cookie.cookieHash).first()).toEqual({state:'pending',nonce:'o'.repeat(43),pkce_verifier:'q'.repeat(43)});
  expect(f.provider.requests.some(r=>r.url.endsWith('/token'))).toBe(false);
 }
});
it.each(["device_claim", "controller_attestation"] as const)("keeps public %s reconnect and browser redemption below 50 native D1 statements", async (authority) => {
 // Arrange: upgraded native D1, existing account A, and real signed device proofs.
 const f = await fixture(authority), counts: Record<string, number> = {};
 const attemptId = `budget-link-${authority}`, runtime = Buffer.alloc(32, 21), start = Buffer.alloc(32, 22);
 const root = "/v1/auth/link-attempts";
 const cookie = (response: Response) => response.headers.getSetCookie().find((value)=>!value.includes("Max-Age=0"))?.split(";")[0] ?? "";
 // Disconnect A through public proofs before reconnecting the retained Identity.
 const disconnectId = `before-${authority}`;
 expect((await f.signed("/v1/auth/account-changes", {group_id:input.signer.groupId,identity_id:input.identityId,intent:"disconnect",attempt_id:disconnectId,runtime_verifier_hash:digest(runtime),browser_start_hash:digest(start),loopback_redirect:"http://127.0.0.1:4567/codemem/auth/complete"})).status).toBe(200);
 const disconnectPage = await f.request(`/auth/account/change/start?attempt_id=${disconnectId}&start_code=${start.toString("base64url")}`,{headers:{cookie:f.sessionHeader}});
 expect(disconnectPage.status).toBe(200);
 const disconnectStart = await f.post("/auth/account/change/start",`${cookie(disconnectPage)}; ${f.sessionHeader}`,fields(await disconnectPage.text()));
 expect(disconnectStart.status).toBe(200);
 const disconnectCookie = `${cookie(disconnectStart)}; ${f.sessionHeader}`;
 const disconnectCallback = await f.request(f.provider.authorize(link(await disconnectStart.text())).href,{headers:{cookie:disconnectCookie}});
 expect(disconnectCallback.status).toBe(200);
 const disconnectConfirm = await f.post("/auth/account/change/confirm",disconnectCookie,fields(await disconnectCallback.text()));
 expect(disconnectConfirm.status).toBe(200);
 const disconnected = await f.signed(`/v1/auth/account-changes/${disconnectId}/finalize`,{purpose:AUTH_ACCOUNT_CHANGE_PURPOSE,coordinator_id:f.cfg.coordinatorId,attempt_id:disconnectId,group_id:input.signer.groupId,identity_id:input.identityId,device_id:f.deviceId,fingerprint:f.fingerprint,runtime_verifier:runtime.toString("base64url"),completion:new URL(link(await disconnectConfirm.text())).searchParams.get("completion")});
 expect(disconnected.status,await disconnected.clone().text()).toBe(200);
  async function measured(name: string, operation: () => Promise<Response>, status: number) {
   f.counter.statements = 0;
  const response = await operation();
   counts[name] = f.counter.statements;
  expect(response.status, `${name}: ${await response.clone().text()}`).toBe(status);
  expect(counts[name], JSON.stringify(counts)).toBeLessThan(50);
  return response;
 }
 // Act: normal A -> B reconnect, with request-local counters (not fixture setup).
 const created = await measured("create", () => f.signed(root, {
  group_id: input.signer.groupId, identity_id: input.identityId, authority, attempt_id: attemptId,
  runtime_verifier_hash: digest(runtime), browser_start_hash: digest(start),
  loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
 }), 201);
 expect(await created.json()).toMatchObject({ authority });
 const page = await f.request(`/auth/link/start?attempt_id=${attemptId}&start_code=${start.toString("base64url")}`);
 expect(page.status).toBe(200);
 const promoted = await f.post("/auth/link/start", cookie(page), fields(await page.text()));
 expect(promoted.status).toBe(200);
 const binder = cookie(promoted);
 f.provider.claims.sub = "account-B"; f.provider.userInfo.sub = "account-B";
 const callback = f.provider.authorize(link(await promoted.text()));
 const verified = await measured("callback", () => f.request(callback.href, { headers: { cookie: binder } }, createConfiguredCloudflareCoordinatorWorker()), 200);
 const confirmed = await f.post("/auth/link/confirm", binder, fields((await verified.text()).split("</form>")[0] ?? ""));
 expect(confirmed.status, await confirmed.clone().text()).toBe(200);
 const completion = new URL(link(await confirmed.text())).searchParams.get("completion");
 expect(completion).toBeTruthy();
 await measured("finalize", () => f.signed(`${root}/${attemptId}/finalize`, {
  purpose: "coordinator-account-link-v1", coordinator_id: f.cfg.coordinatorId, identity_id: input.identityId,
  attempt_id: attemptId, group_id: input.signer.groupId, device_id: f.deviceId, fingerprint: f.fingerprint,
  runtime_verifier: runtime.toString("base64url"), completion,
 }), 200);
 const completePage = await measured("redemption-page", () => f.request(`/auth/link/complete?attempt_id=${attemptId}`, { headers: { cookie: binder } }), 200);
 const redemptionFields = fields(await completePage.text());
 const redeemed = await measured("redemption", () => f.post("/auth/link/complete", binder, redemptionFields), 303);
 expect(redeemed.headers.getSetCookie().some(value => value.startsWith(`${BROWSER_COOKIE_NAMES.session}=`))).toBe(true);
 // Assert: consumed browser proofs cannot redeem a second session.
 const replay = await f.post("/auth/link/complete", binder, redemptionFields);
 expect(replay.status).toBe(403);
 expect(replay.headers.getSetCookie().some(value => value.startsWith(`${BROWSER_COOKIE_NAMES.session}=`))).toBe(false);
 if (authority === "controller_attestation") {
  // A fresh second owned device signs its own start; no administrator revokes history.
  const grant = await f.request("/v1/admin/identity-group-grants", { method: "POST", headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": "budget-admin" }, body: JSON.stringify({ attestation_id: "controller" }) });
  expect(grant.status,await grant.clone().text()).toBe(200);
  const key = await pendingOwnerRevokeKey(), origin = new URL(f.cfg.redirectUri).origin;
  const ownerStart = { attemptId: "budget-owner", deviceId: "budget-second-device", publicKey: key.publicKey,
   loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete", browserStartCode: Buffer.alloc(32, 23).toString("base64url"), signature: "" };
  ownerStart.signature = await key.sign(ownerEnrollmentStartMessage(ownerStart, { ...f.cfg, origin }));
  const admission = await f.request("/v1/admin/owner-enrollment-capabilities", { method: "POST", headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": "budget-admin" }, body: JSON.stringify({ start: ownerStart }) });
  expect(admission.status,await admission.clone().text()).toBe(200);
  const { capability } = await admission.json() as { capability: string };
  const started = await f.request("/v1/auth/owner-attempts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${capability}` }, body: JSON.stringify(ownerStart) });
   expect(started.status, await started.clone().text()).toBe(200);
  const ownerPage = await f.request(`/auth/owner/start?attempt_id=${ownerStart.attemptId}&start_code=${ownerStart.browserStartCode}`);
  expect(ownerPage.status, await ownerPage.clone().text()).toBe(200);
  const ownerPromoted = await f.post("/auth/owner/start", cookie(ownerPage), fields(await ownerPage.text()));
  expect(ownerPromoted.status, await ownerPromoted.clone().text()).toBe(303);
  const ownerBinder = cookie(ownerPromoted), ownerUrl = f.provider.authorize(ownerPromoted.headers.get("location") ?? "");
  const ownerVerified = await measured("owner-callback", () => f.request(ownerUrl.href, { headers: { cookie: ownerBinder } }, createConfiguredCloudflareCoordinatorWorker()), 200);
  expect(await ownerVerified.text()).toContain("/auth/owner/confirm");
  const ownerReplay = await f.request(ownerUrl.href, { headers: { cookie: ownerBinder } });
  expect(ownerReplay.status).toBe(403);
 }
  expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(45);
  expect(counts).toEqual(authority === "device_claim"
   ? { create: 28, callback: 44, finalize: 35, "redemption-page": 13, redemption: 32 }
   : { create: 37, callback: 40, finalize: 38, "redemption-page": 9, redemption: 28, "owner-callback": 33 });
});
