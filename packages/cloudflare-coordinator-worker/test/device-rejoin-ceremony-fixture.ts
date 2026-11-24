import { generateKeyPairSync } from "node:crypto";
import { expect } from "vitest";
import { confirmationScope } from "../../core/src/coordinator-device-rejoin-confirmation-test-harness.js";
import {
	type RejoinEvidenceFixture,
	seedGenesis,
} from "../../core/src/coordinator-device-rejoin-link-evidence-test-harness.js";
import { ed25519KeyId } from "../../core/src/coordinator-ed25519-key-id.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import * as linkProof from "./device-claim-eligibility-fixture.js";

export const now = confirmationScope.now;
export const origin = new URL(PROVIDER.redirectUri).origin;
export const config = {
	enabled: true,
	coordinatorId: confirmationScope.coordinatorId,
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	revision: confirmationScope.authConfigRevision,
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};
export const deviceId = "removed";
export const groupId = "group-a";

export function generateDeviceKey() {
	const pair = generateKeyPairSync("ed25519");
	const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return { privateKey: pair.privateKey, publicKey, fingerprint: fingerprintPublicKey(publicKey) };
}

export async function seedRemovedDevice(
	backend: Omit<RejoinEvidenceFixture, "proof">,
	key: { publicKey: string; fingerprint: string },
) {
	await seedGenesis({
		...backend,
		proof: {
			...linkProof,
			controllerLinkEvidenceSql: (pins) =>
				linkProof
					.controllerLinkEvidenceSql(pins)
					.replaceAll(confirmationScope.issuer, config.issuer),
		},
	});
	const keyId = await ed25519KeyId(key.publicKey);
	if (!keyId) throw new Error("Invalid fixture key");
	await backend.run("INSERT INTO groups(group_id,created_at) VALUES (?,'then')", groupId);
	await backend.run(
		`INSERT INTO coordinator_device_ownership_bindings
		 (device_id,key_id,coordinator_id,identity_id,binding_id,provenance,source_ref,bound_at)
		 VALUES (?,?,?,'identity-a','binding-a','owner_enrollment','fixture','then')`,
		deviceId,
		keyId,
		config.coordinatorId,
	);
	await backend.run(
		`INSERT INTO coordinator_device_removals
		 (removal_id,group_id,device_id,public_key,fingerprint,key_id,identity_id,removed_at)
		 VALUES ('removal-a',?,?,?,?,?,'identity-a','then')`,
		groupId,
		deviceId,
		key.publicKey,
		key.fingerprint,
		keyId,
	);
	return keyId;
}

export function createRejoinOidc() {
	const oidc = oidcFixture({ issuer: config.issuer });
	oidc.claims.sub = "private-subject";
	return oidc;
}

type RequestRoute = (url: string, init?: RequestInit) => Response | Promise<Response>;
type Browser = { request: RequestRoute; oidc: ReturnType<typeof createRejoinOidc> };
const cookie = (r: Response) => r.headers.getSetCookie()[0]?.split(";")[0] ?? "";
const field = (html: string, name: string) =>
	new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

function postBrowser(
	request: RequestRoute,
	path: string,
	binder: string,
	fields: Record<string, string>,
) {
	return request(`${origin}${path}`, {
		method: "POST",
		headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});
}

export async function confirmInBrowser({ request, oidc }: Browser, link: string) {
	const start = await request(link);
	expect(start.status).toBe(200);
	const startPage = await start.text();
	const attemptId = field(startPage, "attempt_id");
	const begin = await postBrowser(request, "/auth/rejoin/start", cookie(start), {
		attempt_id: attemptId,
		csrf: field(startPage, "csrf"),
		start_code: field(startPage, "start_code"),
	});
	expect(begin.status).toBe(200);
	const google = /content="0;url=([^"]+)"/.exec(await begin.text())?.[1]?.replaceAll("&amp;", "&");
	if (!google) throw new Error("Missing synthetic Google redirect");
	const review = await request(oidc.authorize(google).href, { headers: { cookie: cookie(begin) } });
	expect(review.status).toBe(200);
	const page = await review.text();
	expect(page).toContain(groupId);
	const confirmation = field(page, "confirmation_hash");
	const complete = await postBrowser(request, "/auth/rejoin/confirm", cookie(begin), {
		attempt_id: attemptId,
		csrf: field(page, "csrf"),
		confirmation_hash: confirmation,
	});
	expect(complete.status).toBe(200);
	const href = /href="(http:\/\/127\.0\.0\.1:[^"]+)"/
		.exec(await complete.text())?.[1]
		?.replaceAll("&amp;", "&");
	if (!href) throw new Error("Missing literal loopback");
	const returned = new URL(href);
	expect(returned.searchParams.get("attempt_id")).toBe(attemptId);
	expect(returned.searchParams.get("confirmation")).toBe(confirmation);
	expect(returned.searchParams.get("completion")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
	return returned;
}
