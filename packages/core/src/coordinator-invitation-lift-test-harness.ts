import { expect, vi } from "vitest";
import { type CoordinatorRequestVerifier, createCoordinatorApp } from "./coordinator-api.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export const LIFT_NOW = "2026-11-17T12:00:00.000Z";
export const liftTables = [
	"groups",
	"enrolled_devices",
	"coordinator_invites",
	"coordinator_join_requests",
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
		team: { teamId: `${f.input.groupId}-team`, displayName: "Team", futureProjectsInherit: true },
		projects: [],
		excludedProjects: [],
	};
	const response = await post("/v1/admin/invites", {
		group_id: f.input.groupId,
		expires_at: "2099-01-01T00:00:00Z",
		invite_kind: "team_member",
		policy_team_id: `${f.input.groupId}-team`,
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
	beforeRemoval?: () => Promise<void>,
) {
	const key = await signingKey();
	Object.assign(f.input, { publicKey: key.publicKey, fingerprint: key.fingerprint });
	const a = await api(f, verifier);
	const stale = await issueLiftInvitation(f, kind, a.post);
	await enrollAliases(f, key);
	await beforeRemoval?.();
	await removeAliases(f, a.post);
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

async function removeAliases(f: RevocationFixture, post: Awaited<ReturnType<typeof api>>["post"]) {
	const device_ids = [f.input.deviceId];
	const preview = await post("/v1/admin/devices/removal-preview", { device_ids });
	expect(preview.status).toBe(200);
	const { expected_digest } = (await preview.json()) as { expected_digest: string };
	const removal = await post("/v1/admin/devices/removal", { device_ids, expected_digest });
	expect(removal.status).toBe(200);
	expect(await f.rows("coordinator_device_removals")).toHaveLength(3);
	expect(await f.rows("coordinator_scope_memberships")).toMatchObject([
		{ status: "revoked" },
		{ status: "revoked" },
		{ status: "revoked" },
	]);
}

async function signedJoin(
	a: Pick<Awaited<ReturnType<typeof arrange>>, "app" | "signer" | "stale"> & {
		body: { device_id: string; token: string };
	},
	scenario: Scenario,
) {
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
	registerPreRemovalAuthorityDenials(test, verifier);
	registerPreRemovalRequestDenial(test, verifier);
	registerPreRemovalProjectDenials(test, verifier);
	registerProjectLift(test, verifier);
	registerProjectLiftRollback(test, verifier);
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

async function arrangeProjectLift(f: RevocationFixture, verifier: CoordinatorRequestVerifier) {
	const a = await arrange(f, "team_member", "eligible", verifier);
	const project = await projectInvite(f);
	const { input } = project;
	const body = {
		token: input.token,
		device_id: input.deviceId,
		public_key: input.publicKey,
		fingerprint: input.fingerprint,
		operation_id: input.operationId,
		recipient_actor_id: input.recipientActorId,
		recipient_display_name: input.recipientDisplayName,
		device_display_name: input.deviceDisplayName,
	};
	return { ...a, ...project, body };
}

function registerProjectLift(
	test: ReturnType<typeof revocationHarness>,
	verifier: CoordinatorRequestVerifier,
) {
	test("a fresh signed Project invitation lifts all matching removals and enrolls only in its group", async ({
		fixture: f,
	}) => {
		const a = await arrangeProjectLift(f, verifier);
		const memberships = await f.rows("coordinator_scope_memberships");
		const accepted = await signedJoin(a, "eligible");
		const payload = await accepted.json();
		expect(accepted.status, JSON.stringify(payload)).toBe(200);
		expect(payload).toMatchObject({
			ok: true,
			group_id: f.input.groupId,
			operation_id: a.input.operationId,
			bootstrap_grant_id: expect.any(String),
		});
		expect(await f.rows("coordinator_device_removals")).toMatchObject(
			Array.from({ length: 3 }, () => ({
				lifted_at: LIFT_NOW,
				lifted_by_invite_id: a.invite.invite_id,
			})),
		);
		expect(await f.rows("enrolled_devices")).toMatchObject([
			{ device_id: a.seed.deviceId, group_id: f.input.groupId },
			{ device_id: f.input.deviceId, group_id: f.input.groupId, enabled: 1 },
		]);
		expect(await f.rows("coordinator_scope_memberships")).toEqual(memberships);
		expect(await f.rows("request_nonces")).toEqual([]);
		const after = await snapshot(f);
		expect((await signedJoin(a, "eligible")).status).toBe(200);
		expect(await snapshot(f)).toEqual(after);
	});
	for (const scenario of [
		"unsigned",
		"wrong device header",
		"tampered token",
		"permanent block",
	] as const) {
		test(`a ${scenario} Project join leaves the removed device and invitation unchanged`, async ({
			fixture: f,
		}) => {
			const a = await arrangeProjectLift(f, verifier);
			if (scenario === "permanent block") {
				expect(
					await f.store.createDeviceRevocation({
						...f.input,
						evidenceKind: "removal_tombstone",
					}),
				).toMatchObject({ kind: "revoked" });
			}
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

function registerProjectLiftRollback(
	test: ReturnType<typeof revocationHarness>,
	verifier: CoordinatorRequestVerifier,
) {
	test("Project lift rolls back when the enrollment writes no row", async ({ fixture: f }) => {
		const a = await arrangeProjectLift(f, verifier);
		const before = await snapshot(f);
		await f.exec(`CREATE TRIGGER fixture_ignore_project_enrollment BEFORE INSERT ON enrolled_devices
			WHEN EXISTS (SELECT 1 FROM coordinator_device_removals t
			 WHERE t.device_id = NEW.device_id AND t.lifted_by_invite_id IS NOT NULL)
			BEGIN SELECT RAISE(IGNORE); END`);
		try {
			const response = await signedJoin(a, "eligible");
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "device_removed" });
			expect(await snapshot(f)).toEqual(before);
		} finally {
			await f.exec("DROP TRIGGER fixture_ignore_project_enrollment");
		}
	});
	test("a signed Project retry never lifts a second removal", async ({ fixture: f }) => {
		const a = await arrangeProjectLift(f, verifier);
		expect((await signedJoin(a, "eligible")).status).toBe(200);
		expect(await f.store.removeDevice(f.input.groupId, f.input.deviceId)).toBe(true);
		const before = await snapshot(f);
		const retry = await signedJoin(a, "eligible");
		expect(retry.status).toBe(403);
		expect(await retry.json()).toEqual({ error: "device_removed" });
		expect(await snapshot(f)).toEqual(before);
	});
	test("a fresh signed Project invitation cannot lift while its inviter is disabled", async ({
		fixture: f,
	}) => {
		const a = await arrangeProjectLift(f, verifier);
		await f.store.setDeviceEnabled(a.seed.groupId, a.seed.deviceId, false);
		const before = await snapshot(f);
		const response = await signedJoin(a, "eligible");
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "device_removed" });
		expect(await snapshot(f)).toEqual(before);
	});
}

function registerPreRemovalAuthorityDenials(
	test: ReturnType<typeof revocationHarness>,
	verifier: CoordinatorRequestVerifier,
) {
	for (const policy of ["auto_admit", "approval_required"] as const) {
		test(`a pre-removal ${policy} code cannot grant access to another group after rejoin`, async ({
			fixture: f,
		}) => {
			const groupId = `${f.input.groupId}-other`;
			const issueCode = () =>
				f.store.createInvite({
					groupId,
					policy,
					expiresAt: "2099-01-01T00:00:00Z",
				});
			let token = "";
			const a = await arrange(f, "team_member", "eligible", verifier, async () => {
				token = (await issueCode()).token;
			});
			expect((await signedJoin(a, "eligible")).status).toBe(200);
			const before = await snapshot(f);
			const join = (code: string) =>
				a.post("/v1/join", {
					token: code,
					device_id: f.input.deviceId,
					public_key: f.input.publicKey,
					fingerprint: f.input.fingerprint,
				});
			const stale = await join(token);
			expect(stale.status).toBe(403);
			expect(await stale.json()).toEqual({ error: "device_removed" });
			expect(await snapshot(f)).toEqual(before);
			expect(await f.store.getEnrollment(groupId, f.input.deviceId, true)).toBeNull();
			const fresh = await join((await issueCode()).token);
			expect(fresh.status).toBe(200);
			const freshBody = (await fresh.json()) as { status: string; request_id?: string };
			expect(freshBody).toMatchObject({
				status: policy === "auto_admit" ? "enrolled" : "pending",
			});
			if (freshBody.request_id) {
				const approval = await a.post("/v1/admin/join-requests/approve", {
					request_id: freshBody.request_id,
				});
				expect(approval.status).toBe(200);
			}
			expect(await f.store.getEnrollment(groupId, f.input.deviceId)).not.toBeNull();
		});
	}
}

function registerPreRemovalRequestDenial(
	test: ReturnType<typeof revocationHarness>,
	verifier: CoordinatorRequestVerifier,
) {
	test("a retained join request from before removal cannot be approved after rejoin", async ({
		fixture: f,
	}) => {
		const groupId = `${f.input.groupId}-other`;
		const a = await arrange(f, "team_member", "eligible", verifier);
		expect((await signedJoin(a, "eligible")).status).toBe(200);
		// A request stored by an older coordinator can still be pending after a rejoin.
		await f.exec(
			`INSERT INTO coordinator_join_requests
			(request_id, group_id, device_id, public_key, fingerprint, token, status, created_at, issued_after_removal_seq)
			VALUES ('historical-request', ?, ?, ?, ?, 'historical-code', 'pending', ?, 0)`,
			groupId,
			f.input.deviceId,
			f.input.publicKey,
			f.input.fingerprint,
			LIFT_NOW,
		);
		const before = await snapshot(f);
		const review = await a.post("/v1/admin/join-requests/approve", {
			request_id: "historical-request",
		});
		expect(review.status).toBe(403);
		expect(await review.json()).toEqual({ error: "device_removed" });
		expect(await snapshot(f)).toEqual(before);
	});
}

function registerPreRemovalProjectDenials(
	test: ReturnType<typeof revocationHarness>,
	verifier: CoordinatorRequestVerifier,
) {
	for (const retry of [false, true]) {
		test(`a pre-removal Project invitation cannot ${retry ? "recover a bound grant" : "accept"} after rejoin`, async ({
			fixture: f,
		}) => {
			const groupId = `${f.input.groupId}-other`;
			let project!: Awaited<ReturnType<typeof projectInvite>>;
			const a = await arrange(f, "team_member", "eligible", verifier, async () => {
				project = await projectInvite({ ...f, input: { ...f.input, groupId } });
				if (retry) {
					await f.store.setDeviceEnabled(groupId, project.seed.deviceId, false);
					const accepted = await f.store.consumeProjectInvite(project.input);
					expect(accepted.bootstrap_grant).toBeNull();
					await f.store.setDeviceEnabled(groupId, project.seed.deviceId, true);
				}
			});
			expect((await signedJoin(a, "eligible")).status).toBe(200);
			const before = await snapshot(f);
			await expect(f.store.consumeProjectInvite(project.input)).rejects.toThrow(/^device_removed$/);
			expect(await snapshot(f)).toEqual(before);
		});
	}
	test("a Project invitation predating its inviter's removal stays invalid after the inviter returns", async ({
		fixture: f,
	}) => {
		const { input, seed } = await projectInvite(f);
		expect(await f.store.removeDevice(seed.groupId, seed.deviceId)).toBe(true);
		await f.exec(
			`UPDATE coordinator_device_removals SET lifted_at = ?, lifted_by_attempt_id = 'fixture-rejoin'
			WHERE group_id = ? AND device_id = ?`,
			LIFT_NOW,
			seed.groupId,
			seed.deviceId,
		);
		await f.store.enrollDevice(seed.groupId, seed);
		const before = await snapshot(f);
		await expect(f.store.consumeProjectInvite(input)).rejects.toThrow(/^invite_invalid$/);
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
