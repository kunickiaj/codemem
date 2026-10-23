import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type Fixture, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	NODE_ONLY_ALIASES,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { legacyOwnerKeyMetadata } from "./coordinator-legacy-owner-compatibility.js";
import {
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES,
	type CoordinatorLegacyTeamCompletionManifestV1,
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
} from "./coordinator-legacy-team-completion.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const OTHER_KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
const NOW = "2026-09-01T00:00:00.000Z";

function manifest(
	groupId: string,
	options: { deviceId?: string; publicKey?: string; owner?: string; excluded?: boolean } = {},
): CoordinatorLegacyTeamCompletionManifestV1 {
	const candidateRef = legacyTeamCandidateId("coord-a", groupId);
	const owner = options.owner ?? "identity-a";
	return {
		version: 1,
		coordinator_id: "coord-a",
		candidate_ref: candidateRef,
		candidate_digest: "a".repeat(64),
		team_id: deterministicPolicyTeamId(candidateRef),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Fixture Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: options.excluded ? [] : [{ identity_id: owner, role: "member" }],
		device_decisions: [
			{
				device_id: options.deviceId ?? "device-a",
				key_fingerprint: fingerprintPublicKey(options.publicKey ?? CANONICAL_PUBLIC_KEY),
				enabled: true,
				identity_id: options.excluded ? null : owner,
				decision: options.excluded ? "excluded" : "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: NOW,
	};
}

async function enroll(
	f: Fixture,
	groupId: string,
	input = manifest(groupId),
	publicKey = CANONICAL_PUBLIC_KEY,
) {
	await f.store.createGroup(groupId);
	const decision = input.device_decisions[0];
	if (!decision) throw new Error("missing fixture decision");
	await f.store.enrollDevice(groupId, {
		deviceId: decision.device_id,
		publicKey,
		fingerprint: decision.key_fingerprint,
	});
}

// Trusted historical SQL fixtures model states that a new completion must not create.
function seedHistory(
	f: Fixture,
	groupId: string,
	input: CoordinatorLegacyTeamCompletionManifestV1,
) {
	f.db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id, candidate_ref, manifest_version, manifest_json, completed_at, created_at)
		VALUES (?, ?, 1, ?, ?, ?)`)
		.run(
			groupId,
			input.candidate_ref,
			canonicalCoordinatorLegacyTeamCompletionManifestJson(input),
			NOW,
			NOW,
		);
}

function snapshot(f: Fixture) {
	return [
		"coordinator_legacy_team_completions",
		"enrolled_devices",
		"coordinator_device_ownership_bindings",
		"coordinator_scope_memberships",
		"coordinator_bootstrap_grants",
	].map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

function completionTest(backend: "SQLite" | "D1") {
	return it.extend<{ fixture: Fixture }>({
		fixture: async ({ task: _task }, use) => {
			const f = setupStore(backend);
			try {
				await use(f);
			} finally {
				vi.restoreAllMocks();
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		},
	});
}
type CompletionTest = ReturnType<typeof completionTest>;

describe.each(["SQLite", "D1"] as const)("%s legacy completion ownership", (backend) => {
	const test = completionTest(backend);
	registerCompletedOwners(test);
	registerRetainedEvidence(test);
	registerOwnerSources(test);
	registerReplay(test);
	registerSourceValidity(test);
	registerUnrelatedEnrollments(test);
});

function registerUnrelatedEnrollments(test: CompletionTest) {
	for (const size of ["key count", "serialized bytes"] as const) {
		test(`ignores unrelated ownerless enrollments exceeding metadata ${size}`, async ({
			fixture: f,
		}) => {
			await enroll(f, "g1");
			await f.store.createGroup("unrelated");
			const count = size === "key count" ? 25_001 : 1;
			const comment =
				size === "serialized bytes"
					? "x".repeat(COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES)
					: "unrelated";
			f.db.transaction(() => {
				const insert = f.db.prepare(`INSERT INTO enrolled_devices
					(group_id, device_id, public_key, fingerprint, enabled, created_at)
					VALUES ('unrelated', ?, ?, ?, 1, ?)`);
				for (let i = 0; i < count; i++) {
					const publicKey = `${CANONICAL_PUBLIC_KEY} ${comment}-${i}`;
					insert.run(`unrelated-${i}`, publicKey, fingerprintPublicKey(publicKey), NOW);
				}
			})();

			expect(await f.store.createLegacyTeamCompletion("g1", manifest("g1"))).toEqual({
				status: "created",
				manifest: manifest("g1"),
			});
		});
	}
}

function registerCompletedOwners(test: CompletionTest) {
	for (const subject of ["exact device", "comment alias", "Buffer alias"] as const) {
		test(`rejects another completed owner for ${subject} across groups without effects`, async ({
			fixture: f,
		}) => {
			// Arrange: different text fingerprints can still represent one canonical key.
			const first = manifest("g1");
			await enroll(f, "g1", first);
			await f.store.createLegacyTeamCompletion("g1", first);
			if (subject === "exact device") await f.store.removeDevice("g1", "device-a");
			let publicKey = OTHER_KEY;
			let deviceId = "device-a";
			if (subject !== "exact device") {
				deviceId = "device-b";
				publicKey = `${CANONICAL_PUBLIC_KEY} synthetic-comment`;
				if (subject === "Buffer alias") {
					const alias = NODE_ONLY_ALIASES[0];
					if (!alias) throw new Error("missing synthetic alias");
					publicKey = alias.publicKey;
				}
			}
			const second = manifest("g2", { deviceId, publicKey, owner: "identity-b" });
			await enroll(f, "g2", second, publicKey);
			const before = snapshot(f);
			// Act
			const pending = f.store.createLegacyTeamCompletion("g2", second);
			// Assert
			await expect(pending).rejects.toMatchObject({ code: "completion_conflict" });
			expect(snapshot(f)).toEqual(before);
		});
	}
}
function registerRetainedEvidence(test: CompletionTest) {
	for (const [subject, deviceId, publicKey, owner, historicalOwner] of [
		["same device and owner", "device-a", CANONICAL_PUBLIC_KEY, "identity-a", "identity-a"],
		[
			"alias and same owner",
			"device-b",
			`${CANONICAL_PUBLIC_KEY} alias`,
			"identity-a",
			"identity-a",
		],
		["different device and owner", "device-b", OTHER_KEY, "identity-b", "unrelated-person"],
		["other device same owner", "device-b", OTHER_KEY, "identity-a", "unrelated-person"],
	]) {
		test(`allows ${subject} and ignores unrelated identities`, async ({ fixture: f }) => {
			// Arrange
			await enroll(f, "g1");
			await f.store.createLegacyTeamCompletion("g1", manifest("g1"));
			const second = manifest("g2", { deviceId, publicKey, owner });
			await enroll(f, "g2", second, publicKey);
			f.db
				.prepare("UPDATE enrolled_devices SET identity_id = ? WHERE group_id = 'g1'")
				.run(historicalOwner);
			// Act
			const result = await f.store.createLegacyTeamCompletion("g2", second);
			// Assert
			expect(result).toEqual({ status: "created", manifest: second });
		});
	}

	for (const evidence of ["missing", "unverified fingerprint"] as const) {
		test(`does not infer historical aliases from ${evidence} enrollment evidence`, async ({
			fixture: f,
		}) => {
			// Arrange: a historical fingerprint alone is not canonical-key evidence.
			await enroll(f, "g1");
			seedHistory(f, "g1", manifest("g1"));
			if (evidence === "missing") await f.store.removeDevice("g1", "device-a");
			else
				f.db
					.prepare("UPDATE enrolled_devices SET fingerprint = ? WHERE group_id = 'g1'")
					.run("0".repeat(64));
			const publicKey = `${CANONICAL_PUBLIC_KEY} alias`;
			const next = manifest("g2", { deviceId: "device-b", publicKey, owner: "identity-b" });
			await enroll(f, "g2", next, publicKey);
			// Act
			const result = await f.store.createLegacyTeamCompletion("g2", next);
			// Assert
			expect(result.status).toBe("created");
		});
	}
}
function registerOwnerSources(test: CompletionTest) {
	for (const owner of ["identity-a", "identity-b"]) {
		for (const source of [
			{
				name: "enrollment ID",
				enrollment: true,
				deviceId: "device-a",
				publicKey: OTHER_KEY,
				keyId: "0".repeat(64),
			},
			{
				name: "enrollment alias",
				enrollment: true,
				deviceId: "device-b",
				publicKey: `${CANONICAL_PUBLIC_KEY} alias`,
				keyId: EXPECTED_KEY_ID,
			},
			{
				name: "ledger ID",
				enrollment: false,
				deviceId: "device-a",
				publicKey: OTHER_KEY,
				keyId: "0".repeat(64),
			},
			{
				name: "ledger key",
				enrollment: false,
				deviceId: "device-b",
				publicKey: CANONICAL_PUBLIC_KEY,
				keyId: EXPECTED_KEY_ID,
			},
		]) {
			test(`${source.name} owner ${owner} permits only the same owner`, async ({ fixture: f }) => {
				// Arrange
				const next = manifest("g2");
				await enroll(f, "g2", next);
				if (source.enrollment) {
					const { deviceId, publicKey } = source;
					await enroll(f, "g1", manifest("g1", { deviceId, publicKey }), publicKey);
					f.db
						.prepare("UPDATE enrolled_devices SET identity_id = ? WHERE group_id = 'g1'")
						.run(owner);
				} else {
					f.db
						.prepare(
							`INSERT INTO coordinator_device_ownership_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							source.deviceId,
							source.keyId,
							owner,
							"coord-other",
							"binding-a",
							"owner_enrollment",
							"synthetic-proof",
							NOW,
						);
				}
				const before = snapshot(f);
				// Act
				const pending = f.store.createLegacyTeamCompletion("g2", next);
				// Assert
				if (owner === "identity-a") {
					expect((await pending).status).toBe("created");
					return;
				}
				await expect(pending).rejects.toMatchObject({ code: "completion_conflict" });
				expect(snapshot(f)).toEqual(before);
			});
		}
	}
}

function registerReplay(test: CompletionTest) {
	for (const excluded of ["historical", "requested"] as const) {
		test(`does not treat ${excluded} Team exclusion as ownership`, async ({ fixture: f }) => {
			// Arrange
			await enroll(f, "g1");
			await enroll(f, "g2");
			await f.store.createLegacyTeamCompletion(
				"g1",
				manifest("g1", { excluded: excluded === "historical" }),
			);
			const next = manifest("g2", { owner: "identity-b", excluded: excluded === "requested" });
			// Act
			const result = await f.store.createLegacyTeamCompletion("g2", next);
			// Assert
			expect(result).toEqual({ status: "created", manifest: next });
		});
	}

	test("returns exact historical JSON despite preexisting contradictions, but rejects a changed retry", async ({
		fixture: f,
	}) => {
		// Arrange
		await enroll(f, "g1");
		const original = manifest("g1");
		seedHistory(f, "g1", original);
		seedHistory(f, "g2", manifest("g2", { owner: "identity-b" }));
		f.db.prepare("UPDATE enrolled_devices SET identity_id = 'identity-b'").run();
		const before = snapshot(f);
		// Act
		const replay = await f.store.createLegacyTeamCompletion("g1", original);
		const changed = f.store.createLegacyTeamCompletion("g1", {
			...original,
			completed_at: "2026-09-02T00:00:00.000Z",
		});
		// Assert
		expect(replay.status).toBe("existing");
		expect(canonicalCoordinatorLegacyTeamCompletionManifestJson(replay.manifest)).toBe(
			(
				f.db
					.prepare(
						"SELECT manifest_json FROM coordinator_legacy_team_completions WHERE group_id = 'g1'",
					)
					.get() as { manifest_json: string }
			).manifest_json,
		);
		await expect(changed).rejects.toMatchObject({ code: "completion_conflict" });
		expect(snapshot(f)).toEqual(before);
	});
}

function registerSourceValidity(test: CompletionTest) {
	for (const invalid of ["invalid key", "forged fingerprint"] as const) {
		test(`rejects ${invalid} as unavailable, not an inferred ownership conflict`, async ({
			fixture: f,
		}) => {
			// Arrange
			const publicKey = invalid === "invalid key" ? "ssh-ed25519 invalid" : CANONICAL_PUBLIC_KEY;
			const next = manifest("g1", { publicKey });
			if (invalid === "forged fingerprint") {
				for (const decision of next.device_decisions) decision.key_fingerprint = "0".repeat(64);
			}
			await enroll(f, "g1", next, publicKey);
			const before = snapshot(f);
			// Act
			const pending = f.store.createLegacyTeamCompletion("g1", next);
			// Assert
			await expect(pending).rejects.toThrow(/^completion_manifest_unavailable$/);
			expect(snapshot(f)).toEqual(before);
		});
	}

	test("allows at most one conflicting concurrent completion (SQLite-backed D1 shim)", async ({
		fixture: f,
	}) => {
		// Arrange: each caller captures keys before either winning INSERT.
		await enroll(f, "g1");
		const second = manifest("g2", { owner: "identity-b" });
		await enroll(f, "g2", second);
		// Act
		const results = await Promise.allSettled([
			f.store.createLegacyTeamCompletion("g1", manifest("g1")),
			f.store.createLegacyTeamCompletion("g2", second),
		]);
		// Assert: this proves statement behavior in SQLite, not native D1 scheduling.
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.find((r) => r.status === "rejected")).toMatchObject({
			reason: { code: "completion_conflict" },
		});
		expect(f.db.prepare("SELECT * FROM coordinator_legacy_team_completions").all()).toHaveLength(1);
	});
}

function ownerInterleavings(f: Fixture, mutation: string) {
	const alias = `${CANONICAL_PUBLIC_KEY} new-alias`;
	const aliasManifest = manifest("g2", {
		deviceId: "device-b",
		publicKey: alias,
		owner: "identity-b",
	});
	const insertAlias = () =>
		f.db
			.prepare(`INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, enabled, created_at)
			VALUES ('g2', 'device-b', ?, ?, 1, ?)`)
			.run(alias, fingerprintPublicKey(alias), NOW);
	const assignOwner = () =>
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id = 'identity-b' WHERE group_id = 'g2'")
			.run();
	if (mutation === "new historical alias" || mutation === "new alias owner") insertAlias();
	return {
		"competing completion": () => seedHistory(f, "g2", manifest("g2", { owner: "identity-b" })),
		"new ownerless alias": insertAlias,
		"new owned alias": () => {
			insertAlias();
			assignOwner();
		},
		"new historical alias": () => seedHistory(f, "g2", aliasManifest),
		"new alias owner": assignOwner,
		"changed fingerprint": () =>
			f.db.prepare("UPDATE enrolled_devices SET fingerprint = ?").run("0".repeat(64)),
		unchanged: () => {},
	};
}

describe.each(["SQLite", "D1"] as const)(
	"%s completion winning-statement interleavings",
	(backend) => {
		for (const mutation of [
			"new owned alias",
			"new ownerless alias",
			"new historical alias",
			"new alias owner",
			"changed fingerprint",
			"competing completion",
			"unchanged",
		] as const) {
			it(`rechecks ${mutation} after metadata capture`, async () => {
				// Arrange: hook runs immediately before the real INSERT executes.
				const f = setupStore(backend);
				try {
					await enroll(f, "g1");
					await f.store.createGroup("g2");
					const next = manifest("g1");
					let fired = false;
					let atGate: unknown;
					const changes = ownerInterleavings(f, mutation);
					const beforeWrite = (query: string) => {
						if (
							fired ||
							!query.includes("INSERT OR IGNORE INTO coordinator_legacy_team_completions")
						)
							return;
						fired = true;
						changes[mutation]();
						atGate = snapshot(f);
					};
					let racing = f.store;
					if (backend === "D1") racing = new D1CoordinatorStore(sqliteD1(f.db, { beforeWrite }));
					else {
						const prepare = f.db.prepare.bind(f.db);
						vi.spyOn(f.db, "prepare").mockImplementation((query) => {
							beforeWrite(query);
							return prepare(query);
						});
					}
					// Act
					const pending = racing.createLegacyTeamCompletion("g1", next);
					// Assert
					if (mutation === "unchanged" || mutation === "new ownerless alias")
						expect((await pending).status).toBe("created");
					else {
						const error =
							mutation === "competing completion"
								? "completion_conflict"
								: "completion_manifest_unavailable";
						await expect(pending).rejects.toThrow(new RegExp(`^${error}$`));
						expect(snapshot(f)).toEqual(atGate);
					}
					expect(fired).toBe(true);
				} finally {
					vi.restoreAllMocks();
					await f.store.close();
					if (f.db.open) f.db.close();
				}
			});
		}
	},
);

describe("legacy owner key metadata limits and authenticity", () => {
	it("hashes authentic canonical keys and aliases, but never assigns identity to malformed keys", async () => {
		// Arrange
		const alias = `${CANONICAL_PUBLIC_KEY} synthetic-alias`;
		const rows = [CANONICAL_PUBLIC_KEY, alias, "ssh-ed25519 invalid"].map((public_key) => ({
			public_key,
		}));
		// Act
		const metadata = JSON.parse(await legacyOwnerKeyMetadata(rows));
		// Assert: independent known key ID and Node SHA-256, not self-comparison.
		expect(metadata).toEqual([
			{
				public_key: CANONICAL_PUBLIC_KEY,
				key_id: EXPECTED_KEY_ID,
				fingerprint: createHash("sha256").update(CANONICAL_PUBLIC_KEY).digest("hex"),
			},
			{
				public_key: alias,
				key_id: EXPECTED_KEY_ID,
				fingerprint: createHash("sha256").update(alias).digest("hex"),
			},
			{ public_key: "ssh-ed25519 invalid", key_id: null, fingerprint: null },
		]);
	});

	it("accepts exactly 25,000 short keys but rejects 25,001 before classification", async () => {
		// Arrange: invalid short keys keep this resource-boundary fixture inexpensive.
		const rows = Array.from({ length: 25_000 }, (_, i) => ({ public_key: String(i) }));
		// Act
		const accepted = await legacyOwnerKeyMetadata(rows);
		const rejected = legacyOwnerKeyMetadata([...rows, { public_key: "extra" }]);
		// Assert
		expect(JSON.parse(accepted)).toHaveLength(25_000);
		await expect(rejected).rejects.toThrow(/^completion_manifest_unavailable$/);
	});

	it("accepts exactly 1.5 MB of output JSON and rejects one byte more", async () => {
		// Arrange: malformed keys carry no inferred identity; the cap includes metadata overhead.
		const overhead = JSON.stringify([{ public_key: "", key_id: null, fingerprint: null }]).length;
		const key = "x".repeat(COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES - overhead);
		// Act
		const accepted = await legacyOwnerKeyMetadata([{ public_key: key }]);
		const rejected = legacyOwnerKeyMetadata([{ public_key: `${key}x` }]);
		// Assert
		expect(Buffer.byteLength(accepted)).toBe(COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES);
		await expect(rejected).rejects.toThrow(/^completion_manifest_unavailable$/);
	});
});
