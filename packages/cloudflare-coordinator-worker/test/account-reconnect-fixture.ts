import { expect } from 'vitest';
import { connectionSessionFixture } from './account-connection-session-fixture.js';
import { config,hash,input } from './account-change-fixture.js';
import { AuthLinkOperations,type AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import type { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import type { CoordinatorAuthLinkSigner,CoordinatorAuthLinkCreateInput,CoordinatorAuthLinkFinalizeInput } from '../../core/src/coordinator-auth-link-contract.js';

export async function reconnectFixture(store: D1CoordinatorStore,backend: AuthLinkBackend,authority: 'device_claim' | 'controller_attestation' = 'device_claim',beforeConnectionInstall?: () => Promise<void>) {
	const f = await connectionSessionFixture(store,backend,authority,beforeConnectionInstall);
	const links = new AuthLinkOperations(backend,() => f.clock.now);
	function request(n: number,signer = input.signer,kind = authority): CoordinatorAuthLinkCreateInput {
		return {attemptId:`relink-${n}`,authority:kind === 'device_claim' ? {kind,identityId:input.identityId} : {kind},signer,expectedIdentityId:input.identityId,runtimeVerifierHash:hash(3000+n*10),browserStartHash:hash(3001+n*10),loopbackRedirect:f.request().loopbackRedirect};
	}
	async function confirmed(n: number,subject = 'account-A',signer = input.signer,kind = authority) {
		const startRequest = request(n,signer,kind);
		const created = await links.createAuthLinkAttempt(startRequest,config);
		expect(['created','existing']).toContain(created.kind);
		const start = {purpose:'link' as const,attemptId:startRequest.attemptId,browserStartHash:startRequest.browserStartHash,stateHash:hash(3002+n*10),binderHash:hash(3003+n*10),nonce:'n'.repeat(43),pkceVerifier:'p'.repeat(43)};
		expect(await f.browser.startAuthBrowserTransaction(start,f.bc)).toMatchObject({kind:'started'});
		const consumed = await f.browser.consumeAuthBrowserTransaction(start,f.bc);
		if (consumed.kind !== 'consumed') throw new Error('relink callback not consumed');
		const pins = {attemptId:startRequest.attemptId,browserTransactionHash:consumed.browserTransactionHash};
		expect(await links.recordAuthLinkOidcVerified({...pins,account:{issuer:config.issuer,subject},profile:{displayName:subject}},config)).toMatchObject({kind:'applied'});
		expect(await links.confirmAuthLinkAttempt({...pins,completionSecretHash:hash(3004+n*10)},config)).toMatchObject({kind:'applied'});
		const proof: CoordinatorAuthLinkFinalizeInput = {purpose:'coordinator-account-link-v1',coordinatorId:config.coordinatorId,...pins,groupId:signer.groupId,identityId:input.identityId,deviceId:signer.deviceId,fingerprint:signer.fingerprint,runtimeVerifierHash:startRequest.runtimeVerifierHash,completionSecretHash:hash(3004+n*10),signer};
		return {proof,pins,startRequest,binderHash:start.binderHash};
	}
	async function disconnect(n: number,subject = 'account-A',signer: CoordinatorAuthLinkSigner = input.signer) {
		expect(await f.operations.create({...f.request(n),signer},config)).toBe(true);
		expect(await f.operations.claimBrowser(f.materials(n),config)).toBe(true);
		expect(await f.operations.consumeCallback(f.materials(n),config)).not.toBeNull();
		expect(await f.operations.recordVerifiedCallback({...f.verified(n),subject},config)).toBe(true);
		expect(await f.operations.confirmDisconnect({...f.materials(n),completionSecretHash:f.proof(n).completionSecretHash},config)).toBe(true);
		const result = await f.operations.finalize({...f.proof(n),signer},config);
		if (!result) throw new Error('disconnect did not complete');
		return result;
	}
	return {...f,links,linkRequest:request,confirmed,disconnect};
}
