import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	AUTH_CONTROLLER_INSERT_SQL,
	AUTH_CONTROLLER_RETRY_ACTIVE_SQL,
	type CoordinatorAuthControllerReviewInput,
} from "../../core/src/coordinator-auth-controller.js";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";

const db = env.COORDINATOR_DB;
const timestamp = "2026-10-01T00:00:00.000Z";
type Stage = "create" | "retry";
type Fixture = Awaited<ReturnType<typeof setup>>;
const fixtures: Fixture[] = [];

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(async () => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	for (const f of fixtures.splice(0)) {
		await db.batch([
			...f.historyGroups.map((group) =>
				db
					.prepare("DELETE FROM coordinator_legacy_team_completions WHERE group_id = ?")
					.bind(group),
			),
			db
				.prepare("DELETE FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?")
				.bind(f.review.coordinatorId),
			db.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(f.review.groupId),
			db.prepare("DELETE FROM groups WHERE group_id = ?").bind(f.review.groupId),
		]);
	}
});

async function setup() {
	let beforeStatement: { stage: Stage; action: () => Promise<void> } | undefined;
	const executions: { stage: Stage; binds: number }[] = [];
	// Interpose only at execution: every bind and result still comes from native D1.
	const wrap = (statement: D1PreparedStatement, query: string, binds = 0): D1PreparedStatement =>
		new Proxy(statement, {
			get(statement, property) {
				if (property === "bind")
					return (...values: unknown[]) => wrap(statement.bind(...values), query, values.length);
				let stage: Stage | undefined;
				if (query === AUTH_CONTROLLER_INSERT_SQL) stage = "create";
				else if (query === AUTH_CONTROLLER_RETRY_ACTIVE_SQL) stage = "retry";
				if (stage && (property === "run" || property === "first")) {
					return async (...args: unknown[]) => {
						executions.push({ stage, binds });
						if (beforeStatement?.stage === stage) {
							const { action } = beforeStatement;
							beforeStatement = undefined;
							await action();
						}
						return Reflect.apply(Reflect.get(statement, property), statement, args);
					};
				}
				const value = Reflect.get(statement, property);
				return typeof value === "function" ? value.bind(statement) : value;
			},
		});
	const database = new Proxy(db, {
		get(database, property) {
			if (property === "prepare") return (query: string) => wrap(database.prepare(query), query);
			const value = Reflect.get(database, property);
			return typeof value === "function" ? value.bind(database) : value;
		},
	});
	const store = new D1CoordinatorStore(database, { authClock: () => Date.parse(timestamp) });
	const review: CoordinatorAuthControllerReviewInput = {
		coordinatorId: randomUUID(),
		groupId: randomUUID(),
		deviceId: randomUUID(),
		identityId: randomUUID(),
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
		evidenceDigest: "b".repeat(64),
	};
	const f = {
		store,
		review,
		historyGroups: [] as string[],
		executions,
		at(stage: Stage, action: () => Promise<void>) {
			beforeStatement = { stage, action };
		},
	};
	fixtures.push(f);
	await store.createGroup(review.groupId);
	await store.enrollDevice(review.groupId, {
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	});
	return f;
}

async function history(f: Fixture, options: { deviceId?: string; fingerprint?: string } = {}) {
	const group = randomUUID();
	f.historyGroups.push(group);
	const manifest = normalize({
		version: 1,
		coordinator_id: f.review.coordinatorId,
		candidate_ref: legacyTeamCandidateId(f.review.coordinatorId, group),
		candidate_digest: "a".repeat(64),
		team_id: randomUUID(),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic historical Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: "historical-owner", role: "member" }],
		device_decisions: [
			{
				device_id: options.deviceId ?? f.review.deviceId,
				key_fingerprint: options.fingerprint ?? f.review.fingerprint,
				enabled: true,
				identity_id: "historical-owner",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: timestamp,
	});
	await db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,?,?,?,?)`)
		.bind(group, manifest.candidate_ref, 1, canonical(manifest), timestamp, timestamp)
		.run();
}

async function pin(f: Fixture) {
	f.review.verifiedSnapshot = {
		enrollmentIdentityId: null,
		invites: [],
		legacyHistory: await f.store.captureAuthControllerLegacyHistory(f.review),
	};
}
async function rows(f: Fixture) {
	return (
		await db
			.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?")
			.bind(f.review.coordinatorId)
			.all()
	).results;
}
function expectBinds(f: Fixture, stage: Stage) {
	expect(f.executions).toEqual(
		stage === "create"
			? [{ stage: "create", binds: 23 }]
			: [
					{ stage: "create", binds: 23 },
					{ stage: "retry", binds: 14 },
				],
	);
}

it("native explicit nonempty history creates and exactly retries without rewriting proof or enrollment", async () => {
	// Arrange: canonical historical ownership is reviewed data, not new enrollment identity.
	const f = await setup();
	await history(f);
	await pin(f);
	const enrollment = await f.store.getEnrollment(f.review.groupId, f.review.deviceId);
	// Act
	const created = await f.store.createAuthControllerAttestation(f.review);
	const before = await rows(f);
	const retry = await f.store.createAuthControllerAttestation(f.review);
	// Assert
	expect(f.review.verifiedSnapshot?.legacyHistory?.records).toHaveLength(1);
	expect(created).toEqual({ kind: "created", attestation: before[0] });
	expect(retry).toEqual({ kind: "existing", attestation: before[0] });
	expect(before).toHaveLength(1);
	expect(await rows(f)).toEqual(before);
	expect(await f.store.getEnrollment(f.review.groupId, f.review.deviceId)).toEqual(enrollment);
	expect(f.executions).toEqual([
		{ stage: "create", binds: 23 },
		{ stage: "create", binds: 23 },
		{ stage: "retry", binds: 14 },
	]);
});

for (const stage of ["create", "retry"] as const) {
	it.each(["new-record", "metadata", "new-alias", "unrelated"] as const)(
		`native ${stage} checks explicit history at final execution: %s`,
		async (change) => {
			// Arrange: retry must first persist a real proof; mutations happen only at final SQL.
			const f = await setup();
			if (change === "metadata") await history(f);
			if (change === "new-alias")
				await history(f, { deviceId: randomUUID(), fingerprint: "8".repeat(64) });
			await pin(f);
			if (stage === "retry")
				expect((await f.store.createAuthControllerAttestation(f.review)).kind).toBe("created");
			const before = await rows(f);
			f.executions.length = 0;
			const mutate = vi.fn(async () => {
				if (change === "metadata") {
					await db
						.prepare(
							"UPDATE coordinator_legacy_team_completions SET created_at = ? WHERE group_id = ?",
						)
						.bind("2026-10-02T00:00:00.000Z", f.historyGroups[0])
						.run();
				} else if (change === "new-alias") {
					await f.store.enrollDevice(f.review.groupId, {
						deviceId: randomUUID(),
						publicKey: `${CANONICAL_PUBLIC_KEY} alias`,
						fingerprint: "8".repeat(64),
					});
				} else {
					await history(
						f,
						change === "unrelated" ? { deviceId: randomUUID(), fingerprint: "9".repeat(64) } : {},
					);
				}
			});
			f.at(stage, mutate);
			// Act: the wrapper never substitutes a successful proof or a SQL result.
			const result = await f.store.createAuthControllerAttestation(f.review);
			// Assert: relevant history invalidates the capture; unrelated history stays independent.
			expect(mutate).toHaveBeenCalledTimes(1);
			expectBinds(f, stage);
			if (change === "unrelated") {
				expect(result).toEqual({
					kind: stage === "create" ? "created" : "existing",
					attestation: (await rows(f))[0],
				});
				expect(await rows(f)).toHaveLength(1);
				if (stage === "retry") expect(await rows(f)).toEqual(before);
			} else {
				expect(result).toEqual({ kind: "rejected", error: "review_stale" });
				expect(await rows(f)).toEqual(before);
			}
		},
	);
}
