// The completion checks of a historical revocation run natively in its one D1 batch. A
// trigger that silently keeps a session live must make the session check refuse it.
import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { expect,it,vi } from 'vitest';
import { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import { historicalRevokeFixture,config } from './account-historical-revoke-fixture.js';
import { NOW } from './account-change-fixture.js';

it('native historical revoke refuses the whole batch when a live session stays unrevoked',async()=>{
	vi.spyOn(Date,'now').mockReturnValue(NOW);vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('live network forbidden'));
	const db=(env as unknown as {COORDINATOR_DB:D1Database}).COORDINATOR_DB;
	const backend:AuthLinkBackend={first:({sql,values})=>db.prepare(sql).bind(...values).first(),run:async({sql,values})=>(await db.prepare(sql).bind(...values).run()).meta.changes,batch:async(statements)=>(await db.batch(statements.map(({sql,values})=>db.prepare(sql).bind(...values)))).map(r=>r.meta.changes)};
	const f=await historicalRevokeFixture(new D1CoordinatorStore(db,{authClock:()=>NOW}),backend);
	// A live session of the Identity, and a trigger that silently keeps it live.
	await db.prepare(`INSERT INTO coordinator_auth_sessions (coordinator_id,session_id,credential_hash,browser_transaction_hash,link_id,identity_id,issuer,subject,auth_config_revision,created_at_ms,expires_at_ms,revoked_at_ms)
		SELECT coordinator_id,'native-live-session',?,?,link_id,identity_id,issuer,subject,auth_config_revision,created_at_ms,created_at_ms+28800000,NULL FROM coordinator_auth_account_links WHERE link_id=?`).bind('e'.repeat(64),'f'.repeat(64),f.b).run();
	await db.prepare('CREATE TRIGGER fixture_keep_session_live BEFORE UPDATE OF revoked_at_ms ON coordinator_auth_sessions BEGIN SELECT RAISE(IGNORE); END').run();
	const rows=async(table:string)=>(await db.prepare(`SELECT * FROM ${table}`).all()).results;
	const tables=['coordinator_auth_account_links','coordinator_auth_account_connection_history','coordinator_auth_link_audit_log','coordinator_auth_sessions'];
	const before=await Promise.all(tables.map(rows));
	try {
		// Act, Assert: the session check refuses the batch natively; no other effect survives.
		await expect(f.sessions.revokeAuthAccountLink({linkId:f.a},config)).rejects.toThrow(/auth_session_persistence_error/);
		expect(await Promise.all(tables.map(rows))).toEqual(before);
	} finally {
		await db.prepare('DROP TRIGGER fixture_keep_session_live').run();
	}
});
