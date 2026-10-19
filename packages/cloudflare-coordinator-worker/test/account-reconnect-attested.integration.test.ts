import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { expect,it } from 'vitest';
import { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import { reconnectFixture } from './account-reconnect-fixture.js';
import { config,input,hash,NOW } from './account-change-fixture.js';
import { otherKey } from './device-claim-eligibility-fixture.js';

it('native D1 reconnects with a current attestation independent of its revoked origin and preserves an archived retry',async () => {
	const db = (env as unknown as {COORDINATOR_DB:D1Database}).COORDINATOR_DB;
	const backend: AuthLinkBackend = {first: ({sql,values}) => db.prepare(sql).bind(...values).first(),run:async ({sql,values}) => (await db.prepare(sql).bind(...values).run()).meta.changes,batch:async (statements) => (await db.batch(statements.map(({sql,values}) => db.prepare(sql).bind(...values)))).map((r) => r.meta.changes)};
	const store = new D1CoordinatorStore(db,{authClock:() => NOW}),f = await reconnectFixture(store,backend,'controller_attestation');
	expect(await f.operations.create(f.request(90,'refresh'),config)).toBe(true);
	await f.disconnect(1);
	// Rekey the original device under a fresh review. The unused fixture peer
	// held this example key under another Identity and must not mask a conflict.
	await store.removeDevice(input.signer.groupId,'unrelated-device');
	const signer = {...input.signer,publicKey:otherKey,fingerprint:'b'.repeat(64)};
	await f.exec('UPDATE enrolled_devices SET public_key = ?,fingerprint = ? WHERE device_id = ?',signer.publicKey,signer.fingerprint,signer.deviceId);
	expect(await store.createAuthControllerAttestation({coordinatorId:config.coordinatorId,identityId:input.identityId,...signer,attestationId:'current',reviewReceiptId:'current-review',evidenceDigest:hash(7000)})).toMatchObject({kind:'created'});
	await f.exec("UPDATE coordinator_auth_controller_attestations SET revoked_at='now' WHERE attestation_id='controller'");
	const a = await f.confirmed(1,'account-B',signer,'controller_attestation');
	expect(await f.links.createAuthLinkAttempt(f.linkRequest(2,signer,'controller_attestation'),config)).toEqual({kind:'rejected',error:'attempt_limited'});
	expect(await f.links.finalizeAuthLinkAttempt(a.proof,config)).toMatchObject({kind:'applied'});
	expect(await f.sessions.redeemAuthLinkSessionWithBrowserTransaction({...a.pins,binderHash:a.binderHash,credentialHash:hash(4000)},f.bc)).toMatchObject({kind:'issued'});
	expect(await f.status.readAccountLinkStatus(signer,config,{identityId:input.identityId})).toMatchObject({state:'linked',account:{displayName:'account-B'}});
	await f.disconnect(2,'account-B',signer);
	expect(await f.links.finalizeAuthLinkAttempt(a.proof,config)).toMatchObject({kind:'existing'});
	expect((await db.prepare('SELECT * FROM coordinator_auth_device_claims').all()).results).toEqual([]);
});
