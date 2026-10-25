import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type ControllerHistoryRecord,
	parseControllerHistoryRecord,
} from "./coordinator-auth-controller-history.js";
import type {
	EvidenceRow,
	EvidenceRows,
} from "./coordinator-device-ownership-evidence-classify.js";
import {
	prepareCompletionHistory,
	subjectHistory,
} from "./coordinator-legacy-completion-owner-proof.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const fingerprintOf = (value: string) => createHash("sha256").update(value).digest("hex");
const subject = {
	coordinatorId: "synthetic-coordinator",
	groupId: "future",
	deviceId: "device-a",
	publicKey: "synthetic-key",
	fingerprint: fingerprintOf("fp-a"),
	keyId: "key-a",
	owner: "owner-a",
	fragments: ["synthetic-fragment"],
	fingerprints: [fingerprintOf("fp-a")],
};
const columns = [
	"group_id",
	"candidate_ref",
	"manifest_version",
	"completed_at",
	"created_at",
	"manifest_json",
];
const now = "2026-01-01T00:00:00.000Z";
const keys = new Map([
	["alias-key", subject.keyId],
	["unrelated-key", "other-key"],
]);

function row(deviceId = subject.deviceId, fingerprint = subject.fingerprint): EvidenceRow {
	const manifest = normalize({
		version: 1,
		coordinator_id: subject.coordinatorId,
		candidate_ref: legacyTeamCandidateId(subject.coordinatorId, "history"),
		candidate_digest: "a".repeat(64),
		team_id: "team-history",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic history",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: "owner-a", role: "member" }],
		device_decisions: [
			{
				device_id: deviceId,
				key_fingerprint: fingerprint.length === 64 ? fingerprint : fingerprintOf(fingerprint),
				enabled: true,
				identity_id: "owner-a",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: now,
	});
	return ["history", manifest.candidate_ref, 1, now, now, canonical(manifest)];
}

function raw(text: string): EvidenceRow {
	const result = row();
	result[5] = text;
	return result;
}

// Frozen pre-optimization partition: raw rows, not constructed records, consume
// the first byte budget. Keep this independent of the new preparation helper.
function original(rows: EvidenceRows, target = subject) {
	const requireProof = (condition: unknown) => {
		if (!condition) throw new Error("completion_manifest_unavailable");
	};
	const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
	const record = (r: EvidenceRow) =>
		Object.fromEntries(columns.map((c, i) => [c, r[i]])) as unknown as ControllerHistoryRecord;
	const pairs = (rows.historyKeys ?? []).filter((r) => keys.get(String(r[0])) === target.keyId);
	requireProof(pairs.length <= 4096);
	const fingerprints = new Set([target.fingerprint, ...pairs.map((r) => String(r[1]))]);
	const selected = (rows.history ?? []).filter((r) => {
		const entry = record(r);
		let value: unknown;
		try {
			value = JSON.parse(entry.manifest_json);
		} catch {
			requireProof(!entry.manifest_json.includes(JSON.stringify(target.deviceId)));
			requireProof(![...fingerprints].some((fp) => entry.manifest_json.includes(fp)));
			return false;
		}
		const manifest = value as { device_decisions?: unknown[] };
		if (!Array.isArray(manifest?.device_decisions)) {
			requireProof(!entry.manifest_json.includes(JSON.stringify(target.deviceId)));
			requireProof(![...fingerprints].some((fp) => entry.manifest_json.includes(fp)));
			return false;
		}
		return manifest.device_decisions.some((decision) => {
			const d = decision as { device_id?: string; key_fingerprint?: string } | null;
			if (d?.device_id === target.deviceId || fingerprints.has(String(d?.key_fingerprint)))
				return true;
			if (typeof d?.device_id === "string" && typeof d?.key_fingerprint === "string") return false;
			const text = JSON.stringify(decision);
			return (
				text.includes(JSON.stringify(target.deviceId)) ||
				[...fingerprints].some((fp) => text.includes(fp))
			);
		});
	});
	requireProof(selected.length <= 500 && bytes(selected) <= 750_000);
	const result = {
		...target,
		keys: pairs.map((r) => ({ public_key: String(r[0]), fingerprint: String(r[1]) })),
		discoveryKeys: [],
		discoveryFragments: target.fragments,
		fingerprints: [...fingerprints].sort(),
		records: selected.map((r) => {
			const entry = record(r);
			parseControllerHistoryRecord(entry, target.coordinatorId);
			return entry;
		}),
	};
	requireProof(bytes(result) <= 750_000);
	return result;
}

function outcome(run: () => unknown) {
	try {
		return { value: run() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("network forbidden");
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

test("500 subject views decode 500 captured raw histories only once", () => {
	// Arrange: real JSON decoding, observed only at the internal preparation seam.
	const rows = Array.from({ length: 500 }, (_, i) => row(`unrelated-${i}`, `other-${i}`));
	const decode = vi.fn((text: string): unknown => JSON.parse(text));
	const prepared = prepareCompletionHistory(rows, decode);
	// Act
	const views = Array.from({ length: 500 }, (_, i) =>
		subjectHistory({ history: rows }, { ...subject, deviceId: `subject-${i}` }, keys, prepared),
	);
	// Assert: no wall-clock threshold or global JSON.parse spy.
	expect(decode).toHaveBeenCalledTimes(500);
	expect(views.every((view) => view.records.length === 0)).toBe(true);
});

test("failed decodes are reused without eagerly denying unrelated subjects or leaking between captures", () => {
	// Arrange
	const rows = [raw('{"device_id":"device-a",')];
	const decode = vi.fn((text: string): unknown => JSON.parse(text));
	const prepared = prepareCompletionHistory(rows, decode);
	expect(decode).not.toHaveBeenCalled();
	// Act
	const unrelated = subjectHistory(
		{ history: rows },
		{ ...subject, deviceId: "unrelated", fingerprint: "other" },
		keys,
		prepared,
	);
	const denied = outcome(() => subjectHistory({ history: rows }, subject, keys, prepared));
	subjectHistory(
		{ history: rows },
		{ ...subject, deviceId: "unrelated", fingerprint: "other" },
		keys,
		prepareCompletionHistory(rows, decode),
	);
	// Assert
	expect(unrelated.records).toEqual([]);
	expect(denied).toEqual({ error: "completion_manifest_unavailable" });
	expect(decode).toHaveBeenCalledTimes(2);
});

const cases: [string, EvidenceRow[]][] = [
	["valid", [row()]],
	["alias", [row("alias-device", "alias-fp")]],
	["unrelated", [row("unrelated", "unrelated-fp")]],
	["invalid JSON plausible device", [raw('{"device_id":"device-a",')]],
	["invalid JSON plausible alias", [raw(`${fingerprintOf("alias-fp")}{`)]],
	["invalid JSON irrelevant", [raw("{broken")]],
	["absent decisions plausible", [raw('{"device_id":"device-a"}')]],
	["absent decisions irrelevant", [raw("{}")]],
	["nonarray decisions plausible", [raw('{"device_decisions":"device-a"}')]],
	["nonarray decisions irrelevant", [raw('{"device_decisions":{}}')]],
	["null manifest", [raw("null")]],
	["primitive manifest", [raw("42")]],
	["malformed decision device", [raw('{"device_decisions":[{"device_id":["device-a"]}]}')]],
	[
		"malformed decision alias",
		[raw(`{"device_decisions":[{"key_fingerprint":["${fingerprintOf("alias-fp")}"]}]}`)],
	],
	["malformed decision irrelevant", [raw('{"device_decisions":[null,42,false,{},"unrelated"]}')]],
	["malformed string decision", [raw('{"device_decisions":["device-a"]}')]],
	[
		"typed unrelated decision ignores other text",
		[
			raw(
				'{"device_decisions":[{"device_id":"other","key_fingerprint":"other","note":"device-a"}]}',
			),
		],
	],
	["noncanonical selected JSON", [raw(` ${row()[5]}`)]],
	["selected rows retain order", [row("alias-device", "alias-fp"), row()]],
	["500 rows allowed", Array.from({ length: 500 }, () => row())],
	["501 rows denied", Array.from({ length: 501 }, () => row())],
	[
		"raw bytes below budget",
		[raw(String(row()[5]).replace("Synthetic history", "é".repeat(100_000)))],
	],
	[
		"raw bytes above budget",
		[raw(String(row()[5]).replace("Synthetic history", "é".repeat(400_000)))],
	],
];

test.each(cases)("matches original per-subject view/error: %s", (_name, history) => {
	// Arrange
	const rows: EvidenceRows = {
		history,
		historyKeys: [
			["alias-key", fingerprintOf("alias-fp")],
			["unrelated-key", fingerprintOf("unrelated-fp")],
		],
	};
	const prepared = prepareCompletionHistory(history);
	const before = JSON.stringify(rows);
	// Act
	const expected = outcome(() => original(rows));
	const actual = outcome(() => subjectHistory(rows, subject, keys, prepared));
	// Assert: canonical errors, raw lexemes and array order must all agree.
	expect(actual).toEqual(expected);
	expect(JSON.stringify(rows)).toBe(before);
});

test.each([750_000, 750_001])(
	"retains raw-array byte budget and validation order at %i bytes",
	(size) => {
		// Arrange: JSON whitespace keeps the selector match but fails canonical validation.
		// Constructed records exceed this budget even when the original raw array fits.
		const entry = raw(` ${row()[5]}`);
		const bytes = new TextEncoder().encode(JSON.stringify([entry])).byteLength;
		entry[5] = `${entry[5]}${" ".repeat(size - bytes)}`;
		const rows = { history: [entry] };
		const prepared = prepareCompletionHistory(rows.history);
		// Act
		const actual = outcome(() => subjectHistory(rows, subject, keys, prepared));
		// Assert: the first cap must not start accounting for constructed object fields.
		const error = size === 750_000 ? "legacy_history_invalid" : "completion_manifest_unavailable";
		expect(actual).toEqual({ error });
		expect(actual).toEqual(outcome(() => original(rows)));
	},
);

test("retains selected raw JSON text, alias selection and captured row order", () => {
	// Arrange
	const first = row("alias-device", "alias-fp");
	const second = row();
	const rows = {
		history: [first, raw("{irrelevant"), second],
		historyKeys: [["alias-key", fingerprintOf("alias-fp")]],
	};
	const prepared = prepareCompletionHistory(rows.history);
	// Act
	const view = subjectHistory(rows, subject, keys, prepared);
	// Assert
	expect(view.records.map((record) => record.manifest_json)).toEqual([first[5], second[5]]);
	expect(view.keys).toEqual([{ public_key: "alias-key", fingerprint: fingerprintOf("alias-fp") }]);
});

test.each([500, 501])("retains the per-subject history row ceiling at %i rows", (count) => {
	// Arrange
	const rows = { history: Array.from({ length: count }, () => row()) };
	const prepared = prepareCompletionHistory(rows.history);
	// Act
	const actual = outcome(() => subjectHistory(rows, subject, keys, prepared));
	// Assert
	if (count === 500) {
		expect(actual).toHaveProperty("value.records.length", 500);
		return;
	}
	expect(actual).toEqual({ error: "completion_manifest_unavailable" });
});
