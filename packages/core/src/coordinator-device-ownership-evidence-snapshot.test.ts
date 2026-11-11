import { expect, vi } from "vitest";
import { controllerHistoryDiscoveryFragments } from "./coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	BYTE_LIMIT,
	type CapturedEvidenceRow,
	EVIDENCE_QUERIES,
	ROW_LIMIT,
	readCombinedEvidenceQuery,
	readEvidenceQuery,
} from "./coordinator-device-ownership-evidence-queries.js";
import {
	binding,
	cfg,
	claim,
	collectInput,
	controller,
	EXPECTED_KEY_ID,
	evidenceBackend,
	evidenceTest,
	history,
	insert,
	invitation,
	signer,
	sourceRef,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { deterministicReviewTests } from "./coordinator-owner-resolution-review-test-fixtures.js";

function encodedInput(input: Awaited<ReturnType<typeof collectInput>>) {
	return JSON.stringify({
		subject: {
			...input.actualSigner,
			coordinatorId: cfg.coordinatorId,
			keyId: EXPECTED_KEY_ID,
			fragments: controllerHistoryDiscoveryFragments(input.actualSigner.publicKey),
		},
		legacyHistory: input.verifiedHistory,
	});
}

// Each evidence category is one read whose `rows` column holds a JSON array of row texts.
const SCHEMA_CATEGORY = "tbl_name='coordinator_legacy_owner_resolutions' AND sql IS NOT NULL";
const responseMutations: Record<string, (rows: string) => string | null> = {
	unchanged: (rows) => rows,
	missing: () => null,
	"not-array": () => "{}",
	"null-row": (rows) => JSON.stringify([...JSON.parse(rows), null]),
	"non-array-row": (rows) => JSON.stringify([...JSON.parse(rows), JSON.stringify({})]),
	"object-field": (rows) => JSON.stringify([...JSON.parse(rows), JSON.stringify([{}])]),
	"over-limit": (rows) =>
		JSON.stringify([...JSON.parse(rows), ...Array.from({ length: ROW_LIMIT + 1 }, () => "[]")]),
};

deterministicReviewTests();
for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	test.for(["empty", "populated"])(
		`${backend}: combined snapshot preserves every legacy category and sorted row for %s data`,
		async (variant, { f }) => {
			// Arrange: retain real history, metadata, and schema rows, including empty markers.
			if (variant === "populated") {
				binding(f);
				claim(f);
				invitation(f);
				history(f);
				insert(f, "coordinator_legacy_owner_resolutions", sourceRef(controller(f)));
				insert(f, "coordinator_device_revocations", {
					subject_kind: "device_id",
					subject_value: signer.deviceId,
					revocation_id: "revoked",
					evidence_group_id: signer.groupId,
					evidence_device_id: signer.deviceId,
					evidence_public_key: signer.publicKey,
					evidence_fingerprint: signer.fingerprint,
					created_at: "2026-10-02T00:00:00.000Z",
				});
			}
			const db = evidenceBackend(f, backend);
			const encoded = encodedInput(await collectInput(f));
			// Act
			const captured = await db.all<CapturedEvidenceRow>(readCombinedEvidenceQuery(encoded));
			const legacy = await Promise.all(
				EVIDENCE_QUERIES.map((query) => db.all<{ row: string }>(readEvidenceQuery(query, encoded))),
			);
			// Assert: compare actual SQL responses, not a reconstructed expected rowset.
			expect(new Set(captured.map(({ category }) => category))).toEqual(
				new Set(EVIDENCE_QUERIES.map(({ name }) => name)),
			);
			EVIDENCE_QUERIES.forEach(({ name }, index) => {
				const rows = legacy[index];
				const expected = rows.length ? rows : [{ row: null }];
				expect(captured.filter(({ category }) => category === name)).toEqual(
					expected.map(({ row }) => ({ category: name, row_count: rows.length, row })),
				);
			});
		},
	);

	test.for([ROW_LIMIT, ROW_LIMIT + 1])(
		`${backend}: enforces the per-category row limit with %i real controllers`,
		async (count, { f }) => {
			// Arrange
			f.db.transaction(() => {
				for (let index = 0; index < count; index++)
					controller(f, {
						attestation_id: `controller-${index}`,
						review_receipt_id: `receipt-${index}`,
						group_id: `retained-${index}`,
					});
			})();
			const input = await collectInput(f);
			const db = evidenceBackend(f, backend);
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			// Act
			const captured = await db.all<CapturedEvidenceRow>(
				readCombinedEvidenceQuery(encodedInput(input)),
			);
			const result = await reader.collect(input);
			// Assert: the sentinel row must cause rejection, never silent truncation.
			const controllers = captured.filter(({ category }) => category === "controllers");
			expect(controllers).toHaveLength(count);
			expect(controllers.every(({ row_count }) => row_count === count)).toBe(true);
			expect(result.kind).toBe(count === ROW_LIMIT ? "collected" : "unavailable");
		},
	);

	test.for([60, 120])(
		`${backend}: applies the aggregate UTF-8 byte limit across %i controllers and invites`,
		async (count, { f }) => {
			// Arrange: each category fits alone, while their combined multibyte text may not.
			const publicKey = `${signer.publicKey} ${"界".repeat(1000)}`;
			f.db.transaction(() => {
				for (let index = 0; index < count; index++) {
					controller(f, {
						attestation_id: `controller-${index}`,
						review_receipt_id: `receipt-${index}`,
						group_id: `retained-${index}`,
						public_key: publicKey,
					});
					invitation(f, {
						invite_id: `invite-${index}`,
						token: `synthetic-${index}`,
						bound_public_key: publicKey,
					});
				}
			})();
			const input = await collectInput(f);
			const encoded = encodedInput(input);
			const db = evidenceBackend(f, backend);
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			// Act
			const legacy = await Promise.all(
				EVIDENCE_QUERIES.map((query) => db.all<{ row: string }>(readEvidenceQuery(query, encoded))),
			);
			const captured = await db.all<CapturedEvidenceRow>(readCombinedEvidenceQuery(encoded));
			const result = await reader.collect(input);
			// Assert: byte overflow must suppress all evidence text before crossing the adapter.
			expect(legacy.flat().every(({ row }) => typeof row === "string")).toBe(true);
			const text = legacy
				.flat()
				.map(({ row }) => row)
				.join("");
			expect(text.length).toBeLessThan(BYTE_LIMIT);
			const overflow = new TextEncoder().encode(text).byteLength > BYTE_LIMIT;
			expect(overflow).toBe(count === 120);
			expect(captured.every(({ row }) => row === null)).toBe(overflow);
			expect(result.kind).toBe(overflow ? "unavailable" : "collected");
		},
	);

	test.for([180, 260])(
		`${backend}: rejects per-category UTF-8 byte overflow with %i controllers`,
		async (count, { f }) => {
			// Arrange: remain below the row limit so rejection must come from the byte limit.
			f.db.transaction(() => {
				for (let index = 0; index < count; index++) {
					controller(f, {
						attestation_id: `controller-${index}`,
						review_receipt_id: `receipt-${index}`,
						group_id: `retained-${index}`,
						public_key: `${signer.publicKey} ${"界".repeat(1000)}`,
					});
				}
			})();
			const input = await collectInput(f);
			const db = evidenceBackend(f, backend);
			const encoded = encodedInput(input);
			const query = EVIDENCE_QUERIES.find(({ name }) => name === "controllers");
			if (!query) throw new Error("missing controller evidence query");
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			// Act
			const legacy = await db.all<{ row: string | null }>(readEvidenceQuery(query, encoded));
			const captured = await db.all<CapturedEvidenceRow>(readCombinedEvidenceQuery(encoded));
			const result = await reader.collect(input);
			// Assert: both query shapes suppress oversized category text, without truncating counts.
			const overflow = count === 260;
			expect(legacy).toHaveLength(count);
			expect(legacy.every(({ row }) => row === null)).toBe(overflow);
			expect(captured.filter(({ category }) => category === "controllers")).toHaveLength(count);
			expect(captured.every(({ row }) => row === null)).toBe(overflow);
			expect(result.kind).toBe(overflow ? "unavailable" : "collected");
		},
	);

	test.for(Object.keys(responseMutations))(
		`${backend}: validates the schema category response for %s rows`,
		async (variant, { f }) => {
			// Arrange: alter only the schema category's response after running its real SQL.
			const input = await collectInput(f);
			const db = evidenceBackend(f, backend);
			const actualReadBatch = db.readBatch;
			const mutate = <T>(statement: AuthLinkStatement, rows: T[]): T[] => {
				if (
					!statement.sql.includes(SCHEMA_CATEGORY) ||
					statement.sql.includes("auth_snapshot_changed")
				)
					return rows;
				const text = responseMutations[variant]((rows[0] as { rows: string }).rows);
				return [(text === null ? {} : { rows: text }) as T];
			};
			const reads = vi
				.spyOn(db, "readBatch")
				.mockImplementation(async <T>(statements: AuthLinkStatement[]) =>
					(await actualReadBatch<T>(statements)).map((rows, index) =>
						mutate(statements[index] as AuthLinkStatement, rows),
					),
				);
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			// Act
			const result = await reader.collect(input);
			// Assert: a malformed category response cannot produce an accepted snapshot.
			expect(
				reads.mock.calls.some(([statements]) =>
					statements.some(({ sql }) => sql.includes(SCHEMA_CATEGORY)),
				),
			).toBe(true);
			expect(result.kind).toBe(variant === "unchanged" ? "collected" : "unavailable");
		},
	);
}
