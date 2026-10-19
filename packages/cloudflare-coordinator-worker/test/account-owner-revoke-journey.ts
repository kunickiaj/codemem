import { expect } from 'vitest';
import { config } from './account-historical-revoke-fixture.js';
import { issueBrowserCookie } from '../../core/src/coordinator-browser-credential.js';
import { importBrowserCsrfKey,issueBrowserCsrfToken } from '../../core/src/coordinator-browser-csrf.js';
import { oidcFixture,PROVIDER } from '../../core/src/coordinator-oidc-test-fixtures.js';
import { createCoordinatorOwnerEnrollment,ownerEnrollmentStartMessage } from '../../core/src/owner-enrollment-start.js';
import { ownerEnrollmentFinalMessage,type OwnerAttempt } from '../../core/src/coordinator-owner-enrollment-proof.js';
import { COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL } from '../../core/src/coordinator-owner-enrollment-commit.js';
import type { AuthLinkBackend } from '../../core/src/coordinator-auth-link.js';

type Key={publicKey:string;sign(message:string):string|Promise<string>};
// Portable equivalent of the existing native owner fixture key helper, without
// importing its unrelated database-reset and synthetic-history fixtures.
export async function pendingOwnerRevokeKey() {
	const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
	const raw=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)),wire=Buffer.alloc(51);
	wire.writeUInt32BE(11,0);wire.write('ssh-ed25519',4);wire.writeUInt32BE(32,15);raw.copy(wire,19);
	return {publicKey:`ssh-ed25519 ${wire.toString('base64')}`,sign:async(message:string)=>Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(message))).toString('base64url')};
}
export async function ownerRevokeJourney(backend:AuthLinkBackend,key:Key,n:number,clock:{now:number}) {
	await backend.run({sql:COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL,values:[]});
	const origin=new URL(config.redirectUri).origin,cfg={...config,clientId:PROVIDER.clientId,clientSecret:PROVIDER.clientSecret};
	const start={attemptId:`owner-${n}`,deviceId:`pending-owner-${n}`,publicKey:key.publicKey,loopbackRedirect:'http://127.0.0.1:43210/codemem/auth/complete',browserStartCode:Buffer.alloc(32,n).toString('base64url'),signature:''};
	start.signature=await key.sign(ownerEnrollmentStartMessage(start,{...cfg,origin}));
	const csrfKey=await importBrowserCsrfKey(new Uint8Array(32).fill(17)),startCookie=await issueBrowserCookie('start');
	const csrf=await issueBrowserCsrfToken(csrfKey,startCookie.secret,'start',{publicOrigin:origin,store:cfg});
	const provider=oidcFixture({issuer:config.issuer});provider.claims.sub='account-B';provider.userInfo.sub='account-B';
	const composed=await createCoordinatorOwnerEnrollment({purpose:'owner_enroll',mode:'local_test',config:cfg,backend,csrfKey,limiter:{check:()=>({allowed:true,retryAfterS:0})},oidcOptions:{fetch:provider.fetch},clock:()=>clock.now});
	if(!composed.ok)throw new Error('owner fixture composition failed');
	const api=composed.enrollment;
	expect(await api.start(start,`transport-${n}`)).toMatchObject({kind:'started'});
	const form=(action:string,cookie:string,fields:Record<string,string>)=>new Request(`${origin}/auth/owner/${action}`,{method:'POST',headers:{origin,cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
	const claim=await api.claimBrowser(form('start',startCookie.setCookie.split(';')[0]??'',{csrf,attempt_id:start.attemptId,start_code:start.browserStartCode}),`browser-${n}`);
	if(claim.kind!=='browser_claimed')throw new Error('owner fixture claim failed');
	const cookie=claim.setCookies[0]?.split(';')[0];if(!cookie)throw new Error('missing owner cookie');
	const url=provider.authorize(claim.authorizationUrl),callbackRequest=()=>new Request(url,{headers:{cookie}});
	async function verified() {
		const result=await api.verifyCallback(callbackRequest());
		if(result.kind!=='verified')throw new Error(`owner fixture verification failed: ${JSON.stringify(result)}`);
		return {result,request:()=>form('confirm',cookie,{csrf:result.csrf,attempt_id:start.attemptId})};
	}
	async function confirmed(v:Awaited<ReturnType<typeof verified>>) {
		const result=await api.confirm(v.request(),`browser-${n}`,v.result.confirmation.confirmationHash);
		if(result.kind!=='confirmed')throw new Error('owner fixture confirmation failed');
		const row=await backend.first<OwnerAttempt>({sql:'SELECT * FROM coordinator_owner_enrollment_attempts WHERE coordinator_id=? AND attempt_id=?',values:[config.coordinatorId,start.attemptId]});
		if(!row)throw new Error('missing confirmed owner attempt');
		return {attemptId:start.attemptId,completionSecret:result.completionSecret,signature:await key.sign(ownerEnrollmentFinalMessage(row,result.completionSecret))};
	}
	return {api,verified,confirmed,callbackRequest};
}
