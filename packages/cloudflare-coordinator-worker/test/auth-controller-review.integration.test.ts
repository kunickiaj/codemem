import { env } from "cloudflare:workers";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
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
