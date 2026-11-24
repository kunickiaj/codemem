import { sign } from "node:crypto";
import { expect } from "vitest";
import { hashCoordinatorAuthProofBytes32 } from "../../core/src/coordinator-auth-proof.js";
import {
	type DeviceRejoinProof,
	deviceRejoinProofMessage,
} from "../../core/src/coordinator-device-rejoin-proof.js";
import { ed25519KeyId } from "../../core/src/coordinator-ed25519-key-id.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import {
	config,
	confirmInBrowser,
	type createRejoinOidc,
	deviceId,
	generateDeviceKey,
	now,
	origin,
} from "./device-rejoin-ceremony-fixture.js";

export type PlainClaimFixture = {
	key: ReturnType<typeof generateDeviceKey>;
	oidc: ReturnType<typeof createRejoinOidc>;
	request(url: string, init?: RequestInit): Response | Promise<Response>;
	run(sql: string, ...values: (string | number | null)[]): Promise<unknown>;
	rows(sql: string): Promise<Record<string, unknown>[]>;
};

const groups = ["group-a", "group-b"] as const;
const identityId = "identity-a";
const root = "/v1/auth/rejoin-attempts";
const attemptId = "plain-claim-rejoin";
const loopbackRedirect = "http://127.0.0.1:1234/codemem/auth/complete";
const cookie = (response: Response) =>
	response.headers
		.getSetCookie()
		.find((value) => !value.includes("Max-Age=0"))
		?.split(";")[0] ?? "";

function fields(html: string, action: string) {
	const form = new RegExp(`<form[^>]+action="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(html)?.[1];
	if (!form) throw new Error(`Missing fixture form: ${action}`);
	return Object.fromEntries(
		[...form.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((match) => [match[1], match[2]]),
	);
}

function post(f: PlainClaimFixture, path: string, body: object) {
	return f.request(`${origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function signed(f: PlainClaimFixture, path: string, value: object) {
	const body = JSON.stringify(value);
	const timestamp = String(Math.floor(now / 1000));
	const nonce = crypto.randomUUID();
	const signature = sign(
		null,
		buildCanonicalRequest("POST", path, timestamp, nonce, Buffer.from(body)),
		f.key.privateKey,
	).toString("base64");
	return f.request(`${origin}${path}`, {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"x-opencode-device": deviceId,
			"x-opencode-timestamp": timestamp,
			"x-opencode-nonce": nonce,
			"x-opencode-signature": `${SIGNATURE_VERSION}:${signature}`,
		},
	});
}

function browserPost(f: PlainClaimFixture, path: string, binder: string, html: string) {
	return f.request(`${origin}${path}`, {
		method: "POST",
		headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields(html, path)).toString(),
	});
}

async function expectStatus(response: Response, status: number) {
	expect(response.status, await response.clone().text()).toBe(status);
	return response;
}

function rejoinSignature(f: PlainClaimFixture, proof: DeviceRejoinProof) {
	return sign(null, Buffer.from(deviceRejoinProofMessage(proof)), f.key.privateKey).toString(
		"base64url",
	);
}

async function claimThroughGoogle(f: PlainClaimFixture) {
	const start = new Uint8Array(32).fill(21);
	const runtime = new Uint8Array(32).fill(22);
	const path = "/v1/auth/link-attempts";
	await expectStatus(
		await signed(f, path, {
			group_id: groups[0],
			identity_id: identityId,
			authority: "device_claim",
			attempt_id: "plain-claim",
			runtime_verifier_hash: await hashCoordinatorAuthProofBytes32(runtime),
			browser_start_hash: await hashCoordinatorAuthProofBytes32(start),
			loopback_redirect: loopbackRedirect,
		}),
		201,
	);
	const completion = await confirmClaimBrowser(f, start);
	await expectStatus(
		await signed(f, `${path}/plain-claim/finalize`, {
			purpose: "coordinator-account-link-v1",
			coordinator_id: config.coordinatorId,
			identity_id: identityId,
			attempt_id: "plain-claim",
			group_id: groups[0],
			device_id: deviceId,
			fingerprint: f.key.fingerprint,
			runtime_verifier: Buffer.from(runtime).toString("base64url"),
			completion,
		}),
		200,
	);
	expect(await f.rows("SELECT authority_kind FROM coordinator_auth_account_links")).toEqual([
		{ authority_kind: "device_claim" },
	]);
}

async function confirmClaimBrowser(f: PlainClaimFixture, start: Uint8Array) {
	const page = await expectStatus(
		await f.request(
			`${origin}/auth/link/start?attempt_id=plain-claim&start_code=${Buffer.from(start).toString("base64url")}`,
		),
		200,
	);
	const promoted = await expectStatus(
		await browserPost(f, "/auth/link/start", cookie(page), await page.text()),
		200,
	);
	const binder = cookie(promoted);
	const google = /href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/
		.exec(await promoted.text())?.[1]
		?.replaceAll("&amp;", "&");
	if (!google) throw new Error("Missing synthetic Google claim redirect");
	const review = await expectStatus(
		await f.request(f.oidc.authorize(google).href, { headers: { cookie: binder } }),
		200,
	);
	const confirmed = await expectStatus(
		await browserPost(f, "/auth/link/confirm", binder, await review.text()),
		200,
	);
	const loopback = /href="(http:\/\/127\.0\.0\.1:[^"]+)"/
		.exec(await confirmed.text())?.[1]
		?.replaceAll("&amp;", "&");
	if (!loopback) throw new Error("Missing claim loopback");
	return new URL(loopback).searchParams.get("completion");
}

async function seedTwoGroupRemovals(f: PlainClaimFixture, keyId: string) {
	for (const group of [...groups, "alias-only"]) {
		await f.run("INSERT INTO groups(group_id,created_at) VALUES (?,'then')", group);
	}
	await f.run(
		`INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,created_at)
		 VALUES ('group-a',?,?,?,'then')`,
		deviceId,
		f.key.publicKey,
		f.key.fingerprint,
	);
	await claimThroughGoogle(f);
	// Historical removals span two groups. The alias has the same key but no ownership binding.
	for (const [group, device] of [
		["group-a", deviceId],
		["group-b", deviceId],
		["alias-only", "alias-device"],
	] as const) {
		await f.run(
			`INSERT INTO coordinator_device_removals
			 (removal_id,group_id,device_id,public_key,fingerprint,key_id,identity_id,removed_at)
			 VALUES (?,?,?,?,?,?,?,'then')`,
			`removal-${group}`,
			group,
			device,
			f.key.publicKey,
			f.key.fingerprint,
			keyId,
			identityId,
		);
	}
	await f.run("DELETE FROM enrolled_devices");
	const qualificationTable = await f.rows(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='coordinator_owner_enrollment_qualifications'",
	);
	if (qualificationTable.length > 0)
		expect(await f.rows("SELECT * FROM coordinator_owner_enrollment_qualifications")).toEqual([]);
	expect(await f.rows("SELECT * FROM coordinator_auth_controller_attestations")).toEqual([]);
	expect(await f.rows("SELECT * FROM coordinator_identity_group_grants")).toEqual([]);
}

export async function exercisePlainClaimRejoin(f: PlainClaimFixture) {
	const keyId = await ed25519KeyId(f.key.publicKey);
	if (!keyId) throw new Error("Invalid fixture key");
	await seedTwoGroupRemovals(f, keyId);
	await seedUnrelatedRemoval(f);
	const bindings = await f.rows("SELECT * FROM coordinator_device_ownership_bindings");
	expect(bindings).toHaveLength(1);
	const bindingId = bindings[0]?.binding_id;
	const removals = await f.rows(
		"SELECT removal_seq FROM coordinator_device_removals WHERE device_id IN ('removed','alias-device') ORDER BY removal_seq",
	);
	const { pins, subject, link } = await beginRejoin(f, keyId);
	expect(pins).toMatchObject({ identity_id: identityId, binding_id: bindingId });
	const returned = await confirmInBrowser({ ...f, expectedGroups: groups }, link);
	await expectConfirmed(f, subject);
	const completion = returned.searchParams.get("completion") ?? "";
	const finalize = {
		device_id: deviceId,
		completion,
		signature: rejoinSignature(f, {
			...subject,
			operation: "finalize",
			coordinatorId: config.coordinatorId,
			authConfigRevision: config.revision,
			issuer: config.issuer,
			identityId,
			bindingId: pins.binding_id,
			removalDigest: pins.removal_digest,
			publicKey: f.key.publicKey,
			fingerprint: f.key.fingerprint,
			confirmation: returned.searchParams.get("confirmation") ?? "",
			completion,
		}),
	};
	const finalized = await expectStatus(
		await post(f, `${root}/${attemptId}/finalize`, finalize),
		200,
	);
	const result = (await finalized.json()) as { state: string; receipt: object };
	expect(result).toMatchObject({
		state: "finalized",
		receipt: {
			attempt_id: attemptId,
			device_id: deviceId,
			identity_id: identityId,
			binding_id: bindingId,
			group_ids: groups,
			lifted_removal_seqs: removals.map((row) => row.removal_seq),
			finalized_at_ms: now,
		},
	});
	const retry = await expectStatus(await post(f, `${root}/${attemptId}/finalize`, finalize), 200);
	expect(await retry.json()).toEqual({ state: "prior_commit", receipt: result.receipt });
	await expectExactEffects(f, bindings, removals);
}

async function beginRejoin(f: PlainClaimFixture, keyId: string) {
	const start = new Uint8Array(32).fill(23);
	const browserStartHash = await hashCoordinatorAuthProofBytes32(start);
	const subject = { origin, deviceId, keyId, attemptId };
	const started = await expectStatus(
		await post(f, root, {
			device_id: deviceId,
			public_key: f.key.publicKey,
			attempt_id: attemptId,
			browser_start_hash: browserStartHash,
			loopback_redirect: loopbackRedirect,
			timestamp_ms: now,
			signature: rejoinSignature(f, {
				...subject,
				operation: "start",
				publicKey: f.key.publicKey,
				browserStartHash,
				loopbackRedirect,
				timestampMs: now,
			}),
		}),
		200,
	);
	const pins = (await started.json()) as {
		identity_id: string;
		binding_id: string;
		removal_digest: string;
	};
	const link = `${origin}/auth/rejoin/start?attempt_id=${attemptId}&start_code=${Buffer.from(start).toString("base64url")}`;
	return { pins, subject, link };
}

async function expectConfirmed(
	f: PlainClaimFixture,
	subject: Awaited<ReturnType<typeof beginRejoin>>["subject"],
) {
	const poll = await expectStatus(
		await post(f, `${root}/${attemptId}/status`, {
			device_id: deviceId,
			timestamp_ms: now,
			signature: rejoinSignature(f, {
				...subject,
				operation: "status",
				timestampMs: now,
			}),
		}),
		200,
	);
	expect(await poll.json()).toMatchObject({
		state: "confirmed",
		confirmation_view: {
			destinations: [
				["group-a", null],
				["group-b", null],
			],
			non_destinations: [],
		},
	});
	expect(
		await f.rows("SELECT link_authority_kind FROM coordinator_device_rejoin_attempts"),
	).toEqual([{ link_authority_kind: "device_claim" }]);
}

async function expectExactEffects(
	f: PlainClaimFixture,
	bindings: Record<string, unknown>[],
	removals: Record<string, unknown>[],
) {
	expect(
		await f.rows(
			"SELECT group_id,device_id,identity_id,public_key,fingerprint,enabled FROM enrolled_devices ORDER BY group_id",
		),
	).toEqual(
		groups.map((group_id) => ({
			group_id,
			device_id: deviceId,
			identity_id: identityId,
			public_key: f.key.publicKey,
			fingerprint: f.key.fingerprint,
			enabled: 1,
		})),
	);
	expect(
		await f.rows(
			"SELECT removal_seq FROM coordinator_device_removals WHERE lifted_at IS NOT NULL AND lifted_by_attempt_id='plain-claim-rejoin' ORDER BY removal_seq",
		),
	).toEqual(removals);
	expect(await f.rows("SELECT * FROM coordinator_device_ownership_bindings")).toEqual(bindings);
	expect(
		await f.rows(
			"SELECT attempt_id,identity_id,device_id,binding_id,group_count FROM coordinator_device_rejoin_audit_log",
		),
	).toEqual([
		{
			attempt_id: attemptId,
			identity_id: identityId,
			device_id: deviceId,
			binding_id: bindings[0]?.binding_id,
			group_count: 2,
		},
	]);
	expect(
		await f.rows(
			"SELECT device_id,lifted_at,lifted_by_attempt_id FROM coordinator_device_removals WHERE lifted_at IS NULL",
		),
	).toEqual([{ device_id: "unrelated-device", lifted_at: null, lifted_by_attempt_id: null }]);
	expect(await f.rows("SELECT * FROM coordinator_scope_memberships")).toEqual([]);
	expect(await f.rows("SELECT * FROM coordinator_identity_group_grants")).toEqual([]);
}

async function seedUnrelatedRemoval(f: PlainClaimFixture) {
	const key = generateDeviceKey();
	const keyId = await ed25519KeyId(key.publicKey);
	if (!keyId) throw new Error("Invalid unrelated fixture key");
	await f.run(
		`INSERT INTO coordinator_device_removals
		 (removal_id,group_id,device_id,public_key,fingerprint,key_id,identity_id,removed_at)
		 VALUES ('unrelated-removal','group-a','unrelated-device',?,?,?,'other-identity','then')`,
		key.publicKey,
		key.fingerprint,
		keyId,
	);
	expect(await f.rows("SELECT * FROM coordinator_scope_memberships")).toEqual([]);
}
