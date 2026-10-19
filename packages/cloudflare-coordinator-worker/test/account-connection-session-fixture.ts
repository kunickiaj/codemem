import { expect } from 'vitest';
import { CoordinatorAuthBrowserTransactions } from '../../core/src/coordinator-auth-browser-transaction.js';
import { AuthSessionOperations } from '../../core/src/coordinator-auth-session.js';
import { AuthAccountProfileOperations } from '../../core/src/coordinator-auth-account-profile.js';
import { AccountLinkStatusOperations } from '../../core/src/coordinator-account-link-status.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';
import type { D1CoordinatorStore } from '../../core/src/d1-coordinator-store.js';
import { changeFixture,config,hash } from './account-change-fixture.js';

export async function connectionSessionFixture(store: D1CoordinatorStore, backend: AuthLinkBackend, authority: 'device_claim' | 'controller_attestation' = 'device_claim', beforeConnectionInstall?: () => Promise<void>) {
	const f = await changeFixture(store,backend,authority,beforeConnectionInstall);
	const browser = new CoordinatorAuthBrowserTransactions(backend,() => f.clock.now);
	const sessions = new AuthSessionOperations(backend,() => f.clock.now);
	const profiles = new AuthAccountProfileOperations(backend,() => f.clock.now);
	const status = new AccountLinkStatusOperations(backend,() => f.clock.now);
	const bc = { ...config,redirectUri: 'https://coordinator.example.test/auth/callback' };
	async function consumed(n: number, c = bc) {
		const materials = { purpose: 'signin' as const,stateHash: hash(500+n*2),binderHash: hash(501+n*2),nonce: 'n'.repeat(43),pkceVerifier: 'p'.repeat(43) };
		expect(await browser.startAuthBrowserTransaction(materials,c)).toMatchObject({ kind: 'started' });
		const proof = await browser.consumeAuthBrowserTransaction(materials,c);
		if (proof.kind !== 'consumed') throw new Error('browser fixture not consumed');
		return { browserTransactionHash: proof.browserTransactionHash,credentialHash: hash(600+n),account: { issuer: c.issuer,subject: 'account-A' } };
	}
	async function signin(n: number, c = bc) {
		const proof = await consumed(n,c);
		expect(await sessions.signInWithConsumedBrowserTransaction(proof,c)).toMatchObject({ kind: 'issued' });
		return proof;
	}
	return { ...f,browser,sessions,profiles,status,bc,consumed,signin };
}
