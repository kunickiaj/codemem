import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { otherKey } from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import { commitOwnerEnrollment } from "./coordinator-owner-enrollment-commit.js";
import type { CommitWriterFixture } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import { commitWriterFixture } from "./coordinator-owner-enrollment-historical-test-fixture.js";
import {
	beforeProducerWinningWrite,
	prepareProducerOwner,
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = it.extend<{ f: CommitWriterFixture }>({
		f: async ({ task: _task }, use) => {
			const f = await commitWriterFixture();
			const d1 = sqliteD1(f.db);
			const original = f.backend;
			const adapter = {
				...original,
				all: async <T>(s: AuthLinkStatement): Promise<T[]> =>
					f.db.prepare(s.sql).all(...s.values) as T[],
				first: async <T>(s: AuthLinkStatement) =>
					backend === "D1"
						? d1
								.prepare(s.sql)
								.bind(...s.values)
								.first<T>()
						: original.first<T>(s),
				batch: async (statements: AuthLinkStatement[]) => {
					if (backend === "SQLite") return original.batch(statements);
					if (!d1.batch) throw new Error("fixture batch missing");
					return d1.batch(statements.map((s) => d1.prepare(s.sql).bind(...s.values)));
				},
			};
			f.backend = adapter;
			try {
				await use(f);
			} finally {
				f.close();
			}
		},
	});
	function request(f: CommitWriterFixture) {
		return { ...f.input(), backend: f.backend };
	}
	function subject(f: CommitWriterFixture) {
		if (!f.row.identity_id) throw new Error("confirmed fixture identity missing");
		return {
			coordinatorId: f.row.coordinator_id,
			deviceId: f.row.device_id,
			publicKey: f.row.public_key,
			fingerprint: f.row.fingerprint,
			ownerIdentityId: f.row.identity_id,
		};
	}
	test(`${backend} owner enrollment rechecks same-owner original source at winning UPDATE`, async ({
		f,
	}) => {
		// Arrange: same-owner compatibility is not a substitute for an unrevoked original source.
		await retainProducerOwner(f.db, subject(f));
		let atWrite: ReturnType<typeof producerSnapshot> | undefined;
		const hook = beforeProducerWinningWrite(
			f.db,
			/UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'finalized'/,
			() => {
				f.db.exec(
					"UPDATE coordinator_auth_controller_attestations SET revoked_at='2026-10-01T00:00:00.000Z' WHERE attestation_id='producer-original-controller'",
				);
				atWrite = producerSnapshot(f.db);
			},
		);
		try {
			// Act
			const result = await commitOwnerEnrollment(request(f));
			// Assert
			expect(hook.observed()).toBe(true);
			expect(result).toBe(false);
			expect(producerSnapshot(f.db)).toEqual(atWrite);
		} finally {
			hook.restore();
		}
	});
	test(`${backend} owner enrollment pins empty subject facts at winning UPDATE`, async ({ f }) => {
		// Arrange: all canonical-key work completes before entering the atomic batch.
		const seed = await prepareProducerOwner(
			f.db,
			{ ...subject(f), ownerIdentityId: "owner-A" },
			{ removeSource: true },
		);
		let atWrite: ReturnType<typeof producerSnapshot> | undefined;
		const hook = beforeProducerWinningWrite(
			f.db,
			/UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'finalized'/,
			() => {
				seed();
				atWrite = producerSnapshot(f.db);
			},
		);
		try {
			// Act
			const result = await commitOwnerEnrollment(request(f));
			// Assert
			expect(hook.observed()).toBe(true);
			expect(result).toBe(false);
			expect(producerSnapshot(f.db)).toEqual(atWrite);
		} finally {
			hook.restore();
		}
	});
	for (const catalog of ["missing", "ready", "same owner", "foreign"] as const) {
		test(`${backend} owner enrollment preserves ${catalog} ordinary admission`, async ({ f }) => {
			// Arrange: the retained source is independent of the browser's historical account link.
			if (catalog === "missing")
				f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
			if (catalog === "ready") f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
			if (catalog === "same owner" || catalog === "foreign")
				await retainProducerOwner(f.db, {
					...subject(f),
					...(catalog === "foreign"
						? { coordinatorId: "foreign-coordinator", ownerIdentityId: "owner-A" }
						: {}),
				});
			const history = f.rows("coordinator_auth_account_links");
			// Act
			const result = await commitOwnerEnrollment(request(f));
			// Assert
			expect(result).toBe(true);
			expect(f.finalRow().state).toBe("finalized");
			expect(f.rows("coordinator_device_ownership_bindings")).toHaveLength(1);
			expect(f.rows("coordinator_auth_account_links")).toEqual(history);
		});
	}
	for (const match of ["device", "canonical key"] as const) {
		test(`${backend} owner enrollment cannot bind B over retained A by ${match}`, async ({ f }) => {
			// Arrange: a removed source must not erase retained collision history.
			await retainProducerOwner(
				f.db,
				{
					...subject(f),
					ownerIdentityId: "owner-A",
					publicKey: match === "device" ? otherKey : `${f.row.public_key} original-alias`,
				},
				{
					removeSource: true,
					resolutionDeviceId: match === "device" ? f.row.device_id : "old-device",
				},
			);
			const before = producerSnapshot(f.db);
			// Act
			const result = await commitOwnerEnrollment(request(f));
			// Assert: the confirmed attempt, bindings, grants, enrollments and audit stay unchanged.
			expect(result).toBe(false);
			expect(producerSnapshot(f.db)).toEqual(before);
		});
	}
	test(`${backend} same-owner resolution cannot bypass revoked current grant`, async ({ f }) => {
		// Arrange
		await retainProducerOwner(f.db, subject(f));
		f.db.exec(
			"UPDATE coordinator_identity_group_grants SET status='revoked',revoked_at='2026-10-01T00:00:00.000Z'",
		);
		const before = producerSnapshot(f.db);
		// Act
		const result = await commitOwnerEnrollment(request(f));
		// Assert
		expect(result).toBe(false);
		expect(producerSnapshot(f.db)).toEqual(before);
	});
	test(`${backend} owner enrollment rejects partial resolution catalog`, async ({ f }) => {
		// Arrange
		f.db.exec(
			"DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions; CREATE TABLE coordinator_legacy_owner_resolutions (device_id TEXT)",
		);
		const before = producerSnapshot(f.db);
		// Act
		const result = await commitOwnerEnrollment(request(f));
		// Assert
		expect(result).toBe(false);
		expect(producerSnapshot(f.db)).toEqual(before);
	});
	test(`${backend} owner enrollment pins missing catalog at winning UPDATE`, async ({ f }) => {
		// Arrange
		f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
		let atWrite: ReturnType<typeof producerSnapshot> | undefined;
		const hook = beforeProducerWinningWrite(
			f.db,
			/UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'finalized'/,
			() => {
				f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
				atWrite = producerSnapshot(f.db);
			},
		);
		try {
			// Act
			const result = await commitOwnerEnrollment(request(f));
			// Assert
			expect(hook.observed()).toBe(true);
			expect(result).toBe(false);
			expect(producerSnapshot(f.db)).toEqual(atWrite);
		} finally {
			hook.restore();
		}
	});
}
