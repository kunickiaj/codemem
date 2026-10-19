import { expect } from 'vitest';
import type { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import { AuthSessionOperations } from '../../core/src/coordinator-auth-session.js';
import { applyAccountConnectionSchema } from '../../core/src/coordinator-account-connection-schema.js';
import { input,hash,NOW } from './account-change-fixture.js';

type Store=Pick<D1CoordinatorStore,'createGroup'|'enrollDevice'|'createAuthControllerAttestation'|'issueIdentityGroupGrantFromControllerAttestation'|'createAuthLinkAttempt'|'startAuthBrowserTransaction'|'consumeAuthBrowserTransaction'|'recordAuthLinkOidcVerified'|'confirmAuthLinkAttempt'|'finalizeAuthLinkAttempt'|'redeemAuthLinkSessionWithBrowserTransaction'|'getAccountChanges'>;
export const config={enabled:true,coordinatorId:'coordinator-a',issuer:'https://accounts.google.com',revision:'a'.repeat(64),redirectUri:'https://app.example.test/auth/callback'};
export async function historicalRevokeFixture(store:Store,backend:AuthLinkBackend,authority:'controller_attestation'|'device_claim'='controller_attestation') {
	const clock={now:NOW};
	await store.createGroup(input.signer.groupId);await store.enrollDevice(input.signer.groupId,input.signer);
	if(authority==='controller_attestation') {
		for(const groupId of [input.signer.groupId,'group-b']) {
			if(groupId!==input.signer.groupId){await store.createGroup(groupId);await store.enrollDevice(groupId,input.signer);}
			const attestationId=`review-${groupId}`;
			expect(await store.createAuthControllerAttestation({coordinatorId:config.coordinatorId,identityId:input.identityId,...input.signer,groupId,attestationId,reviewReceiptId:`receipt-${groupId}`,evidenceDigest:hash(990)})).toMatchObject({kind:'created'});
			// Real operator-issued grants precede, and do not depend on, either link birth.
			expect(await store.issueIdentityGroupGrantFromControllerAttestation({coordinatorId:config.coordinatorId,attestationId})).toMatchObject({kind:'created'});
		}
	}
	async function link(n:number,subject:string) {
		const attemptId=`link-${n}`,request={attemptId,authority:authority==='device_claim'?{kind:authority,identityId:input.identityId}:{kind:authority},signer:input.signer,expectedIdentityId:input.identityId,runtimeVerifierHash:hash(1000+n*10),browserStartHash:hash(1001+n*10),loopbackRedirect:'http://127.0.0.1:43210/codemem/auth/complete'};
		expect(await store.createAuthLinkAttempt(request,config)).toMatchObject({kind:'created'});
		const start={purpose:'link' as const,attemptId,browserStartHash:request.browserStartHash,stateHash:hash(1002+n*10),binderHash:hash(1003+n*10),nonce:'n'.repeat(43),pkceVerifier:'p'.repeat(43)};
		expect(await store.startAuthBrowserTransaction(start,config)).toMatchObject({kind:'started'});
		const consumed=await store.consumeAuthBrowserTransaction(start,config);
		if(consumed.kind!=='consumed')throw new Error('link fixture not consumed');
		const pins={attemptId,browserTransactionHash:consumed.browserTransactionHash};
		expect(await store.recordAuthLinkOidcVerified({...pins,account:{issuer:config.issuer,subject}},config)).toMatchObject({kind:'applied'});
		expect(await store.confirmAuthLinkAttempt({...pins,completionSecretHash:hash(1004+n*10)},config)).toMatchObject({kind:'applied'});
		expect(await store.finalizeAuthLinkAttempt({...request,purpose:'coordinator-account-link-v1',coordinatorId:config.coordinatorId,groupId:input.signer.groupId,identityId:input.identityId,deviceId:input.signer.deviceId,fingerprint:input.signer.fingerprint,completionSecretHash:hash(1004+n*10)},config)).toMatchObject({kind:'applied'});
		const row=await backend.first<{link_id:string}>({sql:'SELECT link_id FROM coordinator_auth_account_links WHERE coordinator_id=? AND identity_id=?',values:[config.coordinatorId,input.identityId]});
		if(!row)throw new Error('missing born link');
		return row.link_id;
	}
	const a=await link(1,'account-A');
	await applyAccountConnectionSchema(backend);
	const operations=await store.getAccountChanges();
	async function unlink(n:number,subject:string) {
		const attemptId=`end-${n}`,base={attemptId,intent:'disconnect',signer:input.signer,expectedIdentityId:input.identityId,runtimeVerifierHash:hash(2000+n*10),browserStartHash:hash(2001+n*10),loopbackRedirect:'http://127.0.0.1:43210/codemem/auth/complete'};
		expect(await operations.create(base,config)).toBe(true);
		const browser={attemptId,browserStartHash:base.browserStartHash,stateHash:hash(2002+n*10),binderHash:hash(2003+n*10),nonce:'n'.repeat(43),pkceVerifier:'p'.repeat(43)};
		expect(await operations.claimBrowser(browser,config)).toBe(true);
		expect(await operations.consumeCallback(browser,config)).not.toBeNull();
		expect(await operations.recordVerifiedCallback({...browser,issuer:config.issuer,subject,profile:{},completionSecretHash:hash(2004+n*10)},config)).toBe(true);
		expect(await operations.confirmDisconnect({...browser,completionSecretHash:hash(2004+n*10)},config)).toBe(true);
		expect(await operations.finalize({...base,completionSecretHash:hash(2004+n*10)},config)).not.toBeNull();
	}
	await unlink(1,'account-A');const b=await link(2,'account-B');
	return {a,b,link,unlink,clock,backend,sessions:new AuthSessionOperations(backend,()=>clock.now)};
}
