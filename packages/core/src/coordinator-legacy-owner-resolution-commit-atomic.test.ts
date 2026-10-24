import { afterEach, beforeEach, expect, vi } from "vitest";
import { backendTest, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { review as ordinaryReview } from "./coordinator-auth-store-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
	controllerTable,
	now,
	originalController,
	resolutionTable,
	revoke,
	seed,
	signer,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

function isReceiptWinner(sql: string, table: string): boolean {
	const insert = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)`).exec(sql);
	if (!insert) return false;
	const columns = insert[1]?.split(",").map((column) => column.trim()) ?? [];
	if (table === controllerTable) {
		return (
			columns.length === 13 &&
			columns.includes("enrollment_identity_id") &&
			columns.includes("revoked_at")
		);
	}
	// The resolution assertion also lists all 20 columns, but inserts constants.
	// Only the actual receipt winner reads its JSON-bound row from this single-row source.
	return (
		columns.length === 20 &&
		/SELECT json_extract\(value,/.test(sql) &&
		/FROM \(SELECT \? AS value\)\s*$/.test(sql)
	);
}

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	for (const [label, mutation] of [
		["history", "UPDATE coordinator_legacy_team_completions SET created_at='changed'"],
		["request group", "UPDATE groups SET archived_at='changed' WHERE group_id='group-a'"],
		[
			"key text",
			"UPDATE enrolled_devices SET public_key=public_key || ' changed' WHERE device_id='current-laptop'",
		],
		["link generation", "UPDATE coordinator_auth_account_links SET created_at_ms=created_at_ms+1"],
		["link disconnect", "DELETE FROM coordinator_auth_account_links"],
		["link revocation", `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW + 1}`],
		["birth provenance", "UPDATE coordinator_auth_link_attempts SET account_subject='changed'"],
		[
			"unclassified enrollment",
			"UPDATE enrolled_devices SET identity_id='unknown-c' WHERE device_id='current-laptop'",
		],
	] as const) {
		test(`${kind} late ${label} change immediately before backend.batch aborts every sibling write`, async ({
			fixture: f,
		}) => {
			// Arrange: mutate after all async preflight reads, at the actual batch boundary.
			const h = backendFor(f, kind);
			await seed(f, h);
			const review = await buildReview(f);
			let injected: ReturnType<typeof snapshot> | undefined;
			h.hooks.beforeBatch = () => {
				f.db.exec(mutation);
				injected = snapshot(f);
			};
			// Act / Assert
			await expect(
				commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
			).rejects.toThrow();
			expect(injected).toBeDefined();
			expect(snapshot(f)).toEqual(injected);
		});
	}
	for (const subject of ["device_id", "ed25519_key"] as const) {
		test(`${kind} actual current ${subject} revocation denies all writes`, async ({
			fixture: f,
		}) => {
			// Arrange
			const h = backendFor(f, kind);
			await seed(f, h);
			const review = await buildReview(f);
			await revoke(f, subject);
			const before = snapshot(f);
			// Act / Assert
			await expect(
				commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
			).rejects.toThrow();
			expect(snapshot(f)).toEqual(before);
		});
	}
	for (const family of ["device", "canonical key"] as const) {
		test(`${kind} real strong B controller for same ${family} cannot be overridden by consent`, async ({
			fixture: f,
		}) => {
			// Arrange: actual store-created authority, not a mocked classification result.
			const h = backendFor(f, kind);
			await seed(f, h);
			const input = await buildReview(f);
			await f.store.createGroup("strong-b");
			const b = {
				...signer,
				deviceId: family === "device" ? signer.deviceId : "alias-device",
				publicKey: family === "device" ? CANONICAL_PUBLIC_KEY : `${signer.publicKey} B-alias`,
			};
			await f.store.enrollDevice("strong-b", b);
			expect(
				await f.store.createAuthControllerAttestation(
					ordinaryReview({
						...b,
						groupId: "strong-b",
						identityId: "identity-b",
						attestationId: "strong-b",
					}),
				),
			).toMatchObject({ kind: "created" });
			const before = snapshot(f);
			// Act / Assert
			await expect(
				commitReviewedOwnerResolution({
					backend: h.backend,
					evidence: h.evidence,
					review: input,
					now,
				}),
			).rejects.toThrow();
			expect(snapshot(f)).toEqual(before);
		});
	}
	for (const winner of [controllerTable, resolutionTable]) {
		test(`${kind} actual zero-row ${winner} insert rolls back the whole batch`, async ({
			fixture: f,
		}) => {
			// Arrange: preserve bindings and execute SQL that changes zero real rows.
			// Suppress only the actual winner; leave schema guards and native changes() intact.
			const h = backendFor(f, kind);
			await seed(f, h);
			const review = await buildReview(f);
			let suppressed = 0;
			f.db.function("record_suppressed_winner", () => {
				suppressed++;
				return 0;
			});
			h.hooks.mapStatement = (statement) => {
				if (!isReceiptWinner(statement.sql, winner)) return statement;
				const conjunction = winner === controllerTable ? "AND" : "WHERE";
				return {
					...statement,
					sql: `${statement.sql} ${conjunction} record_suppressed_winner()=1`,
				};
			};
			const before = snapshot(f);
			// Act / Assert: never reinterpret zero rows as successful reuse.
			await expect(
				commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
			).rejects.toThrow();
			expect(h.batchCount()).toBe(1);
			expect(suppressed).toBe(1);
			expect(snapshot(f)).toEqual(before);
		});
	}
	test(`${kind} late source receipt mutation invalidates reuse without writing a resolution`, async ({
		fixture: f,
	}) => {
		// Arrange: the ordinary source is valid during review and async preflight.
		const h = backendFor(f, kind);
		await seed(f, h);
		const original = await originalController(f);
		const review = await buildReview(f, { existingController: original });
		let injected: ReturnType<typeof snapshot> | undefined;
		h.hooks.beforeBatch = () => {
			f.db
				.prepare(`UPDATE ${controllerTable} SET review_receipt_id=? WHERE attestation_id=?`)
				.run("late-receipt", original.attestation_id);
			injected = snapshot(f);
		};
		// Act / Assert
		await expect(
			commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
		).rejects.toThrow();
		expect(injected).toBeDefined();
		expect(snapshot(f)).toEqual(injected);
	});
	test(`${kind} resolution insert failure rolls back new controller and preserves an old immutable source`, async ({
		fixture: f,
	}) => {
		// Arrange: unrelated original source must survive the failed new operation.
		const h = backendFor(f, kind);
		await seed(f, h);
		const original = await originalController(f, "retained-source");
		const review = await buildReview(f);
		let failedWrites = 0;
		let newControllerVisible = false;
		f.db.function("fail_resolution_write", (sourceControllerCount: unknown) => {
			failedWrites++;
			newControllerVisible = sourceControllerCount === 1;
			throw new Error("synthetic resolution failure");
		});
		h.hooks.mapStatement = (statement) => {
			if (!isReceiptWinner(statement.sql, resolutionTable)) return statement;
			return {
				...statement,
				sql: `${statement.sql} WHERE fail_resolution_write((SELECT count(*) FROM ${controllerTable}
					WHERE attestation_id=json_extract(value,'$.source_attestation_id')))=1`,
			};
		};
		const before = snapshot(f);
		// Act / Assert
		await expect(
			commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
		).rejects.toThrow();
		expect(failedWrites).toBe(1);
		expect(newControllerVisible).toBe(true);
		expect(snapshot(f)).toEqual(before);
		expect(
			f.db
				.prepare(`SELECT * FROM ${controllerTable} WHERE attestation_id=?`)
				.get(original.attestation_id),
		).toEqual(original);
	});
	test(`${kind} failed postcommit read throws but reports no false rollback`, async ({
		fixture: f,
	}) => {
		// Arrange: fail only reads after an actual successful atomic batch.
		const h = backendFor(f, kind);
		await seed(f, h);
		const review = await buildReview(f);
		const before = snapshot(f, [controllerTable, resolutionTable]);
		h.hooks.afterBatch = () => {
			h.hooks.beforeFirst = () => {
				throw new Error("synthetic postcommit read failure");
			};
		};
		// Act / Assert: persistence errors propagate; the committed DB is the oracle.
		await expect(
			commitReviewedOwnerResolution({ backend: h.backend, evidence: h.evidence, review, now }),
		).rejects.toThrow();
		expect(f.db.prepare(`SELECT * FROM ${controllerTable}`).all()).toHaveLength(1);
		expect(f.db.prepare(`SELECT * FROM ${resolutionTable}`).all()).toHaveLength(1);
		expect(snapshot(f, [controllerTable, resolutionTable])).toEqual(before);
	});
	test(`${kind} all stored source fields are pinned rather than comparing only owner and canonical key`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		const original = await originalController(f);
		const input = await buildReview(f, { existingController: original });
		const before = snapshot(f);
		// Act / Assert: one isolated forged pin at a time; no changes after each denial.
		for (const field of Object.keys(original) as (keyof typeof original)[]) {
			const changed = {
				...original,
				[field]: original[field] === null ? "not-null" : `different-${original[field]}`,
			};
			await expect(
				commitReviewedOwnerResolution({
					backend: h.backend,
					evidence: h.evidence,
					review: { ...input, existingController: changed },
					now,
				}),
			).rejects.toThrow();
			expect(snapshot(f), field).toEqual(before);
		}
	});
}
