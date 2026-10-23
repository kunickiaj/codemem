import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfg, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	enroll,
	type Fixture,
	review,
	setupStore,
	sqliteD1,
} from "./coordinator-auth-store-test-fixtures.js";
import { controllerGuardedD1 } from "./coordinator-controller-revocation-test-harness.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const subject = review({ publicKey: CANONICAL_PUBLIC_KEY });
function history(
	f: Fixture,
	options: {
		group?: string;
		device?: string;
		fingerprint?: string;
		identity?: string | null;
	} = {},
) {
	const group = options.group ?? "history-group";
	const identity = options.identity === undefined ? "old-identity" : options.identity;
	const manifest = normalize({
		version: 1,
		coordinator_id: cfg.coordinatorId,
		candidate_ref: legacyTeamCandidateId(cfg.coordinatorId, group),
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
		memberships: identity ? [{ identity_id: identity, role: "member" }] : [],
		device_decisions: [
			{
				device_id: options.device ?? subject.deviceId,
				key_fingerprint: options.fingerprint ?? subject.fingerprint,
				enabled: true,
				identity_id: identity,
				decision: identity ? "included" : "excluded",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	f.db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
		VALUES (?,?,?,?,?,?)`)
		.run(
			group,
			manifest.candidate_ref,
			1,
			canonical(manifest),
			manifest.completed_at,
			manifest.completed_at,
		);
	return manifest;
}
function changeHistory(f: Fixture) {
	f.db
		.prepare("UPDATE coordinator_legacy_team_completions SET created_at=?")
		.run("2026-10-02T00:00:00.000Z");
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = it.extend<{ f: Fixture }>({
		f: async ({ task: _task }, use) => {
			const f = setupStore(backend, { authClock: () => NOW });
			vi.spyOn(f.store, "close").mockResolvedValue(undefined);
			await enroll(f.store, subject);
			try {
				await use(f);
			} finally {
				f.db.close();
			}
		},
	});
	describe(`${backend} history write and alias guards`, () => {
		test.for(["metadata", "new-record", "new-key-alias"] as const)(
			"winning INSERT rejects post-preflight %s race",
			async (change, { f }) => {
				// Arrange: intercept the actual write, not the route preview or store preflight.
				history(f);
				if (change === "new-key-alias")
					history(f, { group: "later", device: "other", fingerprint: "8".repeat(64) });
				const pinned = await f.store.captureAuthControllerLegacyHistory({
					coordinatorId: cfg.coordinatorId,
					deviceId: subject.deviceId,
					publicKey: subject.publicKey,
					fingerprint: subject.fingerprint,
				});
				const input = review({
					...subject,
					coordinatorId: cfg.coordinatorId,
					verifiedSnapshot: { enrollmentIdentityId: null, invites: [], legacyHistory: pinned },
				});
				let changed = false;
				const gate = (query: string) => {
					if (
						changed ||
						!/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+coordinator_auth_controller_attestations\b/iu.test(
							query,
						)
					)
						return;
					changed = true;
					if (change === "metadata") changeHistory(f);
					else if (change === "new-key-alias") {
						f.db
							.prepare(`INSERT INTO enrolled_devices
						(group_id,device_id,public_key,fingerprint,enabled,created_at)
						SELECT group_id,'new-alias',?, ?,1,created_at FROM enrolled_devices WHERE device_id=?`)
							.run(`${CANONICAL_PUBLIC_KEY} alias`, "8".repeat(64), subject.deviceId);
					} else history(f, { group: "raced" });
				};
				let racing = f.store;
				if (backend === "D1")
					racing = controllerGuardedD1(sqliteD1(f.db), async (query) => gate(query));
				else {
					const prepare = f.db.prepare.bind(f.db);
					vi.spyOn(f.db, "prepare").mockImplementation((query: string) => {
						gate(query);
						return prepare(query);
					});
				}
				// Act
				const result = await racing.createAuthControllerAttestation(input);
				// Assert
				expect(changed).toBe(true);
				expect(result).toEqual({ kind: "rejected", error: "review_stale" });
				expect(
					f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all(),
				).toEqual([]);
				expect(f.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all()).toEqual([]);
			},
		);
	});
}
