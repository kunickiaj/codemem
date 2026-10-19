import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { expect,it } from 'vitest';
import { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import { reconnectFixture } from './account-reconnect-fixture.js';
import { config,hash,NOW } from './account-change-fixture.js';

it('native relink reports quota and collision while revoked requester remains unavailable',async()=>{
 const db=(env as unknown as {COORDINATOR_DB:D1Database}).COORDINATOR_DB;
 const backend:AuthLinkBackend={first:({sql,values})=>db.prepare(sql).bind(...values).first(),run:async({sql,values})=>(await db.prepare(sql).bind(...values).run()).meta.changes,batch:async(statements)=>(await db.batch(statements.map(({sql,values})=>db.prepare(sql).bind(...values)))).map(r=>r.meta.changes)};
 const f=await reconnectFixture(new D1CoordinatorStore(db,{authClock:()=>NOW}),backend);
 expect(await f.operations.create(f.request(90,'refresh'),config)).toBe(true);
 await f.disconnect(1);
 expect(await f.links.createAuthLinkAttempt(f.linkRequest(1),config)).toMatchObject({kind:'created'});
 expect(await f.links.createAuthLinkAttempt(f.linkRequest(2),config)).toEqual({kind:'rejected',error:'attempt_limited'});
 expect(await f.operations.cancel(f.request(90,'refresh'),config)).toBe(true);
 expect(await f.links.createAuthLinkAttempt(f.linkRequest(2),config)).toMatchObject({kind:'created'});
 expect(await f.links.createAuthLinkAttempt(f.linkRequest(3),config)).toEqual({kind:'rejected',error:'attempt_limited'});
 expect(await f.links.createAuthLinkAttempt({...f.linkRequest(1),runtimeVerifierHash:hash(999)},config)).toEqual({kind:'rejected',error:'attempt_conflict'});
 await db.prepare('UPDATE enrolled_devices SET enabled=0').run();
 expect(await f.links.createAuthLinkAttempt(f.linkRequest(3),config)).toEqual({kind:'rejected',error:'attempt_unavailable'});
});
