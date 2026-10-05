import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CoordinatorRequestRateLimitOptions,
	createCoordinatorApp,
} from "./coordinator-api.js";
import { cfg, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	enroll,
	type Fixture,
	review,
	setupStore,
} from "./coordinator-auth-store-test-fixtures.js";

const PATH = "/v1/admin/auth-controller-reviews";
const secret = "fixture-admin-secret";
const input = {
	group_id: "group-a",
	device_id: "device-a",
	identity_id: "identity-a",
	fingerprint: "a".repeat(64),
};
function snapshot(f: Fixture, except: string[] = []) {
	return (
		f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
			name: string;
		}[]
	)
		.filter(({ name }) => !except.includes(name))
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function appFor(
	f: Fixture,
	enabled: boolean | undefined = true,
	configured: string | null = secret,
	requestRateLimit?: CoordinatorRequestRateLimitOptions,
) {
	return createCoordinatorApp({
		storeFactory: () => f.store,
		requestVerifier: async () => false,
		requestRateLimit,
		runtime: { adminSecret: () => configured, now: () => new Date(NOW).toISOString() },
		authLink:
			enabled === undefined
				? undefined
				: {
						config: {
							...cfg,
							enabled,
							redirectUri: "https://coordinator.example.test/auth/callback",
						},
						storeFactory: () => f.store,
					},
	});
}
function request(
	app: ReturnType<typeof appFor>,
	body: unknown = input,
	credential: string | null = secret,
) {
	return app.request(PATH, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-Codemem-Admin-Actor": "identity-a",
			...(credential === null ? {} : { "X-Codemem-Coordinator-Admin": credential }),
			Cookie: "private-cookie",
		},
		body: JSON.stringify(body),
	});
}
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = it.extend<{ f: Fixture }>({
		f: async ({ task: _task }, use) => {
			const f = setupStore(backend, { authClock: () => NOW });
			vi.spyOn(f.store, "close").mockResolvedValue(undefined);
			await enroll(f.store);
			try {
				await use(f);
			} finally {
				f.db.close();
			}
		},
	});
	describe(`${backend} operator controller review`, () => {
		test("preview is read-only and hides keys, credentials, and account fields", async ({ f }) => {
			// Arrange
			const before = snapshot(f);
			// Act
			const response = await request(appFor(f));
			const text = await response.text();
			// Assert
			expect(response.status).toBe(200);
			expect(JSON.parse(text)).toEqual({
				state: "ready",
				reasons: [],
				coordinator_id: cfg.coordinatorId,
				evidence_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				enrollment: {
					device_id: "device-a",
					display_name: null,
					fingerprint: input.fingerprint,
					identity_label: "none",
				},
				reviewed_invites: [],
			});
			expect(text).not.toMatch(
				/fixture-admin-secret|private-cookie|public_key|subject|email|token/,
			);
			expect(text).not.toContain(review().publicKey);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(snapshot(f)).toEqual(before);
		});
		test.for([null, "wrong-secret"])(
			"actor label cannot authorize with credential %s",
			async (credential, { f }) => {
				// Arrange
				const before = snapshot(f);
				// Act
				const response = await request(appFor(f), input, credential);
				// Assert
				expect(response.status).toBe(401);
				expect(snapshot(f)).toEqual(before);
			},
		);
		test.for([false, undefined])(
			"disabled/absent feature %s exposes no route",
			async (enabled, { f }) => {
				// Arrange
				const app =
					enabled === undefined
						? createCoordinatorApp({
								storeFactory: () => f.store,
								requestVerifier: async () => false,
								runtime: { adminSecret: () => secret, now: () => new Date(NOW).toISOString() },
							})
						: appFor(f, enabled);
				// Act
				const response = await request(app);
				// Assert
				expect(response.status).toBe(404);
			},
		);
		test.for(["coordinator_id", "public_key", "evidence_digest"])(
			"rejects caller-owned extra %s",
			async (field, { f }) => {
				// Arrange
				const before = snapshot(f);
				// Act
				const response = await request(appFor(f), { ...input, [field]: "untrusted" });
				// Assert
				expect(response.status).toBe(400);
				expect(snapshot(f)).toEqual(before);
			},
		);
		test.for(["fingerprint", "confirm_evidence_digest"])(
			"rejects newline-suffixed %s before reading storage",
			async (field, { f }) => {
				// Arrange
				const getGroup = vi.spyOn(f.store, "getGroup");
				// Act
				const response = await request(appFor(f), { ...input, [field]: `${"a".repeat(64)}\n` });
				// Assert
				expect(response.status).toBe(400);
				expect(getGroup).not.toHaveBeenCalled();
			},
		);
		test("exhausted anonymous quota does not block authenticated operator preview", async ({
			f,
		}) => {
			// Arrange
			const app = appFor(f, true, secret, { unauthenticatedMutationLimit: 1 });
			const before = snapshot(f);
			// Act
			const denied = await request(app, input, "wrong-secret");
			const limited = await request(app, input, "wrong-secret");
			const operator = await request(app);
			// Assert
			expect([denied.status, limited.status, operator.status]).toEqual([401, 429, 200]);
			expect(snapshot(f)).toEqual(before);
		});
		test("caps the body and fails closed when auth storage is unavailable", async ({ f }) => {
			// Arrange
			const app = appFor(f);
			vi.spyOn(f.store, "getGroup").mockRejectedValue(new Error("private-storage-detail"));
			// Act
			const large = await request(app, { ...input, padding: "x".repeat(4096) });
			const unavailable = await request(app);
			// Assert
			expect(large.status).toBe(413);
			expect(unavailable.status).toBe(503);
			expect(await unavailable.text()).not.toContain("private-storage-detail");
		});
	});
	describe(`${backend} enrollment evidence`, () => {
		test.for([
			["UPDATE groups SET archived_at = 'archived'", "group_unavailable"],
			["UPDATE enrolled_devices SET enabled = 0", "enrollment_unavailable"],
			["UPDATE enrolled_devices SET fingerprint = 'different'", "key_mismatch"],
			[
				"UPDATE enrolled_devices SET identity_id = 'other-identity'",
				"enrollment_identity_mismatch",
			],
		] as const)("stops for %s", async ([sql, reason], { f }) => {
			// Arrange
			f.db.exec(sql);
			const before = snapshot(f);
			const app = appFor(f);
			// Act
			const preview = await request(app);
			const commit = await request(app, { ...input, confirm_evidence_digest: "b".repeat(64) });
			// Assert
			expect(await preview.json()).toMatchObject({
				state: "needs_review",
				reasons: expect.arrayContaining([reason]),
			});
			expect(commit.status).toBe(409);
			expect(await commit.json()).toMatchObject({ error: "needs_review" });
			expect(snapshot(f)).toEqual(before);
		});
		test("commits server-derived proof once, without changing enrollment or access", async ({
			f,
		}) => {
			// Arrange
			const app = appFor(f);
			const before = snapshot(f, [
				"coordinator_auth_controller_attestations",
				"coordinator_auth_link_audit_log",
			]);
			const preview = await (await request(app)).json();
			const body = { ...input, confirm_evidence_digest: preview.evidence_digest };
			// Act
			const created = await request(app, body);
			const afterCreated = snapshot(f);
			const replay = await request(app, body);
			// Assert
			expect(created.status).toBe(201);
			expect(await created.json()).toMatchObject({
				state: "created",
				identity_id: input.identity_id,
				coordinator_id: cfg.coordinatorId,
			});
			expect(replay.status).toBe(200);
			expect(await replay.json()).toMatchObject({ state: "existing" });
			expect(snapshot(f)).toEqual(afterCreated);
			expect(
				snapshot(f, [
					"coordinator_auth_controller_attestations",
					"coordinator_auth_link_audit_log",
				]),
			).toEqual(before);
		});
		test("changed exact public key invalidates digest; fresh preview can commit", async ({ f }) => {
			// Arrange
			const app = appFor(f);
			const old = await (await request(app)).json();
			f.db.exec("UPDATE enrolled_devices SET public_key = 'replacement-key'");
			const before = snapshot(f);
			// Act
			const stale = await request(app, { ...input, confirm_evidence_digest: old.evidence_digest });
			const fresh = await (await request(app)).json();
			const afterStale = snapshot(f);
			const created = await request(app, {
				...input,
				confirm_evidence_digest: fresh.evidence_digest,
			});
			// Assert
			expect(stale.status).toBe(409);
			expect(await stale.json()).toEqual({ error: "review_stale" });
			expect(afterStale).toEqual(before);
			expect(fresh.evidence_digest).not.toBe(old.evidence_digest);
			expect(created.status).toBe(201);
		});
	});
	describe(`${backend} invite evidence and insertion races`, () => {
		test("uses only consumed exact-key Team/add-device evidence, sorted independently of labels", async ({
			f,
		}) => {
			// Arrange
			for (const [id, kind, key, revoked] of [
				["z-invite", "team_member", review().publicKey, null],
				["a-invite", "add_device", review().publicKey, null],
				["project", "project_share", review().publicKey, null],
				["wrong-key", "team_member", "another-key", null],
				["revoked", "add_device", review().publicKey, "revoked"],
			] as const) {
				const invite = await f.store.createInvite({
					groupId: "group-a",
					policy: "auto",
					expiresAt: "2030-01-01T00:00:00Z",
				});
				f.db
					.prepare(
						"UPDATE coordinator_invites SET invite_id = ?, invite_kind = ?, consumed_at = 'consumed', bound_device_id = 'device-a', bound_public_key = ?, bound_fingerprint = ?, recipient_actor_id = 'identity-a', assigned_identity_id = 'identity-a', target_identity_id = 'identity-a', reviewed_preview_digest = ?, revoked_at = ? WHERE invite_id = ?",
					)
					.run(id, kind, key, input.fingerprint, "c".repeat(64), revoked, invite.invite_id);
			}
			const app = appFor(f);
			const before = snapshot(f);
			// Act
			const first = await (await request(app)).json();
			const afterPreview = snapshot(f);
			f.db.exec(
				"UPDATE coordinator_invites SET recipient_display_name = 'changed display'; UPDATE enrolled_devices SET display_name = 'changed device label'",
			);
			const list = f.store.listInvites.bind(f.store);
			vi.spyOn(f.store, "listInvites").mockImplementation(async (group) =>
				(await list(group)).reverse(),
			);
			const reordered = await (await request(app)).json();
			f.db.exec(
				"UPDATE coordinator_invites SET recipient_actor_id = 'other-identity' WHERE invite_id = 'a-invite'",
			);
			const mismatch = await (await request(app)).json();
			// Assert
			expect(first.reviewed_invites).toEqual([
				{ invite_id: "a-invite", kind: "add_device" },
				{ invite_id: "z-invite", kind: "team_member" },
			]);
			expect(afterPreview).toEqual(before);
			expect(reordered.evidence_digest).toBe(first.evidence_digest);
			expect(mismatch).toMatchObject({
				state: "needs_review",
				reasons: ["invite_identity_mismatch"],
			});
			expect(mismatch).not.toHaveProperty("evidence_digest");
			expect(JSON.stringify(first)).not.toContain("token");
		});
		test("pins live enrollment during insertion, not just during preview", async ({ f }) => {
			// Arrange
			const app = appFor(f);
			const preview = await (await request(app)).json();
			const create = f.store.createAuthControllerAttestation.bind(f.store);
			vi.spyOn(f.store, "createAuthControllerAttestation").mockImplementation(async (value) => {
				f.db.exec("UPDATE enrolled_devices SET public_key = 'key-changed-after-preview'");
				return create(value);
			});
			// Act
			const response = await request(app, {
				...input,
				confirm_evidence_digest: preview.evidence_digest,
			});
			// Assert
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "review_stale" });
			expect(f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all()).toEqual(
				[],
			);
		});
	});
	describe(`${backend} existing review conflicts`, () => {
		test.for(
			[null, "malformed"].flatMap((digest) =>
				["identity-a", "contradictory-actor"].map((actor) => ({ digest, actor })),
			),
		)(
			"invalid exact-key invite evidence %j cannot disappear from review",
			async ({ digest, actor }, { f }) => {
				// Arrange
				const invite = await f.store.createInvite({
					groupId: "group-a",
					policy: "auto",
					expiresAt: "2030-01-01T00:00:00Z",
				});
				f.db
					.prepare(
						"UPDATE coordinator_invites SET invite_kind = 'add_device', consumed_at = 'consumed', bound_device_id = 'device-a', bound_public_key = ?, bound_fingerprint = ?, recipient_actor_id = ?, target_identity_id = 'identity-a', reviewed_preview_digest = ? WHERE invite_id = ?",
					)
					.run(review().publicKey, input.fingerprint, actor, digest, invite.invite_id);
				const before = snapshot(f);
				const app = appFor(f);
				// Act
				const preview = await (await request(app)).json();
				const commit = await request(app, { ...input, confirm_evidence_digest: "b".repeat(64) });
				// Assert
				expect(preview.state).toBe("needs_review");
				expect(preview.reasons).toContain("invite_evidence_invalid");
				if (actor !== "identity-a") expect(preview.reasons).toContain("invite_identity_mismatch");
				expect(preview).not.toHaveProperty("evidence_digest");
				expect(commit.status).toBe(409);
				expect(await commit.json()).toMatchObject({ error: "needs_review" });
				expect(snapshot(f)).toEqual(before);
			},
		);
		test.for(["legacy", "other-actor", "revoked"])(
			"never overwrites %s review",
			async (mode, { f }) => {
				// Arrange
				const prior = review({
					coordinatorId: cfg.coordinatorId,
					identityId: mode === "other-actor" ? "identity-b" : "identity-a",
				});
				await f.store.createAuthControllerAttestation(prior);
				if (mode === "revoked")
					await f.store.revokeAuthControllerAttestation(prior.coordinatorId, prior.attestationId);
				const before = snapshot(f);
				const app = appFor(f);
				const preview = await (await request(app)).json();
				// Act
				const response = await request(app, {
					...input,
					confirm_evidence_digest: preview.evidence_digest,
				});
				// Assert
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({ error: "already_reviewed_or_needs_review" });
				expect(snapshot(f)).toEqual(before);
			},
		);
	});
}
