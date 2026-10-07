import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { ACCEPTED_ALIASES, NODE_ONLY_ALIASES } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import type { RecipientWriteHook } from "./coordinator-recipient-revocation-test-harness.js";
import type { CoordinatorReviewJoinRequestInput } from "./coordinator-store-contract.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

type JoinTest = ReturnType<typeof revocationHarness>;
export const JOIN_NOW = "2026-10-06T00:00:00.000Z";
export const joinTables = [
	"coordinator_join_requests",
	"enrolled_devices",
	"coordinator_bootstrap_grants",
	"coordinator_device_revocations",
];
export function joinSnapshot(f: RevocationFixture) {
	return Promise.all(joinTables.map((table) => f.rows(table)));
}
export async function pendingJoin(f: RevocationFixture, publicKey = f.input.publicKey) {
	await f.store.createGroup(f.input.groupId);
	const seed = {
		...f.input,
		deviceId: `${f.input.deviceId}-seed`,
		publicKey: UNRELATED_PUBLIC_KEY,
	};
	seed.fingerprint = fingerprintPublicKey(seed.publicKey);
	await f.store.enrollDevice(seed.groupId, seed);
	const request = await f.store.createJoinRequest({
		...f.input,
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		displayName: "Reviewed laptop",
		token: "join-fixture-token",
	});
	const options: CoordinatorReviewJoinRequestInput = {
		requestId: request.request_id,
		approved: true,
		reviewedBy: "reviewer-original",
		bootstrapGrant: {
			seedDeviceId: seed.deviceId,
			expiresAt: "2026-10-07T00:00:00.000Z",
			createdBy: "grant-author",
		},
	};
	return { request, seed, options };
}
async function revokeTuple(
	f: RevocationFixture,
	tuple = f.input,
	subject?: "device_id" | "ed25519_key",
) {
	await f.store.enrollDevice(tuple.groupId, tuple);
	expect(await f.store.createDeviceRevocation(tuple)).toMatchObject({ kind: "revoked" });
	await f.store.removeDevice(tuple.groupId, tuple.deviceId);
	if (subject)
		await f.exec("DELETE FROM coordinator_device_revocations WHERE subject_kind != ?", subject);
}

export function registerJoinReviewContract(test: JoinTest) {
	registerOrdinary(test);
	registerRecipientRevocations(test);
	registerSeedRevocations(test);
	registerReviewPrecedence(test);
	registerAtomicFailures(test);
	registerApi(test);
}
function registerOrdinary(test: JoinTest) {
	for (const key of ["canonical", "opaque"] as const) {
		for (const grant of ["with grant", "without grant"] as const) {
			test(`ordinary ${key} approval ${grant} preserves enrollment fields`, async ({
				fixture: f,
			}) => {
				// Arrange
				const { request, options } = await pendingJoin(
					f,
					key === "opaque" ? "opaque-legacy-key" : f.input.publicKey,
				);
				await f.store.enrollDevice(f.input.groupId, {
					...f.input,
					identityId: "retained-identity",
					displayName: "Old label",
				});
				await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
				const before = await f.store.getEnrollment(f.input.groupId, f.input.deviceId, true);
				if (grant === "without grant") options.bootstrapGrant = null;
				// Act
				const result = await f.store.reviewJoinRequest(options);
				// Assert
				expect(result).toMatchObject({ status: "approved", reviewed_by: options.reviewedBy });
				expect(result?._no_transition).not.toBe(true);
				expect(await f.store.getEnrollment(f.input.groupId, f.input.deviceId)).toMatchObject({
					public_key: request.public_key,
					fingerprint: request.fingerprint,
					display_name: request.display_name,
					identity_id: "retained-identity",
					enabled: 1,
					created_at: before?.created_at,
				});
				expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(
					grant === "with grant" ? 1 : 0,
				);
			});
		}
	}
	test("missing request returns null without effects", async ({ fixture: f }) => {
		// Arrange
		await pendingJoin(f);
		const before = await joinSnapshot(f);
		// Act
		const result = await f.store.reviewJoinRequest({ requestId: "missing", approved: true });
		// Assert
		expect(result).toBeNull();
		expect(await joinSnapshot(f)).toEqual(before);
	});
	test("captures options and nested bootstrap grant before the first await", async ({
		fixture: f,
	}) => {
		// Arrange
		const { options, seed } = await pendingJoin(f);
		const bootstrap = options.bootstrapGrant;
		if (!bootstrap) throw new Error("Missing fixture grant");
		// Act
		const pending = f.store.reviewJoinRequest(options);
		Object.assign(options, { requestId: "wrong", approved: false, reviewedBy: "wrong" });
		Object.assign(bootstrap, { seedDeviceId: "wrong", expiresAt: "wrong", createdBy: "wrong" });
		const result = await pending;
		// Assert
		expect(result).toMatchObject({
			status: "approved",
			reviewed_by: "reviewer-original",
			bootstrap_grant: {
				seed_device_id: seed.deviceId,
				created_by: "grant-author",
				expires_at: "2026-10-07T00:00:00.000Z",
			},
		});
	});
}
function registerRecipientRevocations(test: JoinTest) {
	for (const subject of ["device_id", "ed25519_key"] as const) {
		const aliases =
			subject === "device_id"
				? [{ name: "new key", publicKey: UNRELATED_PUBLIC_KEY }]
				: [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES];
		for (const alias of aliases) {
			test(`recipient ${subject} revocation denies ${alias.name} after removal`, async ({
				fixture: f,
			}) => {
				// Arrange: canonical tombstone comes from a real enrolled tuple, never caller fingerprint.
				const { request, options } = await pendingJoin(f);
				await revokeTuple(f, f.input, subject);
				await f.exec(
					"UPDATE coordinator_join_requests SET device_id = ?, public_key = ?, fingerprint = ? WHERE request_id = ?",
					subject === "device_id" ? f.input.deviceId : `${f.input.deviceId}-new`,
					alias.publicKey,
					fingerprintPublicKey(alias.publicKey),
					request.request_id,
				);
				const before = await joinSnapshot(f);
				// Act
				const pending = f.store.reviewJoinRequest(options);
				// Assert
				await expect(pending).rejects.toThrow(/^device_revoked$/);
				expect(await joinSnapshot(f)).toEqual(before);
			});
		}
	}
}
function registerSeedRevocations(test: JoinTest) {
	for (const subject of ["device_id", "ed25519_key"] as const) {
		test(`seed ${subject} revocation rejects a clean recipient without transition`, async ({
			fixture: f,
		}) => {
			// Arrange: recipient ID and canonical key are both unrelated to the revoked seed.
			const { seed, options } = await pendingJoin(f);
			expect(await f.store.createDeviceRevocation(seed)).toMatchObject({ kind: "revoked" });
			await f.exec("DELETE FROM coordinator_device_revocations WHERE subject_kind != ?", subject);
			const before = await joinSnapshot(f);
			// Act
			const pending = f.store.reviewJoinRequest(options);
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await joinSnapshot(f)).toEqual(before);
		});
	}
	for (const alias of [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES]) {
		test(`current seed ${alias.name} is denied by key-only revocation through another ID`, async ({
			fixture: f,
		}) => {
			// Arrange: clean opaque recipient prevents an accidental receiver denial.
			const { seed, options } = await pendingJoin(f, "clean-legacy-recipient");
			await revokeTuple(f, f.input, "ed25519_key");
			await f.exec(
				"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?",
				alias.publicKey,
				fingerprintPublicKey(alias.publicKey),
				seed.deviceId,
			);
			const before = await joinSnapshot(f);
			// Act
			const pending = f.store.reviewJoinRequest(options);
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await joinSnapshot(f)).toEqual(before);
		});
	}
	for (const scenario of ["missing", "disabled", "wrong group", "equal recipient"] as const) {
		test(`unrevoked ${scenario} seed preserves existing validation error`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { seed, options } = await pendingJoin(f);
			await changeSeed(f, seed, scenario);
			if (scenario === "equal recipient" && options.bootstrapGrant)
				options.bootstrapGrant.seedDeviceId = f.input.deviceId;
			const before = await joinSnapshot(f);
			// Act
			const pending = f.store.reviewJoinRequest(options);
			// Assert
			await expect(pending).rejects.toThrow(
				scenario === "equal recipient"
					? "bootstrap grant seed and worker device ids must differ."
					: "bootstrap grant seed device is not enrolled in the group.",
			);
			expect(await joinSnapshot(f)).toEqual(before);
		});
	}
}
type JoinSeed = Awaited<ReturnType<typeof pendingJoin>>["seed"];
async function changeSeed(f: RevocationFixture, seed: JoinSeed, scenario: string) {
	switch (scenario) {
		case "missing":
		case "seed removed":
			return f.store.removeDevice(seed.groupId, seed.deviceId);
		case "disabled":
		case "seed disabled":
			return f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
		case "wrong group":
			return f.exec(
				"UPDATE enrolled_devices SET group_id = ? WHERE device_id = ?",
				"other-group",
				seed.deviceId,
			);
		case "equal recipient":
			return f.store.enrollDevice(f.input.groupId, f.input);
		case "seed revoked":
			return f.store.createDeviceRevocation(seed);
		case "seed rotates":
			return f.exec(
				"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?",
				"rotated-clean-key",
				fingerprintPublicKey("rotated-clean-key"),
				seed.deviceId,
			);
		default:
			throw new Error("Unknown seed scenario");
	}
}
function registerReviewPrecedence(test: JoinTest) {
	for (const revoked of [false, true]) {
		test(`deny ${revoked ? "revoked" : "ordinary"} pending recipient succeeds without enrollment or grant`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { options } = await pendingJoin(f);
			if (revoked) await revokeTuple(f);
			const before = (await joinSnapshot(f)).slice(1);
			// Act
			const result = await f.store.reviewJoinRequest({ ...options, approved: false });
			// Assert
			expect(result).toMatchObject({ status: "denied" });
			expect(result?._no_transition).not.toBe(true);
			expect((await joinSnapshot(f)).slice(1)).toEqual(before);
		});
	}
	for (const approved of [false, true]) {
		test(`already ${approved ? "approved" : "denied"} then revoked returns no transition before bootstrap validation`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { options } = await pendingJoin(f);
			await f.store.reviewJoinRequest({ ...options, approved, bootstrapGrant: null });
			await revokeTuple(f);
			const before = await joinSnapshot(f);
			// Act
			const result = await f.store.reviewJoinRequest({
				...options,
				bootstrapGrant: { seedDeviceId: "", expiresAt: "invalid" },
			});
			// Assert
			expect(result).toMatchObject({
				status: approved ? "approved" : "denied",
				_no_transition: true,
			});
			expect(await joinSnapshot(f)).toEqual(before);
		});
	}
}
function registerAtomicFailures(test: JoinTest) {
	for (const stage of ["transition", "enrollment"] as const) {
		test(`trigger changes seed after ${stage}: later guard aborts actual transaction`, async ({
			fixture: f,
		}) => {
			// Arrange: a synthetic intra-batch mutation must not be hidden by after-commit cleanup.
			const { seed, options } = await pendingJoin(f);
			const before = await joinSnapshot(f);
			const event =
				stage === "transition"
					? "AFTER UPDATE OF status ON coordinator_join_requests WHEN NEW.status = 'approved'"
					: "AFTER INSERT ON enrolled_devices";
			await f.exec(
				`CREATE TRIGGER join_failure ${event} BEGIN UPDATE enrolled_devices SET enabled = 0 WHERE device_id = '${seed.deviceId}'; END`,
			);
			try {
				// Act
				const pending = f.store.reviewJoinRequest(options);
				// Assert: even the trigger mutation rolls back together with the request and enrollment.
				await expect(pending).rejects.toThrow(/^join_review_incomplete$/);
				expect(await joinSnapshot(f)).toEqual(before);
			} finally {
				await f.exec("DROP TRIGGER IF EXISTS join_failure");
			}
		});
	}
	for (const table of ["enrolled_devices", "coordinator_bootstrap_grants"]) {
		test(`SQL failure inserting ${table} rolls back the whole approval`, async ({ fixture: f }) => {
			// Arrange: real SQL failure inside the transaction, not a mocked store rejection.
			const { options } = await pendingJoin(f);
			const before = await joinSnapshot(f);
			await f.exec(
				`CREATE TRIGGER join_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'join fixture failure'); END`,
			);
			try {
				// Act
				const pending = f.store.reviewJoinRequest(options);
				// Assert
				await expect(pending).rejects.toThrow();
				expect(await joinSnapshot(f)).toEqual(before);
			} finally {
				await f.exec("DROP TRIGGER IF EXISTS join_failure");
			}
		});
	}
}
function registerApi(test: JoinTest) {
	for (const scenario of ["ordinary", "seed revoked", "already reviewed", "bad admin"] as const) {
		test(`admin approve API handles ${scenario} with real store and exact status`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { seed, options } = await pendingJoin(f);
			await prepareApiState(f, seed, options, scenario);
			const before = await joinSnapshot(f);
			const close = vi.spyOn(f.store, "close").mockResolvedValue();
			const review = vi.spyOn(f.store, "reviewJoinRequest");
			const verifier = vi.fn(async () => false);
			const app = createCoordinatorApp({
				storeFactory: () => f.store,
				runtime: { adminSecret: () => "fixture-admin", now: () => JOIN_NOW },
				requestVerifier: verifier,
			});
			try {
				// Act
				const response = await app.request("/v1/admin/join-requests/approve", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Codemem-Coordinator-Admin": scenario === "bad admin" ? "wrong" : "fixture-admin",
					},
					body: JSON.stringify({
						request_id: options.requestId,
						reviewed_by: options.reviewedBy,
						bootstrap_grant_seed_device_id:
							scenario === "already reviewed" ? "missing" : seed.deviceId,
						bootstrap_grant_expires_at: "2026-10-07T00:00:00.000Z",
					}),
				});
				// Assert
				const statuses = {
					ordinary: 200,
					"seed revoked": 403,
					"already reviewed": 409,
					"bad admin": 401,
				};
				expect(response.status).toBe(statuses[scenario]);
				const bodies = {
					ordinary: { ok: true, request: { status: "approved" } },
					"seed revoked": { error: "device_revoked" },
					"already reviewed": { error: "request_not_pending", status: "approved" },
					"bad admin": { error: "invalid_admin_secret" },
				};
				const body = await response.json();
				if (scenario === "ordinary") expect(body).toMatchObject(bodies[scenario]);
				else {
					expect(body).toEqual(bodies[scenario]);
					expect(await joinSnapshot(f)).toEqual(before);
				}
				expect(verifier).not.toHaveBeenCalled();
				if (scenario === "bad admin") expect(review).not.toHaveBeenCalled();
			} finally {
				review.mockRestore();
				close.mockRestore();
			}
		});
	}
}
async function prepareApiState(
	f: RevocationFixture,
	seed: JoinSeed,
	options: CoordinatorReviewJoinRequestInput,
	scenario: string,
) {
	if (scenario === "seed revoked") await f.store.createDeviceRevocation(seed);
	if (scenario === "already reviewed") {
		await f.store.reviewJoinRequest({ ...options, bootstrapGrant: null });
		await f.store.createDeviceRevocation(f.input);
	}
}

export function registerJoinWriteGuards(
	test: JoinTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	registerWithoutBatch(test, guarded);
	registerSuppressedWrites(test);
	registerGateChanges(test, guarded);
	registerConcurrentReviews(test, guarded);
}
function registerSuppressedWrites(test: JoinTest) {
	for (const table of ["enrolled_devices", "coordinator_bootstrap_grants"]) {
		test(`synthetic RAISE(IGNORE) on ${table} reports incomplete, not fictional rollback`, async ({
			fixture: f,
		}) => {
			// Arrange: this trigger is not installed in production. It suppresses a write without aborting.
			const { options } = await pendingJoin(f);
			await f.exec(
				`CREATE TRIGGER join_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
			);
			try {
				// Act
				const pending = f.store.reviewJoinRequest(options);
				// Assert: D1's successful CAS can commit even though downstream receipts report zero.
				await expect(pending).rejects.toThrow(/^join_review_incomplete$/);
				expect(await f.rows("coordinator_join_requests")).toMatchObject([{ status: "approved" }]);
				expect(await f.rows("enrolled_devices")).toHaveLength(table === "enrolled_devices" ? 1 : 2);
				expect(await f.rows("coordinator_bootstrap_grants")).toEqual([]);
				expect(await f.rows("coordinator_device_revocations")).toEqual([]);
			} finally {
				await f.exec("DROP TRIGGER IF EXISTS join_failure");
			}
		});
	}
}
function registerWithoutBatch(
	test: JoinTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	for (const approved of [true, false]) {
		test(`D1 without batch ${approved ? "approval fails without writes" : "deny retains single CAS"}`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { options } = await pendingJoin(f);
			const before = await joinSnapshot(f);
			const write = vi.fn();
			const wrapped = guarded(f, async () => {
				write();
			});
			if (!(wrapped instanceof D1CoordinatorStore)) throw new Error("Expected D1 fixture");
			const store = new D1CoordinatorStore({ prepare: (query) => wrapped.db.prepare(query) });
			// Act
			const pending = store.reviewJoinRequest({ ...options, approved });
			// Assert
			if (approved) {
				await expect(pending).rejects.toThrow(/^join_review_unavailable$/);
				expect(write).not.toHaveBeenCalled();
				expect(await joinSnapshot(f)).toEqual(before);
			} else {
				expect(await pending).toMatchObject({ status: "denied" });
				expect(write).toHaveBeenCalledTimes(1);
				expect((await joinSnapshot(f)).slice(1)).toEqual(before.slice(1));
			}
		});
	}
}
function registerGateChanges(
	test: JoinTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	for (const scenario of [
		"recipient revoked",
		"seed revoked",
		"seed rotates",
		"seed rotates onto revoked key",
		"seed removed",
		"seed disabled",
		"request drift",
	] as const) {
		test(`actual approval batch refuses ${scenario} after capture`, async ({ fixture: f }) => {
			// Arrange
			const { request, seed, options } = await pendingJoin(f, "clean-legacy-recipient");
			if (scenario === "seed rotates onto revoked key")
				await f.exec(
					"UPDATE coordinator_join_requests SET device_id = ? WHERE request_id = ?",
					"clean-recipient-id",
					request.request_id,
				);
			let called = false;
			let atGate: unknown[][] = [];
			const racing = guarded(f, async (writes, phase) => {
				if (
					called ||
					phase !== "batch" ||
					!writes.some((w) => w.query.includes("UPDATE coordinator_join_requests"))
				)
					return;
				called = true;
				await changeJoinGate(f, seed, request.request_id, scenario);
				atGate = await joinSnapshot(f);
			});
			// Act
			const pending = racing.reviewJoinRequest(options);
			// Assert: no after-commit cleanup can disguise a changed request or extra grant.
			await expect(pending).rejects.toThrow(
				["recipient revoked", "seed revoked"].includes(scenario)
					? /^device_revoked$/
					: /^join_review_incomplete$/,
			);
			expect(called).toBe(true);
			expect(await joinSnapshot(f)).toEqual(atGate);
		});
	}
}
async function changeJoinGate(
	f: RevocationFixture,
	seed: JoinSeed,
	requestId: string,
	scenario: string,
) {
	if (scenario === "recipient revoked") return revokeTuple(f);
	if (scenario === "seed rotates onto revoked key") {
		await revokeTuple(f, f.input, "ed25519_key");
		return f.exec(
			"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?",
			f.input.publicKey,
			fingerprintPublicKey(f.input.publicKey),
			seed.deviceId,
		);
	}
	if (scenario === "request drift")
		return f.exec(
			"UPDATE coordinator_join_requests SET public_key = ?, fingerprint = ?, device_id = ? WHERE request_id = ?",
			"drift-key",
			fingerprintPublicKey("drift-key"),
			"drift-device",
			requestId,
		);
	return changeSeed(f, seed, scenario);
}
function registerConcurrentReviews(
	test: JoinTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	for (const winnerApproved of [true, false]) {
		test(`same-timestamp approval loses to ${winnerApproved ? "approval" : "deny"} without duplicate effects`, async ({
			fixture: f,
		}) => {
			// Arrange: same reviewer and timestamp; winner runs after loser's read, before its batch.
			const { options } = await pendingJoin(f);
			const winners: Awaited<ReturnType<Store["reviewJoinRequest"]>>[] = [];
			let atGate: unknown[][] = [];
			let called = false;
			const racing = guarded(f, async (writes, phase) => {
				if (
					called ||
					phase !== "batch" ||
					!writes.some((w) => w.query.includes("UPDATE coordinator_join_requests"))
				)
					return;
				called = true;
				winners.push(
					await f.store.reviewJoinRequest({
						...options,
						approved: winnerApproved,
					}),
				);
				atGate = await joinSnapshot(f);
			});
			// Act
			const loser = await racing.reviewJoinRequest(options);
			// Assert: timestamp/status alone must not identify this invocation as a winner.
			expect(called).toBe(true);
			expect(winners).toHaveLength(1);
			expect(winners[0]).toMatchObject({
				status: winnerApproved ? "approved" : "denied",
				reviewed_by: options.reviewedBy,
				reviewed_at: JOIN_NOW,
			});
			expect(winners[0]?._no_transition).not.toBe(true);
			expect(loser).toMatchObject({
				status: winnerApproved ? "approved" : "denied",
				reviewed_by: options.reviewedBy,
				reviewed_at: JOIN_NOW,
				_no_transition: true,
			});
			expect(await joinSnapshot(f)).toEqual(atGate);
			expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(winnerApproved ? 1 : 0);
		});
	}
}
