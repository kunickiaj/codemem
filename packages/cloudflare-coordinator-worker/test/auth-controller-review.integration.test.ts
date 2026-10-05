import { env } from "cloudflare:workers";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import { AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL, authControllerRetryEligibleValues } from "../../core/src/coordinator-auth-controller.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";
const NOW = 1791028800000;
const PATH = "/v1/admin/auth-controller-reviews";
const secret = "fixture-admin-secret";
type Fixture = Awaited<ReturnType<typeof setup>>;
const fixtures: Fixture[] = [];
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(async () => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	for (const f of fixtures.splice(0)) {
		await env.COORDINATOR_DB.batch([
			...["link_audit_log", "link_attempts", "controller_attestations"].map((table) => env.COORDINATOR_DB.prepare(`DELETE FROM coordinator_auth_${table} WHERE coordinator_id = ?`).bind(f.config.coordinatorId)),
			env.COORDINATOR_DB.prepare("DELETE FROM request_nonces WHERE device_id = ?").bind(f.deviceId),
			env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(f.input.group_id),
			env.COORDINATOR_DB.prepare("DELETE FROM coordinator_invites WHERE group_id = ?").bind(f.input.group_id),
			env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(f.input.group_id),
		]);
	}
});
async function setup() {
	const { publicKey: pub, privateKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(pub.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(4 + kind.length + 4 + raw.length);
	wire.writeUInt32BE(kind.length, 0); kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length); raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const deviceId = randomUUID();
	const config = { enabled: true, coordinatorId: randomUUID(), issuer: "https://accounts.example.test", revision: "a".repeat(64), redirectUri: "https://coordinator.example.test/auth/callback" };
	const input = { group_id: randomUUID(), device_id: deviceId, identity_id: randomUUID(), fingerprint: fingerprintPublicKey(publicKey) };
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	await store.createGroup(input.group_id);
	await store.enrollDevice(input.group_id, { deviceId, publicKey, fingerprint: input.fingerprint });
	const app = createCoordinatorApp({ storeFactory: () => store, requestVerifier: verifyCloudflareCoordinatorRequest, runtime: { adminSecret: () => secret, now: () => new Date(NOW).toISOString() }, authLink: { config, storeFactory: () => store } });
	const f = { store, input, config, app, publicKey, privateKey, deviceId };
	fixtures.push(f);
	return f;
}
function review(f: Fixture, digest?: string) {
	return f.app.request(PATH, { method: "POST", headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": secret }, body: JSON.stringify({ ...f.input, ...(digest ? { confirm_evidence_digest: digest } : {}) }) });
}
function signedLink(f: Fixture) {
	const path = "/v1/auth/link-attempts";
	const body = JSON.stringify({ group_id: f.input.group_id, attempt_id: randomUUID(), runtime_verifier_hash: "c".repeat(64), browser_start_hash: "d".repeat(64), loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete" });
	const timestamp = String(NOW / 1000);
	const nonce = randomUUID();
	const signature = sign(null, buildCanonicalRequest("POST", path, timestamp, nonce, Buffer.from(body)), f.privateKey);
	return f.app.request(path, { method: "POST", body, headers: { "content-type": "application/json", "X-Opencode-Device": f.deviceId, "X-Opencode-Timestamp": timestamp, "X-Opencode-Nonce": nonce, "X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}` } });
}
async function rows(f: Fixture) {
	return (await env.COORDINATOR_DB.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?").bind(f.config.coordinatorId).all()).results;
}
it("real operator preview/commit replaces seeded authority and unlocks a signed device link without changing enrollment", async () => {
	// Arrange: native D1 and ephemeral Ed25519 key, with no preseeded attestation.
	const f = await setup();
	const enrollment = await f.store.getEnrollment(f.input.group_id, f.deviceId);
	// Act
	const denied = await signedLink(f);
	const previewResponse = await review(f);
	const preview = await previewResponse.json<Record<string, string>>();
	const afterPreview = await rows(f);
	const created = await review(f, preview.evidence_digest);
	const afterCreated = await rows(f);
	const replay = await review(f, preview.evidence_digest);
	const allowed = await signedLink(f);
	// Assert
	expect(denied.status).toBe(403);
	expect(previewResponse.status).toBe(200);
	expect(afterPreview).toEqual([]);
	expect(created.status).toBe(201);
	expect(replay.status).toBe(200);
	expect(await rows(f)).toEqual(afterCreated);
	expect(afterCreated).toHaveLength(1);
	expect(afterCreated[0]).toMatchObject({ coordinator_id: f.config.coordinatorId, identity_id: f.input.identity_id, public_key: f.publicKey, fingerprint: f.input.fingerprint, enrollment_identity_id: null });
	expect(allowed.status).toBe(201);
	expect(await f.store.getEnrollment(f.input.group_id, f.deviceId)).toEqual(enrollment);
	const text = JSON.stringify(preview);
	for (const hidden of [secret, f.publicKey, "public_key", "subject", "email", "token"]) expect(text).not.toContain(hidden);
});

async function seedReviewedInvite(f: Fixture) {
	const invite = await f.store.createInvite({ groupId: f.input.group_id, policy: "auto", expiresAt: "2030-01-01T00:00:00Z" });
	await env.COORDINATOR_DB.prepare("UPDATE coordinator_invites SET invite_kind = 'add_device', consumed_at = 'consumed', bound_device_id = ?, bound_public_key = ?, bound_fingerprint = ?, recipient_actor_id = ?, target_identity_id = ?, reviewed_preview_digest = ? WHERE invite_id = ?")
		.bind(f.deviceId, f.publicKey, f.input.fingerprint, f.input.identity_id, f.input.identity_id, "c".repeat(64), invite.invite_id).run();
	return invite.invite_id;
}
it.each([
	"DELETE FROM coordinator_invites WHERE invite_id = ?",
	"UPDATE coordinator_invites SET revoked_at = 'revoked' WHERE invite_id = ?",
	"UPDATE coordinator_invites SET recipient_actor_id = 'changed' WHERE invite_id = ?",
	"UPDATE coordinator_invites SET assigned_identity_id = 'changed' WHERE invite_id = ?",
	"UPDATE coordinator_invites SET target_identity_id = 'changed' WHERE invite_id = ?",
	"UPDATE coordinator_invites SET reviewed_preview_digest = 'changed' WHERE invite_id = ?",
	"UPDATE coordinator_invites SET bound_public_key = 'changed' WHERE invite_id = ?",
])("native D1 rejects evidence mutation after listInvites: %s", async (sql) => {
	const f = await setup();
	const inviteId = await seedReviewedInvite(f);
	const initial = await (await review(f)).json<{ evidence_digest: string }>();
	const list = f.store.listInvites.bind(f.store);
	vi.spyOn(f.store, "listInvites").mockImplementation(async (group) => {
		const result = await list(group);
		await env.COORDINATOR_DB.prepare(sql).bind(inviteId).run();
		return result;
	});
	const response = await review(f, initial.evidence_digest);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await rows(f)).toEqual([]);
});
it.each([false, true])("native D1 rejects a new invite after an empty snapshot, replay=%s", async (replay) => {
	const f = await setup();
	const initial = await (await review(f)).json<{ evidence_digest: string }>();
	if (replay) expect((await review(f, initial.evidence_digest)).status).toBe(201);
	const before = await rows(f);
	const create = f.store.createAuthControllerAttestation.bind(f.store);
	vi.spyOn(f.store, "createAuthControllerAttestation").mockImplementation(async (input) => {
		await seedReviewedInvite(f);
		return create(input);
	});
	const response = await review(f, initial.evidence_digest);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await rows(f)).toEqual(before);
});
it.each([false, true])("native D1 rejects null-to-matching enrollment Identity after listInvites, replay=%s", async (replay) => {
	const f = await setup();
	await seedReviewedInvite(f);
	const initial = await (await review(f)).json<{ evidence_digest: string }>();
	if (replay) expect((await review(f, initial.evidence_digest)).status).toBe(201);
	const before = await rows(f);
	const list = f.store.listInvites.bind(f.store);
	vi.spyOn(f.store, "listInvites").mockImplementation(async (group) => {
		const invites = await list(group);
		await env.COORDINATOR_DB.prepare("UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?")
			.bind(f.input.identity_id, f.input.group_id, f.deviceId).run();
		return invites;
	});
	const response = await review(f, initial.evidence_digest);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await rows(f)).toEqual(before);
});
it("native D1 retry rejects evidence changed after the uniqueness failure", async () => {
	const f = await setup();
	const inviteId = await seedReviewedInvite(f);
	const initial = await (await review(f)).json<{ evidence_digest: string }>();
	expect((await review(f, initial.evidence_digest)).status).toBe(201);
	const before = await rows(f);
	const getActive = f.store.getActiveAuthControllerAttestation.bind(f.store);
	vi.spyOn(f.store, "getActiveAuthControllerAttestation").mockImplementation(async (...args) => {
		const active = await getActive(...args);
		await env.COORDINATOR_DB.prepare("UPDATE coordinator_invites SET revoked_at = 'revoked' WHERE invite_id = ?").bind(inviteId).run();
		return active;
	});
	const response = await review(f, initial.evidence_digest);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await rows(f)).toEqual(before);
});
it("native D1 guards all 201 invitations with fixed SQL binds and a limited response sample", async () => {
	const f = await setup();
	const ids: string[] = [];
	for (let index = 0; index < 201; index++) ids.push(await seedReviewedInvite(f));
	const response = await review(f);
	const wire = await response.text();
	const initial = JSON.parse(wire);
	expect(new TextEncoder().encode(wire).byteLength).toBeLessThan(16384);
	expect(initial.reviewed_invite_count).toBe(201);
	expect(initial.reviewed_invites).toHaveLength(10);
	const hiddenId = ids.find((id) => !initial.reviewed_invites.some((ref: { invite_id: string }) => ref.invite_id === id));
	const create = f.store.createAuthControllerAttestation.bind(f.store);
	const spy = vi.spyOn(f.store, "createAuthControllerAttestation").mockImplementation(async (input) => {
		await env.COORDINATOR_DB.prepare("UPDATE coordinator_invites SET reviewed_preview_digest = ? WHERE invite_id = ?").bind("d".repeat(64), hiddenId).run();
		return create(input);
	});
	const stale = await review(f, initial.evidence_digest);
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "review_stale" });
	expect(await rows(f)).toEqual([]);
	spy.mockRestore();
	const fresh = await (await review(f)).json<{ evidence_digest: string }>();
	vi.spyOn(f.store, "createAuthControllerAttestation").mockImplementation(async (input) => {
		const eligible = await env.COORDINATOR_DB.prepare(AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL)
			.bind(...authControllerRetryEligibleValues(input)).all();
		expect(eligible.results).toEqual([{ eligible: 1 }]);
		// A generous linear scan budget, not a machine-dependent timing limit.
		expect(eligible.meta.rows_read).toBeGreaterThan(0);
		expect(eligible.meta.rows_read).toBeLessThan(201 * 20 + 100);
		return create(input);
	});
	expect((await review(f, fresh.evidence_digest)).status).toBe(201);
	expect((await review(f, fresh.evidence_digest)).status).toBe(200);
});
