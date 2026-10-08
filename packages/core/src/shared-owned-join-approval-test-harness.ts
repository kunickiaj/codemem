import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import {
	insertOwnership,
	OWNERSHIP_TABLE,
	ownedRow,
} from "./coordinator-device-ownership-test-harness.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { ACCEPTED_ALIASES, NODE_ONLY_ALIASES } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	JOIN_NOW,
	joinSnapshot,
	joinTables,
	pendingJoin,
} from "./coordinator-join-revocation-test-harness.js";
import { recipientGuardedD1 } from "./coordinator-recipient-revocation-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";
import { OWNED_DENIAL, OWNED_UNAVAILABLE } from "./shared-owned-device-enrollment-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

type Test = ReturnType<typeof revocationHarness>;
export const ownedJoinTables = [...joinTables, OWNERSHIP_TABLE];
export async function ownedJoinSnapshot(f: RevocationFixture) {
	return [...(await joinSnapshot(f)), await f.rows(OWNERSHIP_TABLE)];
}
// Raw retained ledger fixtures are denial evidence, not verified identity proofs.
async function bind(
	f: RevocationFixture,
	subject: "ID" | "key",
	deviceId = f.input.deviceId,
	key = f.input.publicKey,
) {
	await insertOwnership(
		{ store: f.store, exec: f.exec, query: async () => [] },
		{
			...ownedRow,
			device_id: subject === "ID" ? deviceId : "retained-other-device",
			key_id: subject === "ID" ? "b".repeat(64) : await ed25519KeyId(key),
			identity_id: "reviewer-original",
		},
	);
}
export function registerOwnedJoinContract(test: Test) {
	registerOrdinary(test);
	registerDenials(test);
	registerRetention(test);
	registerTransactionGuards(test);
	registerHttp(test);
}
function registerOrdinary(test: Test) {
	for (const owner of ["none", "seed", "reviewer"] as const) {
		test(`unowned recipient approval allows ${owner} ownership without minting a binding`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { seed, options } = await pendingJoin(f);
			if (owner === "seed") await bind(f, "ID", seed.deviceId);
			if (owner === "reviewer") await bind(f, "ID", options.reviewedBy ?? "reviewer-original");
			const ledger = await f.rows(OWNERSHIP_TABLE);
			// Act
			const result = await f.store.reviewJoinRequest(options);
			// Assert
			expect(result).toMatchObject({ status: "approved", reviewed_by: "reviewer-original" });
			expect(await f.store.getEnrollment(f.input.groupId, f.input.deviceId)).toMatchObject({
				public_key: f.input.publicKey,
				enabled: 1,
			});
			expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
			expect(await f.rows(OWNERSHIP_TABLE)).toEqual(ledger);
		});
	}
}
function registerDenials(test: Test) {
	for (const subject of ["ID", "key", "current key"] as const) {
		const aliases =
			subject === "key"
				? [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES]
				: [{ name: "replacement", publicKey: UNRELATED_PUBLIC_KEY }];
		for (const alias of aliases) {
			for (const grant of [true, false]) {
				test(`owned ${subject} denies ${alias.name}, grant=${grant}, despite matching actor labels`, async ({
					fixture: f,
				}) => {
					// Arrange: identity/reviewer labels match the ledger but convey no authority.
					const { request, options } = await pendingJoin(f, alias.publicKey);
					await prepareDenial(f, subject, request.request_id);
					if (!grant) options.bootstrapGrant = null;
					const before = await ownedJoinSnapshot(f);
					// Act
					const pending = f.store.reviewJoinRequest(options);
					// Assert: CAS, identity replacement, enabling and grant creation must all remain untouched.
					await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
					expect(await ownedJoinSnapshot(f)).toEqual(before);
				});
			}
		}
	}
	for (const status of ["pending", "approved", "denied"] as const) {
		test(`owned ${status} request remains rejectable or a no-op without enrollment mutation`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { options } = await pendingJoin(f);
			if (status !== "pending")
				await f.store.reviewJoinRequest({ ...options, approved: status === "approved" });
			await bind(f, "ID");
			const before = await ownedJoinSnapshot(f);
			// Act
			const result = await f.store.reviewJoinRequest({ ...options, approved: false });
			// Assert
			expect(result).toMatchObject({ status: status === "pending" ? "denied" : status });
			expect(result?._no_transition === true).toBe(status !== "pending");
			expect((await ownedJoinSnapshot(f)).slice(1)).toEqual(before.slice(1));
			if (status !== "pending") expect(await ownedJoinSnapshot(f)).toEqual(before);
		});
	}
}
async function prepareDenial(f: RevocationFixture, subject: string, requestId: string) {
	if (subject === "current key") {
		await f.store.enrollDevice(f.input.groupId, { ...f.input, identityId: "reviewer-original" });
		await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
	}
	await bind(f, subject === "ID" ? "ID" : "key");
	if (subject === "key")
		await f.exec(
			"UPDATE coordinator_join_requests SET device_id = ? WHERE request_id = ?",
			"fresh-recipient",
			requestId,
		);
}
function registerRetention(test: Test) {
	for (const revoked of [false, true]) {
		test(`retained owner after last group removal denies approval, revoked=${revoked}`, async ({
			fixture: f,
		}) => {
			// Arrange
			await f.store.createGroup(f.input.groupId);
			await f.store.enrollDevice(f.input.groupId, f.input);
			await bind(f, "ID");
			if (revoked) await f.store.createDeviceRevocation(f.input);
			await f.store.removeDevice(f.input.groupId, f.input.deviceId);
			await f.exec("DELETE FROM groups WHERE group_id = ?", f.input.groupId);
			const { options } = await pendingJoin(f, UNRELATED_PUBLIC_KEY);
			const before = await ownedJoinSnapshot(f);
			// Act
			const pending = f.store.reviewJoinRequest(options);
			// Assert: revocation retains its existing priority; cleanup releases neither authority.
			await expect(pending).rejects.toThrow(
				revoked ? /^device_revoked$/ : new RegExp(`^${OWNED_DENIAL}$`),
			);
			expect(await ownedJoinSnapshot(f)).toEqual(before);
		});
	}
}
function registerTransactionGuards(test: Test) {
	for (const stage of ["transition", "enrollment", "grant"] as const) {
		for (const subject of ["ID", "key"] as const) {
			test(`ownership inserted after actual ${stage} aborts approval for ${subject}`, async ({
				fixture: f,
			}) => {
				// Arrange: inject inside the actual transaction, not into a private guard helper.
				const { options } = await pendingJoin(f);
				const before = await ownedJoinSnapshot(f);
				const event = {
					transition:
						"AFTER UPDATE OF status ON coordinator_join_requests WHEN NEW.status = 'approved'",
					enrollment: "AFTER INSERT ON enrolled_devices",
					grant: "AFTER INSERT ON coordinator_bootstrap_grants",
				}[stage];
				await f.exec(
					`CREATE TRIGGER join_owned_race ${event} BEGIN INSERT INTO ${OWNERSHIP_TABLE} (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) VALUES ('${subject === "ID" ? f.input.deviceId : "other-owner"}','${subject === "ID" ? "b".repeat(64) : ownedRow.key_id}','reviewer-original','coordinator-a','binding-a','owner_enrollment','fixture-reference','${JOIN_NOW}'); END`,
				);
				try {
					// Act
					const pending = f.store.reviewJoinRequest(options);
					// Assert: the injected ledger is rolled back too, unlike a pre-batch insertion.
					await expect(pending).rejects.toThrow(
						new RegExp(`^(${OWNED_DENIAL}|join_review_incomplete)$`),
					);
					expect(await ownedJoinSnapshot(f)).toEqual(before);
				} finally {
					await f.exec("DROP TRIGGER IF EXISTS join_owned_race");
				}
			});
		}
	}
}
const httpCases: [string, number, string][] = [
	["unowned", 200, ""],
	["owned", 403, OWNED_DENIAL],
	["unavailable", 503, OWNED_UNAVAILABLE],
	["missing", 404, "request_not_found"],
	["bad admin", 401, "invalid_admin_secret"],
	["disabled admin", 401, "admin_not_configured"],
];
async function prepareHttpState(f: RevocationFixture, scenario: string) {
	if (scenario === "owned") await bind(f, "ID");
	if (scenario === "unavailable") await f.exec(`DROP TABLE ${OWNERSHIP_TABLE}`);
}
function registerHttp(test: Test) {
	for (const [scenario, status, error] of httpCases) {
		test(`join approval HTTP ${scenario} keeps admission private and signature verification unchanged`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { options } = await pendingJoin(f);
			await prepareHttpState(f, scenario);
			const before = await joinSnapshot(f);
			const close = vi.spyOn(f.store, "close").mockResolvedValue();
			const review = vi.spyOn(f.store, "reviewJoinRequest");
			const verifier = vi.fn(async () => false);
			const app = createCoordinatorApp({
				storeFactory: () => f.store,
				requestVerifier: verifier,
				runtime: {
					now: () => JOIN_NOW,
					adminSecret: () => (scenario === "disabled admin" ? "" : "fixture-admin"),
				},
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
						request_id: scenario === "missing" ? "missing" : options.requestId,
						reviewed_by: "reviewer-original",
					}),
				});
				// Assert
				expect(response.status).toBe(status);
				const body = await response.json();
				if (scenario === "unowned")
					expect(body).toMatchObject({ ok: true, request: { status: "approved" } });
				else {
					expect(body).toEqual({ error });
					expect(await joinSnapshot(f)).toEqual(before);
				}
				expect(verifier).not.toHaveBeenCalled();
				expect(review).toHaveBeenCalledTimes(Number(!scenario.includes("admin")));
			} finally {
				close.mockRestore();
				review.mockRestore();
			}
		});
	}
}
export function registerOwnedJoinD1Guards(
	test: Test,
	database: (f: RevocationFixture) => D1DatabaseLike,
) {
	registerGateRaces(test, database);
	registerReceipts(test, database);
	registerConcurrentWinner(test, database);
	registerOwnershipUnavailable(test, database);
	test("binding arriving while D1 review hashes prevents captured request effects", async ({
		fixture: f,
	}) => {
		// Arrange: SQLite has no asynchronous hash window; its transaction races are tested above.
		const { options } = await pendingJoin(f);
		const before = await joinSnapshot(f);
		// Act
		const pending = f.store.reviewJoinRequest(options);
		await bind(f, "ID");
		Object.assign(options, { requestId: "wrong-request", reviewedBy: "wrong-reviewer" });
		// Assert
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
		expect(await joinSnapshot(f)).toEqual(before);
		expect(await f.rows(OWNERSHIP_TABLE)).toHaveLength(1);
	});
}
function registerGateRaces(test: Test, database: (f: RevocationFixture) => D1DatabaseLike) {
	for (const scenario of [
		"ID",
		"key",
		"current key",
		"request key",
		"request status",
		"current enrollment",
	] as const) {
		test(`final D1 batch pins ${scenario} after capture without consuming or replacing anything`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { options, request } = await pendingJoin(f);
			let atGate: unknown[][] = [];
			let called = false;
			const racing = recipientGuardedD1(database(f), async (writes, phase) => {
				if (
					called ||
					phase !== "batch" ||
					!writes.some((w) => w.query.includes("UPDATE coordinator_join_requests"))
				)
					return;
				called = true;
				await changeGate(f, scenario, request.request_id);
				atGate = await ownedJoinSnapshot(f);
			});
			// Act
			const pending = racing.reviewJoinRequest(options);
			// Assert
			if (scenario === "request status")
				expect(await pending).toMatchObject({ status: "denied", _no_transition: true });
			else
				await expect(pending).rejects.toThrow(
					["ID", "key", "current key"].includes(scenario)
						? new RegExp(`^${OWNED_DENIAL}$`)
						: /^join_review_incomplete$/,
				);
			expect(called).toBe(true);
			expect(await ownedJoinSnapshot(f)).toEqual(atGate);
		});
	}
}
async function changeGate(f: RevocationFixture, scenario: string, requestId: string) {
	switch (scenario) {
		case "ID":
		case "key":
			return bind(f, scenario);
		case "current key":
			await f.store.enrollDevice(f.input.groupId, f.input);
			return bind(f, "key");
		case "request key":
			return f.exec(
				"UPDATE coordinator_join_requests SET public_key = ?, fingerprint = ? WHERE request_id = ?",
				UNRELATED_PUBLIC_KEY,
				fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
				requestId,
			);
		case "request status":
			return f.exec(
				"UPDATE coordinator_join_requests SET status = 'denied', reviewed_by = 'winner' WHERE request_id = ?",
				requestId,
			);
		case "current enrollment":
			return f.store.enrollDevice(f.input.groupId, {
				...f.input,
				publicKey: UNRELATED_PUBLIC_KEY,
				fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
				identityId: "concurrent-identity",
			});
		default:
			throw new Error("Unknown join race");
	}
}
function registerReceipts(test: Test, database: (f: RevocationFixture) => D1DatabaseLike) {
	registerLostReplies(test, database);
	for (const receipt of ["lost", "malformed", "zero"] as const) {
		test(`D1 ${receipt} receipts report uncertainty without claiming committed writes rolled back`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { options } = await pendingJoin(f);
			const db = database(f);
			const store = new D1CoordinatorStore({
				prepare: db.prepare.bind(db),
				batch: async (statements) => {
					if (!db.batch) throw new Error("Missing fixture batch");
					const results = await db.batch(statements);
					if (receipt === "lost") return [];
					return results.map(() =>
						receipt === "zero" ? { meta: { changes: 0 } } : { meta: { changes: "unknown" } },
					);
				},
			});
			// Act
			const pending = store.reviewJoinRequest(options);
			// Assert
			await expect(pending).rejects.toThrow(/^join_review_incomplete$/);
			expect(await f.rows("coordinator_join_requests")).toMatchObject([{ status: "approved" }]);
			expect(await f.rows("enrolled_devices")).toHaveLength(2);
			expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
		});
	}
}
function registerLostReplies(test: Test, database: (f: RevocationFixture) => D1DatabaseLike) {
	for (const authority of ["none", "ID", "key", "revocation"] as const) {
		test(`committed batch loses reply after ${authority}: report incomplete, never denial or rollback`, async ({
			fixture: f,
		}) => {
			// Arrange: the real approval commits; only its transport reply is lost afterwards.
			const { options, seed, request } = await pendingJoin(f);
			const db = database(f);
			let committed: unknown[][] = [];
			const store = new D1CoordinatorStore({
				prepare: db.prepare.bind(db),
				batch: async (statements) => {
					if (!db.batch) throw new Error("Missing fixture batch");
					await db.batch(statements);
					committed = await joinSnapshot(f);
					if (authority === "ID" || authority === "key") await bind(f, authority);
					if (authority === "revocation")
						await f.store.createDeviceRevocation({ ...f.input, fingerprint: request.fingerprint });
					throw new Error("reply lost");
				},
			});
			// Act
			const pending = store.reviewJoinRequest(options);
			// Assert: subsequent authority cannot turn committed history into a definitive 403.
			await expect(pending).rejects.toThrow(/^join_review_incomplete$/);
			expect((await joinSnapshot(f)).slice(0, 3)).toEqual(committed.slice(0, 3));
			expect(await f.rows("coordinator_join_requests")).toMatchObject([
				{ status: "approved", reviewed_by: options.reviewedBy, reviewed_at: JOIN_NOW },
			]);
			expect(await f.store.getEnrollment(f.input.groupId, f.input.deviceId, true)).toMatchObject({
				enabled: 1,
				public_key: f.input.publicKey,
				fingerprint: request.fingerprint,
			});
			expect(await f.rows("coordinator_bootstrap_grants")).toEqual([
				{
					grant_id: expect.any(String),
					group_id: f.input.groupId,
					seed_device_id: seed.deviceId,
					worker_device_id: f.input.deviceId,
					expires_at: options.bootstrapGrant?.expiresAt,
					created_at: JOIN_NOW,
					created_by: options.bootstrapGrant?.createdBy,
					revoked_at: null,
				},
			]);
			expect(await f.rows(OWNERSHIP_TABLE)).toHaveLength(
				Number(authority === "ID" || authority === "key"),
			);
			expect(await f.rows("coordinator_device_revocations")).toHaveLength(
				authority === "revocation" ? 2 : 0,
			);
		});
	}
}
function registerConcurrentWinner(test: Test, database: (f: RevocationFixture) => D1DatabaseLike) {
	for (const approved of [true, false]) {
		test(`same-timestamp ${approved ? "approval" : "denial"} winner cannot re-enroll under wrong caller`, async ({
			fixture: f,
		}) => {
			// Arrange: winner commits with the same timestamp but another actor, then loses enrollment.
			const { options } = await pendingJoin(f);
			let called = false;
			let atGate: unknown[][] = [];
			const racing = recipientGuardedD1(database(f), async (writes, phase) => {
				if (
					called ||
					phase !== "batch" ||
					!writes.some((w) => w.query.includes("UPDATE coordinator_join_requests"))
				)
					return;
				called = true;
				await f.store.reviewJoinRequest({ ...options, approved, reviewedBy: "winner-actor" });
				if (approved) await f.store.removeDevice(f.input.groupId, f.input.deviceId);
				await bind(f, "ID");
				atGate = await ownedJoinSnapshot(f);
			});
			// Act
			const result = await racing.reviewJoinRequest({ ...options, reviewedBy: "wrong-caller" });
			// Assert: even missing winner effects never authorize a loser's repair.
			expect(result).toMatchObject({
				status: approved ? "approved" : "denied",
				reviewed_by: "winner-actor",
				reviewed_at: JOIN_NOW,
				_no_transition: true,
			});
			expect(called).toBe(true);
			expect(await ownedJoinSnapshot(f)).toEqual(atGate);
		});
	}
}
function malformedOwnershipDb(db: D1DatabaseLike, decision: unknown): D1DatabaseLike {
	const wrap = (statement: D1PreparedStatementLike): D1PreparedStatementLike =>
		new Proxy(statement, {
			get(target, property) {
				if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
				if (property === "first") return async () => decision;
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	return {
		prepare: (query) => (/AS owned\b/i.test(query) ? wrap(db.prepare(query)) : db.prepare(query)),
		batch: db.batch?.bind(db),
	};
}
function registerOwnershipUnavailable(
	test: Test,
	database: (f: RevocationFixture) => D1DatabaseLike,
) {
	for (const decision of [{ revoked: 0, owned: "0" }, {}]) {
		test(`malformed owned receipt ${JSON.stringify(decision)} denies without writes`, async ({
			fixture: f,
		}) => {
			// Arrange: corrupt only the adapter's decision receipt, never the actual ledger or writes.
			const { options } = await pendingJoin(f);
			const before = await ownedJoinSnapshot(f);
			const store = new D1CoordinatorStore(malformedOwnershipDb(database(f), decision));
			// Act
			const pending = store.reviewJoinRequest(options);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
			expect(await ownedJoinSnapshot(f)).toEqual(before);
		});
	}
	test("ledger lost at batch returns private unavailable without writes", async ({
		fixture: f,
	}) => {
		// Arrange: the disposable fixture ledger disappears after successful preflight.
		const { options } = await pendingJoin(f);
		const before = await joinSnapshot(f);
		let dropped = false;
		const store = recipientGuardedD1(database(f), async (_writes, phase) => {
			if (dropped || phase !== "batch") return;
			dropped = true;
			await f.exec(`DROP TABLE ${OWNERSHIP_TABLE}`);
		});
		// Act
		const pending = store.reviewJoinRequest(options);
		// Assert: exact error forbids table names and SQL diagnostics; missing ledger is excluded.
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
		expect(dropped).toBe(true);
		expect(await joinSnapshot(f)).toEqual(before);
	});
	test("real revocation precedes unavailable ownership ledger", async ({ fixture: f }) => {
		// Arrange
		const { options } = await pendingJoin(f);
		await f.store.enrollDevice(f.input.groupId, f.input);
		await f.store.createDeviceRevocation(f.input);
		await f.exec(`DROP TABLE ${OWNERSHIP_TABLE}`);
		const before = await joinSnapshot(f);
		// Act
		const pending = f.store.reviewJoinRequest(options);
		// Assert
		await expect(pending).rejects.toThrow(/^device_revoked$/);
		expect(await joinSnapshot(f)).toEqual(before);
	});
}
