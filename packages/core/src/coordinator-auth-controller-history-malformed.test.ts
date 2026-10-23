import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	enroll,
	type Fixture,
	review,
	setupStore,
} from "./coordinator-auth-store-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const subject = review({ publicKey: CANONICAL_PUBLIC_KEY });
const historyInput = {
	coordinatorId: subject.coordinatorId,
	deviceId: subject.deviceId,
	publicKey: subject.publicKey,
	fingerprint: subject.fingerprint,
};
const alias = {
	publicKey: `${CANONICAL_PUBLIC_KEY} historical-alias`,
	fingerprint: "c".repeat(64),
};
const completedAt = "2026-10-01T00:00:00.000Z";

function manifest(group: string, options: { excluded?: boolean; alias?: boolean } = {}) {
	return normalize({
		version: 1,
		coordinator_id: subject.coordinatorId,
		candidate_ref: legacyTeamCandidateId(subject.coordinatorId, group),
		candidate_digest: "a".repeat(64),
		team_id: `team-${group}`,
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic historical Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: options.excluded ? [] : [{ identity_id: "old-identity", role: "member" }],
		device_decisions: [
			{
				device_id: options.alias ? "historical-device" : subject.deviceId,
				key_fingerprint: options.alias ? alias.fingerprint : subject.fingerprint,
				enabled: true,
				identity_id: options.excluded ? null : "old-identity",
				decision: options.excluded ? "excluded" : "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: completedAt,
	});
}

function insertHistory(f: Fixture, group: string, value: unknown) {
	f.db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
		VALUES (?,?,?,?,?,?)`)
		.run(
			group,
			legacyTeamCandidateId(subject.coordinatorId, group),
			1,
			JSON.stringify(value),
			completedAt,
			completedAt,
		);
}

const malformedDecisions = [
	{ name: "scalar device ID", decisions: [subject.deviceId] },
	{ name: "scalar fingerprint", decisions: [subject.fingerprint] },
	{ name: "scalar historical alias fingerprint", decisions: [alias.fingerprint] },
	{ name: "nested misplaced device ID", decisions: [{ nested: { device_id: subject.deviceId } }] },
	{ name: "array-valued device ID", decisions: [{ device_id: [subject.deviceId] }] },
	{
		name: "object-valued fingerprint",
		decisions: [{ key_fingerprint: { value: subject.fingerprint } }],
	},
];

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = it.extend<{ f: Fixture }>({
		f: async ({ task: _task }, use) => {
			const f = setupStore(backend, { authClock: () => Date.parse(completedAt) });
			try {
				await enroll(f.store, subject);
				await f.store.enrollDevice(subject.groupId, { deviceId: "alias-device", ...alias });
				await use(f);
			} finally {
				f.db.close();
			}
		},
	});

	describe(`${backend} malformed controller history discovery`, () => {
		for (const { name, decisions } of malformedDecisions) {
			test(`rejects target-referencing ${name} instead of capturing empty history`, async ({
				f,
			}) => {
				// Arrange: valid JSON and an array must not hide malformed target evidence.
				insertHistory(f, "malformed-target", {
					coordinator_id: subject.coordinatorId,
					device_decisions: decisions,
				});

				// Act: exercise the store's actual SQL and strict manifest parser.
				const captured = f.store.captureAuthControllerLegacyHistory(historyInput);

				// Assert: malformed relevant evidence requires investigation, not absence.
				await expect(captured).rejects.toThrow("completion_manifest_invalid");
			});
		}

		test("ignores unrelated malformed arrays and target references in another coordinator", async ({
			f,
		}) => {
			// Arrange: the malformed row shapes above are harmless without a target reference.
			const unrelated = [
				"other-device",
				"9".repeat(64),
				{ nested: { device_id: "other-device" } },
				{ device_id: ["other-device"] },
				{ key_fingerprint: { value: "9".repeat(64) } },
				null,
			];
			insertHistory(f, "unrelated", {
				coordinator_id: subject.coordinatorId,
				device_decisions: unrelated,
			});
			insertHistory(f, "other-coordinator", {
				coordinator_id: "other-coordinator",
				device_decisions: [subject.deviceId, subject.fingerprint],
			});

			// Act.
			const captured = await f.store.captureAuthControllerLegacyHistory(historyInput);

			// Assert: malformed history is not a global denial condition.
			expect(captured.records).toEqual([]);
			expect(captured.fingerprints).toEqual([subject.fingerprint, alias.fingerprint]);
		});

		test("retains included, excluded and alias history without selecting unrelated valid text", async ({
			f,
		}) => {
			// Arrange: canonical unrelated metadata may mention the target without owning it.
			const expected = [
				manifest("included"),
				manifest("excluded", { excluded: true }),
				manifest("alias", { alias: true }),
			];
			for (const value of expected) {
				insertHistory(f, value.team_id.slice("team-".length), value);
			}
			const unrelated = manifest("unrelated-valid");
			unrelated.team.display_name = subject.deviceId;
			unrelated.device_decisions = unrelated.device_decisions.map((decision) => ({
				...decision,
				device_id: "other-device",
				key_fingerprint: "9".repeat(64),
			}));
			insertHistory(f, "unrelated-valid", normalize(unrelated));

			// Act.
			const captured = await f.store.captureAuthControllerLegacyHistory(historyInput);

			// Assert: discovery still selects decisions and canonical subject aliases only.
			expect(captured.records.map((row) => row.manifest_json).sort()).toEqual(
				expected.map(canonical).sort(),
			);
			expect(captured.keys).toEqual(
				expect.arrayContaining([
					{ public_key: subject.publicKey, fingerprint: subject.fingerprint },
					{ public_key: alias.publicKey, fingerprint: alias.fingerprint },
				]),
			);
		});
	});
}
