import { expect, vi } from "vitest";
import { type CoordinatorRequestVerifier, createCoordinatorApp } from "./coordinator-api.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export const LIFT_NOW = "2026-11-17T12:00:00.000Z";
export const liftTables = [
	"groups",
	"enrolled_devices",
	"coordinator_invites",
	"coordinator_bootstrap_grants",
	"coordinator_device_removals",
	"coordinator_device_revocations",
	"coordinator_scope_memberships",
	"coordinator_scope_membership_effect_receipts",
	"coordinator_scope_membership_audit_log",
	"request_nonces",
];
const snapshot = (f: RevocationFixture) => Promise.all(liftTables.map((t) => f.rows(t)));
const encoder = new TextEncoder();
const ADMIN = "disposable-lift-test-admin";

async function signingKey() {
	const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("privateKey" in keys)) throw new Error("Missing fixture keypair");
	const wire = new Uint8Array(51);
	new DataView(wire.buffer).setUint32(0, 11);
	wire.set(encoder.encode("ssh-ed25519"), 4);
	new DataView(wire.buffer).setUint32(15, 32);
	wire.set(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)), 19);
	const publicKey = `ssh-ed25519 ${btoa(String.fromCharCode(...wire))}`;
	return { privateKey: keys.privateKey, publicKey, fingerprint: fingerprintPublicKey(publicKey) };
}

async function api(f: RevocationFixture, verifier: CoordinatorRequestVerifier) {
	// The actual verifier uses Date.now independently of the injected route clock.
	vi.spyOn(Date, "now").mockReturnValue(Date.parse(LIFT_NOW));
	vi.spyOn(f.store, "close").mockResolvedValue();
	const verify = vi.fn(verifier);
	const app = createCoordinatorApp({
		storeFactory: () => f.store,
		runtime: { adminSecret: () => ADMIN, now: () => LIFT_NOW },
		requestVerifier: verify,
	});
	const post = (path: string, body: unknown) =>
		app.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Codemem-Coordinator-Admin": ADMIN },
			body: JSON.stringify(body),
		});
	return { app, post, verify };
}

type Kind = "team_member" | "add_device";
type Scenario =
	| "eligible"
	| "unsigned"
	| "wrong key"
	| "wrong device header"
	| "tampered token"
	| "expired signature"
	| "stale token"
	| "permanent block"
	| "other own key";

async function enrollAliases(f: RevocationFixture, key: Awaited<ReturnType<typeof signingKey>>) {
	const otherGroup = `${f.input.groupId}-other`;
	const aliasGroup = `${f.input.groupId}-alias`;
	await f.store.createGroup(otherGroup);
	await f.store.createGroup(aliasGroup);
	const aliases = [
		{ groupId: f.input.groupId, deviceId: f.input.deviceId, publicKey: key.publicKey },
		{ groupId: otherGroup, deviceId: f.input.deviceId, publicKey: key.publicKey },
		{
			groupId: aliasGroup,
			deviceId: `${f.input.deviceId}-alias`,
			publicKey: `${key.publicKey} synthetic-alias`,
		},
	];
	for (const alias of aliases) {
		await f.store.enrollDevice(alias.groupId, {
			...alias,
			fingerprint: fingerprintPublicKey(alias.publicKey),
		});
		const scopeId = `${alias.groupId}-scope`;
		await f.store.createScope({ scopeId, label: "Retained scope", groupId: alias.groupId });
		await f.store.grantScopeMembership({
			effectId: `${scopeId}-grant`,
			scopeId,
			deviceId: alias.deviceId,
		});
	}
}

async function issueLiftInvitation(
	f: RevocationFixture,
	kind: Kind,
	post: Awaited<ReturnType<typeof api>>["post"],
) {
	if (kind === "add_device") return recipientInvite(f, kind);
	await f.store.createGroup(f.input.groupId);
	const reviewedIntent = {
		version: 1,
		journey: "team",
		team: { teamId: "policy-team", displayName: "Team", futureProjectsInherit: true },
		projects: [],
		excludedProjects: [],
	};
	const response = await post("/v1/admin/invites", {
		group_id: f.input.groupId,
		expires_at: "2099-01-01T00:00:00Z",
		invite_kind: "team_member",
		policy_team_id: "policy-team",
		reviewed_preview_digest: await recipientReviewedIntentDigest(reviewedIntent),
		reviewed_intent: reviewedIntent,
	});
	expect(response.status).toBe(200);
	const { invite, payload } = (await response.json()) as {
		invite: { invite_id: string; inviter_device_id: string | null; assigned_identity_id: string };
		payload: { token: string };
	};
	expect(invite.inviter_device_id).toBeNull();
	return { invite, input: { token: payload.token, identityId: invite.assigned_identity_id } };
}

async function arrange(
	f: RevocationFixture,
	kind: Kind,
	scenario: Scenario,
	verifier: CoordinatorRequestVerifier,
) {
	const key = await signingKey();
	Object.assign(f.input, { publicKey: key.publicKey, fingerprint: key.fingerprint });
	const a = await api(f, verifier);
	const stale = await issueLiftInvitation(f, kind, a.post);
	await enrollAliases(f, key);
	const preview = await a.post("/v1/admin/devices/removal-preview", {
		device_ids: [f.input.deviceId],
	});
	expect(preview.status).toBe(200);
	const reviewed = (await preview.json()) as { expected_digest: string };
	const removal = await a.post("/v1/admin/devices/removal", {
		device_ids: [f.input.deviceId],
		expected_digest: reviewed.expected_digest,
	});
	expect(removal.status).toBe(200);
	expect(await f.rows("coordinator_device_removals")).toHaveLength(3);
	expect(await f.rows("coordinator_scope_memberships")).toMatchObject([
		{ status: "revoked" },
		{ status: "revoked" },
		{ status: "revoked" },
	]);
	// A fresh invitation must carry the removal high-water mark, unlike stale.
	const fresh = await issueLiftInvitation(f, kind, a.post);
	if (kind === "team_member") {
		// Keep the Identity fixed so its conflict check cannot mask the stale-token fence.
		await f.exec(
			"UPDATE coordinator_invites SET assigned_identity_id = ? WHERE invite_id = ?",
			fresh.input.identityId,
			stale.invite.invite_id,
		);
		stale.input.identityId = fresh.input.identityId;
	}
	const invitation = scenario === "stale token" ? stale : fresh;
	if (scenario === "permanent block") {
		expect(
			await f.store.createDeviceRevocation({ ...f.input, evidenceKind: "removal_tombstone" }),
		).toMatchObject({ kind: "revoked" });
	}
	const body = {
		token: invitation.input.token,
		invite_kind: kind,
		identity_id: invitation.input.identityId,
		device_id: f.input.deviceId,
		public_key: key.publicKey,
		fingerprint: key.fingerprint,
	};
	let signer = key;
	if (scenario === "wrong key" || scenario === "other own key") signer = await signingKey();
	if (scenario === "other own key") {
		body.public_key = signer.publicKey;
		body.fingerprint = signer.fingerprint;
	}
	return { ...a, body, signer, fresh, stale };
}

async function signedJoin(a: Awaited<ReturnType<typeof arrange>>, scenario: Scenario) {
	const raw = JSON.stringify(a.body);
	if (scenario === "unsigned")
		return a.app.request("/v1/join", {
			method: "POST",
			body: raw,
			headers: { "Content-Type": "application/json" },
		});
	const timestamp = String(
		Math.floor(Date.parse(LIFT_NOW) / 1000) - (scenario === "expired signature" ? 3600 : 0),
	);
	const nonce = crypto.randomUUID();
	const signedRaw =
		scenario === "tampered token" ? JSON.stringify({ ...a.body, token: a.stale.input.token }) : raw;
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(signedRaw)));
	const canonical = encoder.encode(
		[
			"POST",
			"/v1/join",
			timestamp,
			nonce,
			Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
		].join("\n"),
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign("Ed25519", a.signer.privateKey, canonical),
	);
	return a.app.request("/v1/join", {
		method: "POST",
		body: raw,
		headers: {
			"Content-Type": "application/json",
			"X-Opencode-Device":
				scenario === "wrong device header" ? "different-device" : a.body.device_id,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": nonce,
			"X-Opencode-Signature": `v2:${btoa(String.fromCharCode(...signature))}`,
		},
	});
}

export function registerInvitationLiftContract(
	test: ReturnType<typeof revocationHarness>,
	verifier: CoordinatorRequestVerifier,
) {
	for (const kind of ["team_member", "add_device"] as const) {
		registerSuccess(test, kind, verifier);
		registerDenials(test, kind, verifier);
	}
	test("a zero-row enrollment after lifting rolls back the invitation and every tombstone", async ({
		fixture: f,
	}) => {
		const a = await arrange(f, "team_member", "eligible", verifier);
		const before = await snapshot(f);
		// Reaching this trigger requires a lift inside the same transaction.
		await f.exec(`CREATE TRIGGER fixture_ignore_lift_enrollment BEFORE INSERT ON enrolled_devices
			WHEN EXISTS (SELECT 1 FROM coordinator_device_removals t
			 WHERE t.device_id = NEW.device_id AND t.lifted_by_invite_id IS NOT NULL)
			BEGIN SELECT RAISE(IGNORE); END`);
		try {
			const response = await signedJoin(a, "eligible");
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "device_removed" });
			expect(await snapshot(f)).toEqual(before);
		} finally {
			await f.exec("DROP TRIGGER fixture_ignore_lift_enrollment");
		}
	});
	test("a fresh signed invite from a disabled inviter cannot lift a removal", async ({
		fixture: f,
	}) => {
		const a = await arrange(f, "add_device", "eligible", verifier);
		const inviter = a.fresh.invite.inviter_device_id;
		if (!inviter) throw new Error("Missing fixture inviter");
		await f.store.setDeviceEnabled(f.input.groupId, inviter, false);
		const before = await snapshot(f);
		const response = await signedJoin(a, "eligible");
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "device_removed" });
		expect(await snapshot(f)).toEqual(before);
	});
}

function registerSuccess(
	test: ReturnType<typeof revocationHarness>,
	kind: Kind,
	verifier: CoordinatorRequestVerifier,
) {
	test(`${kind} fresh signed acceptance lifts all key aliases and enrolls only the target group`, async ({
		fixture: f,
	}) => {
		const a = await arrange(f, kind, "eligible", verifier);
		const beforeScopes = await f.rows("coordinator_scope_memberships");
		const beforeAudit = await f.rows("coordinator_scope_membership_audit_log");
		const response = await signedJoin(a, "eligible");
		expect(a.verify).toHaveBeenCalled();
		expect(await a.verify.mock.results.at(-1)?.value).toBe(true);
		const body = await response.json();
		expect(response.status, JSON.stringify(body)).toBe(200);
		expect(body).toMatchObject({ ok: true, status: "accepted" });
		const removals = await f.rows("coordinator_device_removals");
		expect(removals).toHaveLength(3);
		expect(removals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					lifted_at: LIFT_NOW,
					lifted_by_invite_id: a.fresh.invite.invite_id,
				}),
			]),
		);
		for (const row of removals)
			expect(row).toMatchObject({
				lifted_at: LIFT_NOW,
				lifted_by_invite_id: a.fresh.invite.invite_id,
			});
		const enrollments = (await f.rows("enrolled_devices")) as { device_id: string }[];
		expect(
			enrollments.filter((row) => row.device_id !== a.fresh.invite.inviter_device_id),
		).toMatchObject([{ group_id: f.input.groupId, device_id: f.input.deviceId, enabled: 1 }]);
		expect(await f.rows("coordinator_scope_memberships")).toEqual(beforeScopes);
		expect(await f.rows("coordinator_scope_membership_audit_log")).toEqual(beforeAudit);
		expect(await f.rows("request_nonces")).toEqual([]);
		const after = await snapshot(f);
		const retry = await signedJoin(a, "eligible");
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({ ok: true, status: "existing" });
		expect(await snapshot(f)).toEqual(after);
		// A token issued before removal stays stale even after another invitation lifts it.
		a.body.token = a.stale.input.token;
		a.body.identity_id = a.stale.input.identityId;
		const stale = await signedJoin(a, "eligible");
		expect(stale.status).toBe(403);
		expect(await stale.json()).toEqual({ error: "device_removed" });
		expect(await snapshot(f)).toEqual(after);
	});
}

function registerDenials(
	test: ReturnType<typeof revocationHarness>,
	kind: Kind,
	verifier: CoordinatorRequestVerifier,
) {
	for (const scenario of [
		"unsigned",
		"wrong key",
		"wrong device header",
		"tampered token",
		"expired signature",
		"stale token",
		"permanent block",
		"other own key",
	] as const) {
		test(`${kind} ${scenario} denies without consuming or changing retained state`, async ({
			fixture: f,
		}) => {
			const a = await arrange(f, kind, scenario, verifier);
			const before = await snapshot(f);
			const response = await signedJoin(a, scenario);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: scenario === "permanent block" ? "device_revoked" : "device_removed",
			});
			expect(await snapshot(f)).toEqual(before);
		});
	}
}
