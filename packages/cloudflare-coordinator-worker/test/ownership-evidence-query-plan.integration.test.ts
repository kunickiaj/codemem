import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	captureControllerHistory,
	controllerHistoryDiscoveryFragments,
} from "../../core/src/coordinator-auth-controller-history.js";
import {
	type CapturedEvidenceRow,
	readCombinedEvidenceQuery,
} from "../../core/src/coordinator-device-ownership-evidence-queries.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { resetCeremony } from "./owner-ceremony-test-fixtures.js";

const db = env.COORDINATOR_DB;
const subject = {
	coordinatorId: "query-plan-coordinator",
	groupId: "query-plan-group",
	deviceId: "query-plan-device",
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: "a".repeat(64),
	keyId: EXPECTED_KEY_ID,
	fragments: controllerHistoryDiscoveryFragments(CANONICAL_PUBLIC_KEY),
};

async function seedControllers(count: number) {
	await db.prepare("DELETE FROM coordinator_auth_controller_attestations").run();
	if (!count) return;
	await db
		.prepare(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n < ?)
		 INSERT INTO coordinator_auth_controller_attestations
		 (attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,
		 review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at)
		 SELECT 'attestation-'||n,?,'owner','retained-'||n,?,?,?,
		 'receipt-'||n,?,'owner',1,'2026-10-01T00:00:00.000Z',NULL FROM ids`)
		.bind(
			count,
			subject.coordinatorId,
			subject.deviceId,
			subject.publicKey,
			subject.fingerprint,
			"b".repeat(64),
		)
		.run();
}

async function capture() {
	const legacyHistory = await captureControllerHistory(
		subject,
		async <T>(sql: string, values: string[]) =>
			(
				await db
					.prepare(sql)
					.bind(...values)
					.all<T>()
			).results,
	);
	const statement = readCombinedEvidenceQuery(JSON.stringify({ subject, legacyHistory }));
	return db
		.prepare(statement.sql)
		.bind(...statement.values)
		.all<CapturedEvidenceRow>();
}

beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await resetCeremony();
	await db.prepare("DELETE FROM coordinator_invites").run();
	await db.prepare("DELETE FROM coordinator_legacy_team_completions").run();
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

it("native combined evidence doubles row reads linearly across two populated categories", async () => {
	// Arrange: each controller contributes a discovery row as well as its full evidence row.
	await seedControllers(250);
	const half = await capture();
	await seedControllers(500);
	// Act
	const full = await capture();
	// Assert: native work counters detect nested scans without a wall-clock deadline.
	for (const [result, count] of [
		[half, 250],
		[full, 500],
	] as const) {
		for (const category of ["discovery", "controllers"]) {
			const rows = result.results.filter((row) => row.category === category);
			expect(rows).toHaveLength(count);
			expect(rows.every((row) => row.row_count === count && row.row !== null)).toBe(true);
		}
	}
	expect(half.meta.rows_read).toBeGreaterThan(0);
	expect(full.meta.rows_read).toBeLessThan(half.meta.rows_read * 2.5);
});

it.each([0, 501])(
	"native combined evidence preserves empty or overflow markers with %i controllers",
	async (count) => {
		// Arrange
		await seedControllers(count);
		// Act
		const { results } = await capture();
		// Assert: overflow remains visible to the caller rather than truncating at the accepted 500 rows.
		for (const category of ["discovery", "controllers"]) {
			const rows = results.filter((row) => row.category === category);
			expect(rows).toHaveLength(Math.max(1, count));
			expect(rows.every((row) => row.row_count === count)).toBe(true);
			expect(rows.every((row) => (row.row === null) === (count === 0))).toBe(true);
		}
	},
);
