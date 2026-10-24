import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	controllerTable,
	history,
	originalController,
	resolutionTable,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { OwnerResolutionReviewError } from "./coordinator-owner-resolution-review.js";
import {
	deterministicReviewTests,
	expectSafeDto,
	scope,
	selection,
	setupReview,
	signer,
} from "./coordinator-owner-resolution-review-test-fixtures.js";

// All account births, labels, credentials and databases in this suite are synthetic.
const PATH = "/v1/admin/auth-controller-reviews";
const secret = "synthetic-scoped-review-admin";
const input = {
	purpose: "existing_account_owner",
	resolution_scope: scope,
	group_id: selection.groupId,
	device_id: selection.deviceId,
	identity_id: selection.identityId,
	fingerprint: selection.fingerprint,
};
function appFor(f: LinkFixture) {
	const factory = vi.fn(() => f.store);
	vi.spyOn(f.store, "close").mockResolvedValue(undefined);
	const app = createCoordinatorApp({
		storeFactory: factory,
		requestVerifier: async () => false,
		runtime: { adminSecret: () => secret, now: () => new Date(NOW).toISOString() },
		authLink: {
			config: { ...f.cfg, redirectUri: "https://coordinator.example.test/auth/callback" },
			storeFactory: factory,
		},
	});
	return { app, factory };
}
function request(
	app: ReturnType<typeof appFor>["app"],
	body: unknown = input,
	admin: string | null = secret,
) {
	return app.request(PATH, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(admin === null ? {} : { "X-Codemem-Coordinator-Admin": admin }),
			"X-Codemem-Admin-Actor": "identity-a",
			Cookie: "synthetic-private-cookie",
		},
		body: JSON.stringify(body),
	});
}
function expectEcho(value: unknown) {
	expect(value).toMatchObject(input);
	expectSafeDto(value);
	expect(JSON.stringify(value)).not.toMatch(
		/synthetic-scoped-review-admin|synthetic-private-cookie/,
	);
}

deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} scoped HTTP preview uses actual weak-C/account-A evidence without writes`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		const { app } = appFor(f);
		const before = snapshot(f);
		const actual = await f.store.previewOwnerResolutionReview(selection, f.cfg);
		// Act
		const response = await request(app);
		const dto = await response.json();
		// Assert
		expect(actual.state).toBe("ready");
		expect(response.status).toBe(200);
		expect(dto).toEqual(actual);
		expectEcho(dto);
		expect(dto.owner_resolution_digest).toMatch(/^[a-f0-9]{64}$/);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(snapshot(f)).toEqual(before);
		expect(f.store.close).toHaveBeenCalledTimes(1);
	});
	test(`${kind} scoped HTTP creates checked receipts and preserves every nonreceipt table`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		const { app } = appFor(f);
		const before = snapshot(f, [controllerTable, resolutionTable]);
		const preview = await (await request(app)).json();
		// Act
		const response = await request(app, {
			...input,
			confirm_owner_resolution_digest: preview.owner_resolution_digest,
		});
		const dto = await response.json();
		// Assert
		expect(response.status).toBe(201);
		expectEcho(dto);
		expect(dto).toMatchObject({
			recovery_receipt: { disposition: "created" },
			owner_resolution: { disposition: "created" },
		});
		expect(f.db.prepare(`SELECT * FROM ${controllerTable}`).get()).toMatchObject({
			attestation_id: dto.attestation_id,
			identity_id: "identity-a",
			enrollment_identity_id: "identity-c",
			public_key: signer.publicKey,
		});
		expect(f.db.prepare(`SELECT * FROM ${resolutionTable}`).get()).toMatchObject({
			resolution_id: dto.owner_resolution.resolution_id,
			source_attestation_id: dto.attestation_id,
			source_review_receipt_id: dto.recovery_receipt.review_receipt_id,
		});
		expect(snapshot(f, [controllerTable, resolutionTable])).toEqual(before);
		expect(f.store.close).toHaveBeenCalledTimes(2);
	});
	test(`${kind} scoped HTTP returns 201 when only the sidecar is newly created`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind, false);
		const original = await originalController(f);
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id=?")
			.run(signer.deviceId);
		const before = snapshot(f, [resolutionTable]);
		const { app } = appFor(f);
		const preview = await (await request(app)).json();
		// Act
		const response = await request(app, {
			...input,
			confirm_owner_resolution_digest: preview.owner_resolution_digest,
		});
		const dto = await response.json();
		// Assert
		expect(response.status).toBe(201);
		expectEcho(dto);
		expect(dto).toMatchObject({
			attestation_id: original.attestation_id,
			recovery_receipt: {
				disposition: "reused",
				review_receipt_id: original.review_receipt_id,
				evidence_digest: original.evidence_digest,
			},
			owner_resolution: { disposition: "created" },
		});
		expect(snapshot(f, [resolutionTable])).toEqual(before);
	});
	test(`${kind} lost HTTP reply makes original confirmation stale and read-only preview restores status`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		const { app } = appFor(f);
		const initial = await (await request(app)).json();
		const body = { ...input, confirm_owner_resolution_digest: initial.owner_resolution_digest };
		expect((await request(app, body)).status).toBe(201);
		const before = snapshot(f);
		// Act
		const stale = await request(app, body);
		const restored = await (await request(app)).json();
		const reused = await request(app, {
			...input,
			confirm_owner_resolution_digest: restored.owner_resolution_digest,
		});
		// Assert
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ error: "review_stale" });
		expectEcho(restored);
		expect(restored).toMatchObject({
			state: "restored",
			recovery_receipt: { disposition: "reused" },
			owner_resolution: { disposition: "reused" },
		});
		expect(reused.status).toBe(200);
		expectEcho(await reused.json());
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} API-derived fresh hash rejects changed historical evidence before writes`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		const { app } = appFor(f);
		const old = await (await request(app)).json();
		history(f, "new-history", "identity-d");
		const before = snapshot(f);
		// Act
		const fresh = await (await request(app)).json();
		const response = await request(app, {
			...input,
			confirm_owner_resolution_digest: old.owner_resolution_digest,
		});
		// Assert
		expect(fresh.state).toBe("ready");
		expect(fresh.owner_resolution_digest).not.toBe(old.owner_resolution_digest);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: "review_stale" });
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} needs-review preview is 200 with scope echoes and no confirmation digest`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		f.db.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?").run(signer.deviceId);
		const before = snapshot(f);
		const { app } = appFor(f);
		// Act
		const response = await request(app);
		const dto = await response.json();
		// Assert
		expect(response.status).toBe(200);
		expectEcho(dto);
		expect(dto).toMatchObject({ state: "needs_review", reasons: expect.any(Array) });
		expect(dto.reasons.length).toBeGreaterThan(0);
		expect(dto).not.toHaveProperty("owner_resolution_digest");
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} bad admin is denied before either store factory or private operations`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		const { app, factory } = appFor(f);
		const preview = vi.spyOn(f.store, "previewOwnerResolutionReview");
		const before = snapshot(f);
		// Act
		const responses = await Promise.all([
			request(app, input, "wrong-admin"),
			request(app, input, null),
		]);
		// Assert
		expect(responses.map((response) => response.status)).toEqual([401, 401]);
		expect(factory).not.toHaveBeenCalled();
		expect(preview).not.toHaveBeenCalled();
		expect(snapshot(f)).toEqual(before);
	});
	for (const [name, patch] of [
		["unknown scope", { resolution_scope: "all_owners" }],
		["null scope", { resolution_scope: null }],
		["missing purpose", { purpose: undefined }],
		["ordinary confirmation", { confirm_evidence_digest: "b".repeat(64) }],
		[
			"raw internal record",
			{ ownershipEvidenceDigest: "b".repeat(64), existing_receipt: {}, raw_record: {} },
		],
		["malformed selection/hash", { confirm_owner_resolution_digest: `${"a".repeat(64)}\n` }],
	] as const) {
		test(`${kind} rejects ${name} before private reads or writes`, async ({ fixture: f }) => {
			// Arrange
			await setupReview(f, kind);
			const { app } = appFor(f);
			const preview = vi.spyOn(f.store, "previewOwnerResolutionReview");
			const confirm = vi.spyOn(f.store, "confirmOwnerResolutionReview");
			const before = snapshot(f);
			let patches: Record<string, unknown>[] = [patch];
			if (name === "raw internal record")
				patches = Object.entries(patch).map(([key, value]) => ({ [key]: value }));
			if (name === "malformed selection/hash")
				patches = [
					patch,
					{ device_id: "\n" },
					{ group_id: " " },
					{ identity_id: "\n" },
					{ fingerprint: `${"a".repeat(64)}\n` },
				];
			// Act
			const responses = [];
			for (const value of patches) responses.push(await request(app, { ...input, ...value }));
			// Assert
			expect(responses.map((response) => response.status)).toEqual(patches.map(() => 400));
			expect(preview).not.toHaveBeenCalled();
			expect(confirm).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual(before);
		});
	}
	test(`${kind} resolution confirmation without scope never becomes ordinary approval`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		const { resolution_scope: _scope, ...legacy } = input;
		const { app } = appFor(f);
		const before = snapshot(f);
		// Act
		const response = await request(app, {
			...legacy,
			confirm_owner_resolution_digest: "a".repeat(64),
		});
		// Assert
		expect(response.status).toBe(400);
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} absent private capability returns 503 without controller fallback`, async ({
		fixture: f,
	}) => {
		// Arrange
		await setupReview(f, kind);
		Object.defineProperty(f.store, "previewOwnerResolutionReview", {
			value: undefined,
			configurable: true,
		});
		Object.defineProperty(f.store, "confirmOwnerResolutionReview", {
			value: undefined,
			configurable: true,
		});
		const fallback = vi.spyOn(f.store, "createAuthControllerAttestation");
		const { app } = appFor(f);
		const before = snapshot(f);
		// Act
		const response = await request(app);
		// Assert
		expect(response.status).toBe(503);
		expect(await response.text()).toMatch(/unavailable|unsupported|upgrade/i);
		expect(fallback).not.toHaveBeenCalled();
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} unknown postcommit outcome is safe and status restores actual committed facts`, async ({
		fixture: f,
	}) => {
		// Arrange: let the real checked writer finish, then simulate loss of its reply.
		await setupReview(f, kind);
		const confirm = f.store.confirmOwnerResolutionReview.bind(f.store);
		vi.spyOn(f.store, "confirmOwnerResolutionReview").mockImplementationOnce(async (...args) => {
			await confirm(...args);
			throw new OwnerResolutionReviewError("owner_resolution_outcome_unknown");
		});
		const { app } = appFor(f);
		const preview = await (await request(app)).json();
		// Act
		const response = await request(app, {
			...input,
			confirm_owner_resolution_digest: preview.owner_resolution_digest,
		});
		const text = await response.text();
		const before = snapshot(f);
		const restored = await (await request(app)).json();
		// Assert
		expect(response.status).toBe(503);
		expect(text).toMatch(/owner_resolution_outcome_unknown/);
		expect(text).not.toMatch(/SQL|private-claim-subject|synthetic-scoped-review-admin/);
		expect(restored.state).toBe("restored");
		expectEcho(restored);
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} no scope retains legacy owner-purpose controller-only creation`, async ({
		fixture: f,
	}) => {
		// Arrange: NULL current enrollment, not the correctly denied weak-C ordinary path.
		await setupReview(f, kind, false);
		const { resolution_scope: _scope, ...legacy } = input;
		const { app } = appFor(f);
		const before = snapshot(f, [controllerTable, "coordinator_auth_link_audit_log"]);
		const preview = await (await request(app, legacy)).json();
		// Act
		const response = await request(app, {
			...legacy,
			confirm_evidence_digest: preview.evidence_digest,
		});
		const dto = await response.json();
		// Assert
		expect(response.status).toBe(201);
		expect(dto).toMatchObject({ purpose: "existing_account_owner", state: "created" });
		expect(dto).not.toHaveProperty("resolution_scope");
		expect(f.db.prepare(`SELECT * FROM ${resolutionTable}`).all()).toEqual([]);
		expect(snapshot(f, [controllerTable, "coordinator_auth_link_audit_log"])).toEqual(before);
	});
}
