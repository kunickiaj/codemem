import { describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import { shareProjectSetDigest } from "./project-share-intent.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const NOW = "2026-10-06T00:00:00.000Z";
const EXPIRES_AT = "2026-10-07T00:00:00.000Z";
const ADMIN_SECRET = "disposable-test-credential";
const PROJECT = {
	canonical_identity: "https://git.example.invalid/fixture/project.git",
	display_name: "Fixture project",
	existing_memory_count: 3,
};
const OPERATION_ID = `share_${"b".repeat(40)}`;

function createApiFixture() {
	const store = new BetterSqliteCoordinatorStore(":memory:");
	const close = vi.spyOn(store, "close").mockResolvedValue();
	const input = revocationInput();
	input.fingerprint = fingerprintPublicKey(input.publicKey);
	const seed = {
		deviceId: "fixture-seed",
		publicKey: UNRELATED_PUBLIC_KEY,
		fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
	};
	const verifier = vi.fn(async () => ({ ok: false, error: "invalid_signature" }) as const);
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => ADMIN_SECRET, now: () => NOW },
		requestVerifier: verifier,
	});
	return { store, close, input, seed, verifier, app };
}

const test = it.extend<{ fixture: ReturnType<typeof createApiFixture> }>({
	fixture: async ({ task: _task }, use) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		const f = createApiFixture();
		try {
			await f.store.createGroup(f.input.groupId);
			await f.store.enrollDevice(f.input.groupId, f.seed);
			await use(f);
		} finally {
			f.close.mockRestore();
			await f.store.close();
			vi.useRealTimers();
		}
	},
});
type ApiFixture = ReturnType<typeof createApiFixture>;

async function revokeAndRemove(f: ApiFixture) {
	await f.store.enrollDevice(f.input.groupId, f.input);
	const result = await f.store.createDeviceRevocation(f.input);
	expect(result.kind).toBe("revoked");
	expect(await f.store.removeDevice(f.input.groupId, f.input.deviceId)).toBe(true);
	expect(f.store.db.prepare("SELECT * FROM coordinator_device_revocations").all()).toHaveLength(2);
}

function rows(f: ApiFixture, table: string) {
	return f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function enrollmentSnapshot(f: ApiFixture) {
	return {
		enrollments: rows(f, "enrolled_devices"),
		revocations: rows(f, "coordinator_device_revocations"),
	};
}

function post(f: ApiFixture, path: string, body: Record<string, unknown>) {
	return f.app.request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Codemem-Coordinator-Admin": ADMIN_SECRET,
		},
		body: JSON.stringify(body),
	});
}

function joinBody(f: ApiFixture, token: string) {
	return {
		token,
		device_id: f.input.deviceId,
		public_key: f.input.publicKey,
		fingerprint: f.input.fingerprint,
	};
}

describe("SQLite enrollment API revocation rollback", () => {
	for (const scenario of ["ordinary", "revoked"] as const) {
		test(`join-request approval ${scenario}: enrollment and bootstrap grant are atomic`, async ({
			fixture: f,
		}) => {
			// Arrange: request a grant from an enrolled, unrelated seed to exercise the full approval.
			const request = await f.store.createJoinRequest({ ...f.input, token: "fixture-token" });
			if (scenario === "revoked") await revokeAndRemove(f);
			const before = enrollmentSnapshot(f);
			const requestsBefore = rows(f, "coordinator_join_requests");
			// Act
			const response = await post(f, "/v1/admin/join-requests/approve", {
				request_id: request.request_id,
				reviewed_by: f.input.actorId,
				bootstrap_grant_seed_device_id: f.seed.deviceId,
				bootstrap_grant_expires_at: EXPIRES_AT,
			});
			// Assert: rejected enrollment cannot approve the pending request or mint a grant.
			expect(f.verifier).not.toHaveBeenCalled();
			if (scenario === "revoked") {
				expect(response.status).toBe(403);
				expect(await response.json()).toEqual({ error: "device_revoked" });
				expect(enrollmentSnapshot(f)).toEqual(before);
				expect(rows(f, "coordinator_join_requests")).toEqual(requestsBefore);
				expect(await f.store.listJoinRequests(f.input.groupId)).toEqual([request]);
				expect(rows(f, "coordinator_bootstrap_grants")).toEqual([]);
				return;
			}
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ ok: true, request: { status: "approved" } });
			expect(await f.store.getEnrollment(f.input.groupId, f.input.deviceId)).not.toBeNull();
			expect(rows(f, "coordinator_bootstrap_grants")).toHaveLength(1);
		});

		test(`project invite acceptance ${scenario}: consumption and binding roll back on revocation`, async ({
			fixture: f,
		}) => {
			// Arrange: a genuine project invite updates its binding before guarded enrollment.
			const invite = await f.store.createInvite({
				groupId: f.input.groupId,
				policy: "auto_admit",
				expiresAt: EXPIRES_AT,
				operationId: OPERATION_ID,
				reviewedProjectSetDigest: shareProjectSetDigest([
					{
						canonicalIdentity: PROJECT.canonical_identity,
						displayName: PROJECT.display_name,
						identitySource: "git_remote",
						existingMemoryCount: PROJECT.existing_memory_count,
					},
				]),
				inviterDeviceId: f.seed.deviceId,
				projectIntent: [PROJECT],
			});
			if (scenario === "revoked") await revokeAndRemove(f);
			const before = enrollmentSnapshot(f);
			const invitesBefore = rows(f, "coordinator_invites");
			// Act
			const response = await post(f, "/v1/join", {
				...joinBody(f, invite.token),
				operation_id: OPERATION_ID,
				recipient_actor_id: "fixture-recipient",
				recipient_display_name: "Fixture recipient",
				device_display_name: "Fixture laptop",
			});
			// Assert: compare all invite columns, including token, consumption and recipient binding.
			expect(f.verifier).not.toHaveBeenCalled();
			if (scenario === "revoked") {
				expect(response.status).toBe(403);
				expect(await response.json()).toEqual({ error: "device_revoked" });
				expect(enrollmentSnapshot(f)).toEqual(before);
				expect(rows(f, "coordinator_invites")).toEqual(invitesBefore);
				expect(await f.store.getInviteByTokenForInspection(invite.token)).toMatchObject({
					consumed_at: null,
					bound_device_id: null,
					bound_public_key: null,
					bound_fingerprint: null,
					recipient_actor_id: null,
				});
				expect(rows(f, "coordinator_bootstrap_grants")).toEqual([]);
				return;
			}
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ ok: true, status: "pending_setup" });
			expect(await f.store.getEnrollment(f.input.groupId, f.input.deviceId)).toMatchObject({
				identity_id: "fixture-recipient",
			});
			expect(await f.store.getInviteByTokenForInspection(invite.token)).toMatchObject({
				bound_device_id: f.input.deviceId,
				consumed_at: NOW,
			});
			expect(rows(f, "coordinator_bootstrap_grants")).toHaveLength(1);
		});

		test(`legacy auto-admit join ${scenario}: removed devices cannot bypass revocation`, async ({
			fixture: f,
		}) => {
			// Arrange: removal avoids the legacy already-enrolled short circuit.
			const invite = await f.store.createInvite({
				groupId: f.input.groupId,
				policy: "auto_admit",
				expiresAt: EXPIRES_AT,
			});
			if (scenario === "revoked") await revokeAndRemove(f);
			const before = enrollmentSnapshot(f);
			const invitesBefore = rows(f, "coordinator_invites");
			// Act
			const response = await post(f, "/v1/join", joinBody(f, invite.token));
			// Assert
			expect(f.verifier).not.toHaveBeenCalled();
			expect(rows(f, "coordinator_invites")).toEqual(invitesBefore);
			if (scenario === "revoked") {
				expect(response.status).toBe(403);
				expect(await response.json()).toEqual({ error: "device_revoked" });
				expect(enrollmentSnapshot(f)).toEqual(before);
				return;
			}
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				ok: true,
				status: "enrolled",
				group_id: f.input.groupId,
				policy: "auto_admit",
			});
			expect(await f.store.getEnrollment(f.input.groupId, f.input.deviceId)).not.toBeNull();
		});
	}
});
