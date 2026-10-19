import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { expect,it } from 'vitest';
import { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import { applyAccountConnectionSchema,readConnectionSchemaState,ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,CoordinatorAuthSchemaUpgradeRequiredError } from '../../core/src/coordinator-account-connection-schema.js';
import { AUTH_SCHEMA_READINESS_SQL } from '../../core/src/coordinator-auth-schema.js';
import { changeFixture,config,hash,NOW } from './account-change-fixture.js';

it('native D1 installs the explicit additive batch, preserves legacy proof/session rows and rejects a fake guard',async()=>{
	const db=(env as unknown as {COORDINATOR_DB:D1Database}).COORDINATOR_DB;
	const backend:AuthLinkBackend={first:({sql,values})=>db.prepare(sql).bind(...values).first(),run:async({sql,values})=>(await db.prepare(sql).bind(...values).run()).meta.changes,batch:async(statements)=>(await db.batch(statements.map(({sql,values})=>db.prepare(sql).bind(...values)))).map(r=>r.meta.changes)};
	const store=new D1CoordinatorStore(db,{authClock:()=>NOW});
	let claims:unknown,session:unknown;
	const f=await changeFixture(store,backend,'device_claim',async()=>{
		expect(await readConnectionSchemaState(backend)).toBe('v2');
		await expect(store.getAccountChanges()).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
		claims=(await db.prepare('SELECT * FROM coordinator_auth_device_claims').all()).results;
		session=await store.readAuthSession(hash(906),config);
		const faulty:AuthLinkBackend={...backend,batch:statements=>backend.batch([...statements.slice(0,-1),{sql:'INSERT INTO coordinator_auth_account_connection_orders DEFAULT VALUES',values:[]},...statements.slice(-1)])};
		await expect(applyAccountConnectionSchema(faulty)).rejects.toThrow();
		expect(await readConnectionSchemaState(backend)).toBe('v2');
		expect((await db.prepare("SELECT name FROM sqlite_master WHERE name='coordinator_auth_account_connection_history'").all()).results).toEqual([]);
	});
	expect(await readConnectionSchemaState(backend)).toBe('ready');
	await store.assertAuthSchemaReady();
	expect(await db.prepare(AUTH_SCHEMA_READINESS_SQL).first()).toEqual({ready:9});
	expect((await db.prepare('SELECT * FROM coordinator_auth_device_claims').all()).results).toEqual(claims);
	expect(await store.readAuthSession(hash(906),config)).toEqual(session);
	expect(await db.prepare('SELECT last_order FROM coordinator_auth_account_connection_orders').first()).toEqual({last_order:1});
	const ops=await store.getAccountChanges();
	expect(await ops.create(f.request(1,'refresh'),config)).toBe(true);
	expect(await ops.claimBrowser(f.materials(),config)).toBe(true);
	expect(await db.prepare('SELECT browser_order FROM coordinator_account_change_attempts').first()).toEqual({browser_order:2});
	await expect(applyAccountConnectionSchema(backend)).rejects.toThrow('already_installed');
	await db.prepare('DROP TRIGGER account_connection_claim_history').run();
	await db.prepare('CREATE TRIGGER account_connection_claim_history BEFORE INSERT ON coordinator_auth_device_claims BEGIN SELECT 1; END').run();
	expect(await readConnectionSchemaState(backend)).toBe('upgrade_required');
	await expect(store.getAccountChanges()).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
	// The existing Boolean mutation contract normalizes a denied backend batch.
	expect(await ops.cancel(f.request(),config)).toBe(false);
	expect(await db.prepare('SELECT state FROM coordinator_account_change_attempts').first()).toEqual({state:'browser_pending'});
	await expect(store.signOutAuthSession(hash(906),config)).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
	expect(ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.length).toBeGreaterThan(1);
});
