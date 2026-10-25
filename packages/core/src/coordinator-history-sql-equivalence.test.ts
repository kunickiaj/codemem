import { afterEach, beforeEach, expect, vi } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	captureHistorySql,
	compareHistorySql,
	historyCases,
	referenceHistorySql,
} from "./coordinator-history-sql-equivalence-test-fixtures.js";
import {
	captureLegacyCompletionOwnerProof,
	legacyCompletionOwnerProofSql,
} from "./coordinator-legacy-completion-owner-proof.js";
import { legacyOwnerKeyMetadata } from "./coordinator-legacy-owner-compatibility.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
	history,
	now,
	seed,
	signer,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical } from "./coordinator-legacy-team-completion.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

async function fixture(f: LinkFixture, options: { many?: boolean } = {}) {
	const h = backendFor(f, "SQLite");
	await seed(f, h);
	await commitReviewedOwnerResolution({
		backend: h.backend,
		evidence: h.evidence,
		review: await buildReview(f),
		now,
	});
	history(f, "requested", "identity-a");
	const stored = f.db
		.prepare(
			"SELECT manifest_json FROM coordinator_legacy_team_completions WHERE group_id='requested'",
		)
		.get() as { manifest_json: string };
	const value = JSON.parse(stored.manifest_json);
	value.candidate_ref = legacyTeamCandidateId(f.cfg.coordinatorId, signer.groupId);
	value.team_id = deterministicPolicyTeamId(value.candidate_ref);
	value.device_decisions[0].key_fingerprint = fingerprintPublicKey(signer.publicKey);
	f.db
		.prepare("UPDATE enrolled_devices SET fingerprint=? WHERE group_id=? AND device_id=?")
		.run(fingerprintPublicKey(signer.publicKey), signer.groupId, signer.deviceId);
	if (options.many) {
		// Key collisions intentionally make every real requested enrollment active;
		// this does not fabricate approvals or grant the extra devices authority.
		for (const deviceId of [
			"1",
			"0",
			"true",
			"null",
			...Array.from({ length: 28 }, (_, i) => `additional-${i}`),
		]) {
			await f.store.enrollDevice(signer.groupId, {
				...signer,
				deviceId,
				fingerprint: fingerprintPublicKey(signer.publicKey),
			});
			value.device_decisions.push({ ...value.device_decisions[0], device_id: deviceId });
		}
	}
	const backend = {
		async all<T>({ sql, values }: AuthLinkStatement) {
			return f.db.prepare(sql).all(...values) as T[];
		},
		async first<T>({ sql, values }: AuthLinkStatement) {
			return (f.db.prepare(sql).get(...values) as T | undefined) ?? null;
		},
	};
	const input = {
		groupId: signer.groupId,
		manifestJson: canonical(value),
		keyMetadata: await legacyOwnerKeyMetadata(
			f.db
				.prepare("SELECT DISTINCT public_key FROM enrolled_devices ORDER BY public_key")
				.all() as { public_key: string }[],
		),
	};
	return { backend, input, captured: await captureHistorySql(backend, input) };
}

const test = backendTest("SQLite");
test("SQLite captured selectors preserve raw rows, order, scalar types and conservative malformed discovery", async ({
	fixture: f,
}) => {
	// Arrange: parameters come from the actual accepted receipt/capture workflow.
	const { backend, captured } = await fixture(f);
	const cases = historyCases(captured.statement);
	f.db.prepare("DELETE FROM coordinator_legacy_team_completions").run();
	for (const [index, row] of cases.entries()) {
		f.db
			.prepare(
				"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,completed_at,created_at,manifest_json) VALUES (?,?,1,?,?,?)",
			)
			.run(`case-${index}`, `candidate-${index}`, now, now, row.raw);
	}
	// Act: compare the entire bounded capture statement, not a hand-built CTE.
	const result = await compareHistorySql(backend, captured.statement);
	// Assert: exact strings/order above, plus independently expected membership/bytes.
	expect(result).not.toHaveProperty("error");
	const rows = result.rows ?? [];
	expect(rows).toHaveLength(cases.filter((row) => row.selected).length);
	for (const [index, row] of cases.entries()) {
		const selected = rows.find((item) => JSON.parse(item.row)[0] === `case-${index}`);
		expect(Boolean(selected), row.name).toBe(row.selected);
		if (selected) expect(JSON.parse(selected.row)[5], row.name).toBe(row.raw);
	}
});

test("SQLite many genuine requested subjects retain cross-subject collisions and numeric/text distinctions", async ({
	fixture: f,
}) => {
	// Arrange: genuine capture encodes all 33 enrolled devices, no edited snapshot.
	const { backend, captured } = await fixture(f, { many: true });
	const snapshot = JSON.parse(String(captured.statement.values[0]));
	expect(snapshot.subjects).toHaveLength(33);
	expect(snapshot.active).toHaveLength(33);
	f.db.prepare("DELETE FROM coordinator_legacy_team_completions").run();
	const cases = [
		{ name: "numeric", decision: { device_id: 1, key_fingerprint: "unrelated" }, selected: false },
		{ name: "text", decision: { device_id: "1", key_fingerprint: "unrelated" }, selected: true },
		{
			name: "boolean",
			decision: { device_id: true, key_fingerprint: "unrelated" },
			selected: false,
		},
		{
			name: "boolean-text",
			decision: { device_id: "true", key_fingerprint: "unrelated" },
			selected: true,
		},
		{ name: "null", decision: { device_id: null, key_fingerprint: "unrelated" }, selected: false },
		{
			name: "null-text",
			decision: { device_id: "null", key_fingerprint: "unrelated" },
			selected: true,
		},
		{
			name: "last-device",
			decision: { device_id: "additional-27", key_fingerprint: "unrelated" },
			selected: true,
		},
	];
	for (const row of cases) {
		f.db
			.prepare(
				"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,completed_at,created_at,manifest_json) VALUES (?,?,1,?,?,?)",
			)
			.run(
				row.name,
				row.name,
				now,
				now,
				JSON.stringify({ coordinator_id: f.cfg.coordinatorId, device_decisions: [row.decision] }),
			);
	}
	// Act
	const result = await compareHistorySql(backend, captured.statement);
	// Assert
	expect(result).not.toHaveProperty("error");
	for (const row of cases)
		expect(
			result.rows?.some((item) => JSON.parse(item.row)[0] === row.name),
			row.name,
		).toBe(row.selected);
});

test("SQLite empty active projection selects nothing despite plausible malformed histories", async ({
	fixture: f,
}) => {
	// Arrange: projection-only variant; never submitted as a proof or writer input.
	const { backend, captured } = await fixture(f);
	const snapshot = JSON.parse(String(captured.statement.values[0]));
	const statement = {
		...captured.statement,
		values: [JSON.stringify({ ...snapshot, active: [] })],
	};
	// Act
	const result = await compareHistorySql(backend, statement);
	// Assert
	expect(result).toEqual({ rows: [] });
});

test("SQLite live winning history pin rejects a raw-byte change after capture", async ({
	fixture: f,
}) => {
	// Arrange
	const { captured } = await fixture(f);
	expect(await captured.current()).toEqual({ current: 1 });
	expect(await captured.current({ reference: true })).toEqual({ current: 1 });
	f.db
		.prepare(
			"UPDATE coordinator_legacy_team_completions SET manifest_json=manifest_json || ' ' WHERE group_id='requested'",
		)
		.run();
	// Act
	const current = await captured.current();
	const original = await captured.current({ reference: true });
	// Assert: semantically equal JSON still changes the pinned raw evidence.
	expect(current).toEqual({ current: 0 });
	expect(current).toEqual(original);
});

test("SQLite malformed plausible history retains the same fail-closed capture result", async ({
	fixture: f,
}) => {
	// Arrange
	const { backend, input } = await fixture(f);
	f.db
		.prepare(
			"UPDATE coordinator_legacy_team_completions SET manifest_json=? WHERE group_id='requested'",
		)
		.run(`{"device_decisions":[${JSON.stringify(signer.deviceId)}],`);
	const before = snapshot(f);
	// Act
	const current = legacyCompletionOwnerProofSql(
		await captureLegacyCompletionOwnerProof({ backend, ...input }),
	);
	const old = legacyCompletionOwnerProofSql(
		await captureLegacyCompletionOwnerProof({
			...input,
			backend: {
				...backend,
				all: <T>(s: AuthLinkStatement) =>
					backend.all<T>({
						...s,
						sql: s.sql.includes("AS row FROM coordinator_legacy_team_completions c")
							? referenceHistorySql(s.sql)
							: s.sql,
					}),
			},
		}),
	);
	const requested = JSON.parse(input.manifestJson);
	const result = async () => {
		try {
			return await f.store.createLegacyTeamCompletion(signer.groupId, requested);
		} catch (error) {
			return String(error);
		}
	};
	const currentError = await result();
	const prepare = f.db.prepare.bind(f.db);
	vi.spyOn(f.db, "prepare").mockImplementation((sql: string) =>
		prepare(
			sql.includes("AS row FROM coordinator_legacy_team_completions c")
				? referenceHistorySql(sql)
				: sql,
		),
	);
	const originalError = await result();
	// Assert
	expect(current).toEqual(old);
	expect(current).toEqual({ ctes: "", currentSql: "0", compatibleSql: "0", values: [] });
	expect(currentError).toEqual(originalError);
	expect(currentError).toMatch(/completion_(?:conflict|manifest_unavailable)/u);
	expect(snapshot(f)).toEqual(before);
});

test("SQLite history uses statement-local membership sets while malformed fallbacks stay correlated", async ({
	fixture: f,
}) => {
	// Arrange
	const { captured } = await fixture(f);
	// Act
	const sql = captured.statement.sql;
	const baseline = referenceHistorySql(sql);
	// Assert: deterministic shape checks, no elapsed-time threshold or global JSON spy.
	expect(sql.match(/completion_proof_fingerprints\(fingerprint\) AS MATERIALIZED/gu)).toHaveLength(
		1,
	);
	expect(sql).toContain("IN (SELECT fingerprint FROM completion_proof_fingerprints)");
	expect(sql).toContain("IN (SELECT deviceId FROM completion_proof_active)");
	expect(sql).toContain("AND EXISTS (SELECT 1 FROM completion_proof_active s WHERE");
	expect(baseline).toContain("SELECT 1 FROM completion_proof_active s\n WHERE (json_extract");
	expect(baseline).not.toContain("IN (SELECT fingerprint FROM completion_proof_fingerprints)");
	expect(() => referenceHistorySql("SELECT 1")).toThrow("history selector not observed");
});
