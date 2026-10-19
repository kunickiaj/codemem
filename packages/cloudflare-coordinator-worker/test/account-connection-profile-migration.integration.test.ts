import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { expect,it } from 'vitest';
import { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import { changeFixture,config,hash,NOW } from './account-change-fixture.js';

it('native D1 retains a migrated sign-in profile without admitting old pending browser proof',async()=>{
 const profile={displayName:'Legacy signin',email:'legacy@example.test',emailVerified:true,pictureUrl:'https://lh3.googleusercontent.com/a/legacy'};
 const db=(env as unknown as {COORDINATOR_DB:D1Database}).COORDINATOR_DB;
 const backend:AuthLinkBackend={first:({sql,values})=>db.prepare(sql).bind(...values).first(),run:async({sql,values})=>(await db.prepare(sql).bind(...values).run()).meta.changes,batch:async(statements)=>(await db.batch(statements.map(({sql,values})=>db.prepare(sql).bind(...values)))).map(r=>r.meta.changes)};
 const store=new D1CoordinatorStore(db,{authClock:()=>NOW});
 const bc={...config,redirectUri:'https://coordinator.example.test/auth/callback'};
 const start={purpose:'signin' as const,stateHash:hash(990),binderHash:hash(991),nonce:'n'.repeat(43),pkceVerifier:'p'.repeat(43)};
 const pending={...start,stateHash:hash(993),binderHash:hash(994)};
 let receipts:unknown;
 await changeFixture(store,backend,'device_claim',async()=>{
  expect((await store.startAuthBrowserTransaction(start,bc)).kind).toBe('started');
  const proof=await store.consumeAuthBrowserTransaction(start,bc);
  if(proof.kind!=='consumed')throw new Error('legacy proof unavailable');
  expect((await store.signInWithConsumedBrowserTransaction({browserTransactionHash:proof.browserTransactionHash,credentialHash:hash(992),account:{issuer:config.issuer,subject:'account-A'}},bc)).kind).toBe('issued');
  expect((await store.recordAuthAccountProfile({credentialHash:hash(992),profile},config)).kind).toBe('recorded');
  expect((await store.readAuthSessionAccount(hash(992),config))?.profile).toEqual(profile);
  receipts=(await db.prepare('SELECT rowid,* FROM coordinator_auth_session_receipts').all()).results;
  expect((await store.startAuthBrowserTransaction(pending,bc)).kind).toBe('started');
 });
 expect((await store.readAuthSessionAccount(hash(992),config))?.profile).toEqual(profile);
 const migrated=(await db.prepare('SELECT rowid,* FROM coordinator_auth_session_receipts').all()).results;
 expect(migrated.map(({source_order,...row})=>row)).toEqual(receipts);
 expect(migrated.filter(r=>r.source==='signin').map(r=>r.source_order)).toEqual([1]);
 expect(migrated.filter(r=>r.source!=='signin').map(r=>r.source_order)).toEqual([null]);
 const old=await store.consumeAuthBrowserTransaction(pending,bc);
 if(old.kind!=='consumed')throw new Error('legacy pending proof unavailable');
 expect((await store.signInWithConsumedBrowserTransaction({browserTransactionHash:old.browserTransactionHash,credentialHash:hash(995),account:{issuer:config.issuer,subject:'account-A'}},bc)).kind).toBe('rejected');
});
