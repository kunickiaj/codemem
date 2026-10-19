import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { expect,it,vi } from 'vitest';
import { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import { historicalRevokeFixture,config } from './account-historical-revoke-fixture.js';
import { ownerRevokeJourney,pendingOwnerRevokeKey } from './account-owner-revoke-journey.js';
import { NOW } from './account-change-fixture.js';
import { AuthAccountProfileOperations } from '../../core/src/coordinator-auth-account-profile.js';

it('native historical revoke atomically audits A/B and blocks real owner callback, confirm and winning commit through B',async()=>{
	const clock=vi.spyOn(Date,'now').mockReturnValue(NOW),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('live network forbidden'));
	try {
		const db=(env as unknown as {COORDINATOR_DB:D1Database}).COORDINATOR_DB;
		const backend:AuthLinkBackend={first:({sql,values})=>db.prepare(sql).bind(...values).first(),run:async({sql,values})=>(await db.prepare(sql).bind(...values).run()).meta.changes,batch:async(statements)=>(await db.batch(statements.map(({sql,values})=>db.prepare(sql).bind(...values)))).map(r=>r.meta.changes)};
		const f=await historicalRevokeFixture(new D1CoordinatorStore(db,{authClock:()=>NOW}),backend);
		const rows=async(table:string)=>(await db.prepare(`SELECT * FROM ${table}`).all()).results;
		const ownership=()=>Promise.all(['enrolled_devices','coordinator_device_ownership_bindings','coordinator_identity_group_grants','coordinator_owner_enrollment_audit_log'].map(rows));
		const callback=await ownerRevokeJourney(backend,await pendingOwnerRevokeKey(),1,f.clock);
		const confirm=await ownerRevokeJourney(backend,await pendingOwnerRevokeKey(),2,f.clock),verified=await confirm.verified();
		const commit=await ownerRevokeJourney(backend,await pendingOwnerRevokeKey(),3,f.clock),verifiedCommit=await commit.verified(),completion=await commit.confirmed(verifiedCommit);
		await db.prepare("INSERT INTO coordinator_auth_account_profiles (coordinator_id,link_id,display_name,source_session_id,source_signed_in_at_ms) SELECT coordinator_id,link_id,'Private display','display-session',created_at_ms FROM coordinator_auth_account_links").run();
		await db.prepare("INSERT INTO coordinator_auth_link_profiles (coordinator_id,attempt_id,issuer,subject,auth_config_revision,browser_transaction_hash,link_id,verified_at_ms,display_name) SELECT l.coordinator_id,l.attempt_id,l.issuer,l.subject,l.auth_config_revision,a.browser_transaction_hash,l.link_id,l.created_at_ms,'Private display' FROM coordinator_auth_account_links l JOIN coordinator_auth_link_attempts a ON a.coordinator_id=l.coordinator_id AND a.attempt_id=l.attempt_id").run();
		const before=await ownership();f.clock.now+=50;
		await db.prepare("CREATE TRIGGER fixture_ignore_revoked_audit BEFORE INSERT ON coordinator_auth_link_audit_log WHEN NEW.action='link_revoked' BEGIN SELECT RAISE(IGNORE); END").run();
		await expect(f.sessions.revokeAuthAccountLink({linkId:f.a},config)).rejects.toThrow(/auth_session_persistence_error/);
		expect(await rows('coordinator_auth_account_links')).toMatchObject([{link_id:f.b,revoked_at_ms:null}]);
		expect(await rows('coordinator_auth_account_connection_history')).toMatchObject([{link_id:f.a,revoked_at_ms:null}]);
		expect((await rows('coordinator_auth_link_audit_log')).filter(r=>r.action==='link_revoked')).toEqual([]);
		await db.prepare('DROP TRIGGER fixture_ignore_revoked_audit').run();
		expect(await f.sessions.revokeAuthAccountLink({linkId:f.a},config)).toEqual({kind:'revoked'});
		expect(await rows('coordinator_auth_account_links')).toMatchObject([{link_id:f.b,revoked_at_ms:f.clock.now}]);
		expect((await rows('coordinator_auth_link_audit_log')).filter(r=>r.action==='link_revoked')).toHaveLength(2);
		expect(await callback.api.verifyCallback(callback.callbackRequest())).toMatchObject({kind:'rejected'});
		expect(await confirm.api.confirm(verified.request(),'browser-2',verified.result.confirmation.confirmationHash)).toMatchObject({kind:'rejected'});
		expect(await commit.api.finalize(completion)).toMatchObject({kind:'rejected'});
		expect(await ownership()).toEqual(before);
		const audits=await rows('coordinator_auth_link_audit_log');f.clock.now+=100;
		expect(await f.sessions.revokeAuthAccountLink({linkId:f.a},config)).toEqual({kind:'revoked'});
		expect(await rows('coordinator_auth_link_audit_log')).toEqual(audits);
		const profiles=new AuthAccountProfileOperations(backend,()=>f.clock.now);
		expect(await profiles.clearRevokedAuthAccountProfile({linkId:f.a},config)).toEqual({kind:'cleared',deletedCount:2});
		expect(await rows('coordinator_auth_account_profiles')).toEqual([]);
		expect(await rows('coordinator_auth_link_profiles')).toEqual([]);
		expect(await profiles.clearRevokedAuthAccountProfile({linkId:f.a},config)).toEqual({kind:'cleared',deletedCount:0});
		expect(await rows('coordinator_auth_link_audit_log')).toEqual(audits);
		expect(network).not.toHaveBeenCalled();
	} finally {clock.mockRestore();network.mockRestore();}
});
