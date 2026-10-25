import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import {
	captureHistorySql,
	compareHistorySql,
	historyCases,
	referenceHistorySql,
} from "../../core/src/coordinator-history-sql-equivalence-test-fixtures.js";
import {
	captureLegacyCompletionOwnerProof,
	legacyCompletionOwnerProofSql,
} from "../../core/src/coordinator-legacy-completion-owner-proof.js";
import { legacyOwnerKeyMetadata } from "../../core/src/coordinator-legacy-owner-compatibility.js";
import { canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical } from "../../core/src/coordinator-legacy-team-completion.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import {
	completions,
	db,
	exec,
	fullRecoveredRoster,
	futureGroup,
	insert,
	recovery,
	reset,
	signer,
	state,
	timestamp,
} from "./legacy-completion-owner-proof-test-fixtures.js";

// DO NOT MERGE: branch-only stage evidence, never SQL, bound values or proof data.
let traceFull = false;
let traceStart = 0;
let traceEvent = 0;
let comparisonCall = 0;
type FullStage =
	| "reset-start"
	| "reset-ready"
	| "roster-start"
	| "roster-ready"
	| "metadata-start"
	| "metadata-ready"
	| "capture-start"
	| "capture-ready"
	| "comparison-start"
	| "comparison-ready"
	| "reference-selector-start"
	| "reference-selector-ready"
	| "current-selector-start"
	| "current-selector-ready"
	| "current-before-start"
	| "current-before-ready"
	| "reference-before-start"
	| "reference-before-ready"
	| "mutation-start"
	| "mutation-ready"
	| "current-after-start"
	| "current-after-ready"
	| "reference-after-start"
	| "reference-after-ready";
function traceFullStage(stage: FullStage) {
	if (!traceFull) return;
	// workerd has no node:fs stderr; console output is forwarded by the native pool.
	console.error(
		"[history-full500-stage]",
		JSON.stringify({
			stage,
			case: "native-full500",
			event: ++traceEvent,
			elapsedMs: Math.round((performance.now() - traceStart) * 10) / 10,
		}),
	);
}
const backend = {
	async all<T>({ sql, values }: AuthLinkStatement) {
		const call = comparisonCall;
		if (call > 0) comparisonCall += 1;
		if (call === 1) traceFullStage("reference-selector-start");
		if (call === 2) traceFullStage("current-selector-start");
		const results = (
			await db
				.prepare(sql)
				.bind(...values)
				.all<T>()
		).results;
		if (call === 1) traceFullStage("reference-selector-ready");
		if (call === 2) traceFullStage("current-selector-ready");
		return results;
	},
	async first<T>({ sql, values }: AuthLinkStatement) {
		return db
			.prepare(sql)
			.bind(...values)
			.first<T>();
	},
};

beforeEach(async (context) => {
	traceFull = context.task.name.includes("full 500 genuine");
	traceStart = performance.now();
	traceEvent = 0;
	comparisonCall = 0;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	traceFullStage("reset-start");
	await reset();
	traceFullStage("reset-ready");
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture(options: { full?: boolean } = {}) {
	traceFullStage("roster-start");
	const seeded = options.full ? await fullRecoveredRoster() : await recovery();
	traceFullStage("roster-ready");
	if (!options.full) {
		await seeded.h.store.enrollDevice(futureGroup, {
			deviceId: "legacy-alias-inventory",
			publicKey: `${signer.publicKey} historical-comment`,
			fingerprint: "f".repeat(64),
		});
	}
	traceFullStage("metadata-start");
	const input = {
		groupId: futureGroup,
		manifestJson: canonical(seeded.value),
		keyMetadata: await legacyOwnerKeyMetadata(
			(
				await db
					.prepare("SELECT DISTINCT public_key FROM enrolled_devices ORDER BY public_key")
					.all<{ public_key: string }>()
			).results,
		),
	};
	traceFullStage("metadata-ready");
	traceFullStage("capture-start");
	const captured = await captureHistorySql(backend, input);
	traceFullStage("capture-ready");
	return { input, captured };
}

it("native D1 selectors retain exact raw rows/order across malformed, typed, collision and coordinator cases", async () => {
	// Arrange: native Miniflare D1 and genuine encoded capture parameters.
	const { captured } = await fixture();
	const cases = historyCases(captured.statement);
	expect(
		JSON.parse(String(captured.statement.values[0])).subjects[0].fingerprints.length,
	).toBeGreaterThan(1);
	await exec(`DELETE FROM ${completions}`);
	for (const [index, row] of cases.entries()) {
		await insert(completions, {
			group_id: `case-${index}`,
			candidate_ref: `candidate-${index}`,
			manifest_version: 1,
			completed_at: timestamp,
			created_at: timestamp,
			manifest_json: row.raw,
		});
	}
	// Act
	const result = await compareHistorySql(backend, captured.statement);
	// Assert: equality is byte-for-byte and ordered, not parsed/canonicalized rows.
	expect(result).not.toHaveProperty("error");
	const rows = result.rows ?? [];
	expect(rows).toHaveLength(cases.filter((row) => row.selected).length);
	for (const [index, row] of cases.entries()) {
		const selected = rows.find((item) => JSON.parse(item.row)[0] === `case-${index}`);
		expect(Boolean(selected), row.name).toBe(row.selected);
		if (selected) expect(JSON.parse(selected.row)[5], row.name).toBe(row.raw);
	}
});

it("native D1 actual winning INSERT rejects a history change injected after capture", async () => {
	// Arrange: the existing harness injects immediately before the real INSERT run.
	const { h, value } = await recovery();
	h.arm(async () => {
		await exec(
			`UPDATE ${completions} SET manifest_json=manifest_json || ' ' WHERE group_id='history-A'`,
		);
	});
	// Act
	const pending = h.complete(value);
	// Assert: the append loses even though capture had validated the old bytes.
	await expect(pending).rejects.toThrow(/completion_(?:conflict|manifest_unavailable)/u);
	expect(h.injected()).toBe(true);
	expect(h.bindCount()).toBe(18);
	expect(
		await db
			.prepare(`SELECT group_id FROM ${completions} WHERE group_id=?`)
			.bind(futureGroup)
			.first(),
	).toBeNull();
});

it("native D1 empty-active projection rejects all history including plausible malformed rows", async () => {
	// Arrange: projection-only snapshot, never used as a writer capability.
	const { captured } = await fixture();
	await exec(
		`UPDATE ${completions} SET manifest_json=?`,
		`{"note":${JSON.stringify(signer.deviceId)},`,
	);
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

it("native D1 genuine numeric-looking subjects do not coerce numeric, boolean or null decisions into text matches", async () => {
	// Arrange: canonical requests and actual enrolled devices, not edited SQL input.
	const { h, value } = await recovery();
	for (const deviceId of ["1", "0", "true", "null"]) {
		await h.store.enrollDevice(futureGroup, { ...signer, deviceId });
		value.device_decisions.push({ ...value.device_decisions[0], device_id: deviceId });
	}
	const captured = await captureHistorySql(backend, {
		groupId: futureGroup,
		manifestJson: canonical(value),
		keyMetadata: await legacyOwnerKeyMetadata(
			(
				await db
					.prepare("SELECT DISTINCT public_key FROM enrolled_devices ORDER BY public_key")
					.all<{ public_key: string }>()
			).results,
		),
	});
	expect(JSON.parse(String(captured.statement.values[0])).active).toHaveLength(5);
	await exec(`DELETE FROM ${completions}`);
	const cases = [1, 0, true, null, "1", "0", "true", "null"];
	for (const [index, device] of cases.entries()) {
		await insert(completions, {
			group_id: `scalar-${index}`,
			candidate_ref: `scalar-${index}`,
			manifest_version: 1,
			completed_at: timestamp,
			created_at: timestamp,
			manifest_json: JSON.stringify({
				device_decisions: [{ device_id: device, key_fingerprint: "unrelated" }],
			}),
		});
	}
	// Act
	const result = await compareHistorySql(backend, captured.statement);
	// Assert
	expect(result).not.toHaveProperty("error");
	expect(result.rows).toHaveLength(4);
	for (const [index, device] of cases.entries())
		expect(result.rows?.some((row) => JSON.parse(row.row)[0] === `scalar-${index}`)).toBe(
			typeof device === "string",
		);
});

it("native D1 live winning history pin rejects a raw-byte change after capture", async () => {
	// Arrange
	const { captured } = await fixture();
	expect(await captured.current()).toEqual({ current: 1 });
	expect(await captured.current({ reference: true })).toEqual({ current: 1 });
	await exec(
		`UPDATE ${completions} SET manifest_json=manifest_json || ' ' WHERE group_id='history-A'`,
	);
	// Act
	const current = await captured.current();
	const old = await captured.current({ reference: true });
	// Assert: no cache can substitute the earlier capture for live SQL evidence.
	expect(current).toEqual({ current: 0 });
	expect(current).toEqual(old);
});

it("native D1 malformed plausible history keeps the original fail-closed capture result", async () => {
	// Arrange
	const { input } = await fixture();
	await exec(
		`UPDATE ${completions} SET manifest_json=? WHERE group_id='history-A'`,
		`{"device_decisions":[${JSON.stringify(signer.deviceId)}],`,
	);
	const before = await state();
	const originalStore = new D1CoordinatorStore(
		new Proxy(db, {
			get(target, key) {
				if (key === "prepare")
					return (sql: string) =>
						target.prepare(
							sql.includes("AS row FROM coordinator_legacy_team_completions c")
								? referenceHistorySql(sql)
								: sql,
						);
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	);
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
	const result = async (store: D1CoordinatorStore) => {
		try {
			return await store.createLegacyTeamCompletion(futureGroup, requested);
		} catch (error) {
			return String(error);
		}
	};
	const currentError = await result(new D1CoordinatorStore(db));
	const originalError = await result(originalStore);
	// Assert
	expect(current).toEqual(old);
	expect(current).toEqual({ ctes: "", currentSql: "0", compatibleSql: "0", values: [] });
	expect(currentError).toEqual(originalError);
	expect(currentError).toMatch(/completion_(?:conflict|manifest_unavailable)/u);
	expect(await state()).toEqual(before);
});

it("native D1 full 500 genuine writer-shaped subjects preserve ordered selector rows and live history rejection", async () => {
	// Arrange: existing authentic 500-key/500-owner/500-receipt fixture, unchanged.
	const { captured } = await fixture({ full: true });
	const snapshot = JSON.parse(String(captured.statement.values[0]));
	expect(snapshot.subjects).toHaveLength(500);
	expect(snapshot.active).toHaveLength(500);
	// Act
	traceFullStage("comparison-start");
	comparisonCall = 1;
	const selected = await compareHistorySql(backend, captured.statement);
	comparisonCall = 0;
	traceFullStage("comparison-ready");
	traceFullStage("current-before-start");
	const current = await captured.current();
	traceFullStage("current-before-ready");
	traceFullStage("reference-before-start");
	const old = await captured.current({ reference: true });
	traceFullStage("reference-before-ready");
	// Assert
	expect(selected.rows).toHaveLength(500);
	expect(current).toEqual({ current: 1 });
	expect(current).toEqual(old);
	expect(captured.statement.values).toHaveLength(1);
	expect(
		new TextEncoder().encode(String(captured.statement.values[0])).byteLength,
	).toBeLessThanOrEqual(2_000_000);
	// Act: the same generated winning predicate must reopen changed native D1 rows.
	traceFullStage("mutation-start");
	await exec(
		`UPDATE ${completions} SET manifest_json=manifest_json || ' ' WHERE group_id=(SELECT group_id FROM ${completions} ORDER BY group_id DESC LIMIT 1)`,
	);
	// Assert
	traceFullStage("mutation-ready");
	traceFullStage("current-after-start");
	expect(await captured.current()).toEqual({ current: 0 });
	traceFullStage("current-after-ready");
	traceFullStage("reference-after-start");
	expect(await captured.current({ reference: true })).toEqual({ current: 0 });
	traceFullStage("reference-after-ready");
});
