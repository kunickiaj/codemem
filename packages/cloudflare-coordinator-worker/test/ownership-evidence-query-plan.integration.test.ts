import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	captureControllerHistory,
	controllerHistoryDiscoveryFragments,
} from "../../core/src/coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { readSnapshot } from "../../core/src/coordinator-auth-read-set.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import {
	discoveredReads,
	evidenceReads,
} from "../../core/src/coordinator-owner-negative-reads.js";
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

/** The evidence read set, natively: every category's rows and the rows D1 read for them. */
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
	let rowsRead = 0;
	const backend = {
		first: <T>({ sql, values }: AuthLinkStatement) =>
			db
				.prepare(sql)
				.bind(...values)
				.first<T>(),
		readBatch: async <T>(statements: AuthLinkStatement[]) => {
			const results = await db.batch(
				statements.map(({ sql, values }) => db.prepare(sql).bind(...values)),
			);
			rowsRead += results.reduce((sum, result) => sum + result.meta.rows_read, 0);
			return results.map((result) => (result.results ?? []) as T[]);
		},
	};
	type Rows = Record<string, (string | null)[]>;
	const first = await readSnapshot<Rows>(backend, evidenceReads({ subject, history: legacyHistory }));
	const ids = (first.rows.discovery ?? []).flatMap((row) =>
		row === null ? [] : [JSON.parse(row) as [string, string]],
	);
	const next = await readSnapshot<Rows>(
		backend,
		discoveredReads(subject, {
			controllers: ids.filter(([source]) => source === "controller").map(([, id]) => id),
			invites: ids.filter(([source]) => source === "invite").map(([, id]) => id),
		}),
	);
	return { rows: { ...first.rows, ...next.rows } as Rows, rowsRead };
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

it("native evidence reads double row reads linearly across two populated categories", async () => {
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
			const rows = result.rows[category] ?? [];
			expect(rows).toHaveLength(count);
			expect(rows.every((row) => row !== null)).toBe(true);
		}
	}
	expect(half.rowsRead).toBeGreaterThan(0);
	expect(full.rowsRead).toBeLessThan(half.rowsRead * 2.5);
});

it.each([0, 501])(
	"native evidence reads keep empty or overflowing categories visible with %i controllers",
	async (count) => {
		// Arrange
		await seedControllers(count);
		// Act
		const { rows } = await capture();
		// Assert: overflow remains visible to the caller rather than truncating at the accepted 500 rows.
		for (const category of ["discovery", "controllers"]) {
			expect(rows[category]).toHaveLength(count);
			expect(rows[category]?.every((row) => row !== null)).toBe(true);
		}
	},
);
