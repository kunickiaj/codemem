import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { readVerifiedRejoinStartEvidence } from "./coordinator-device-rejoin-start-evidence.js";
import {
	insertVerifiedRejoinStartAttempt,
	prepareVerifiedRejoinStart,
} from "./coordinator-device-rejoin-start-write.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

type Fixture = Pick<AuthLinkBackend, "first" | "batch"> & {
	run(sql: string, ...values: (string | number | null)[]): Promise<{ changes: number }>;
};
type WithFixture = (run: (db: Fixture) => Promise<void>) => Promise<void>;

const NOW = 1_791_028_800_000;
const CONFIG = { coordinatorId: "coordinator", origin: "https://coordinator.example.test" };
const encoder = new TextEncoder();
const publicKeyHeader = Buffer.from("0000000b7373682d6564323535313900000020", "hex");

async function signingFixture() {
	const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("publicKey" in key)) throw new Error("Fixture needs an Ed25519 key pair");
	const raw = Buffer.from(await crypto.subtle.exportKey("raw", key.publicKey));
	const wire = Buffer.concat([publicKeyHeader, raw]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const keyId = await ed25519KeyId(publicKey);
	if (!keyId) throw new Error("Fixture needs a canonical key");
	const fields = {
		deviceId: "device",
		publicKey: `${publicKey} request-comment`,
		attemptId: "attempt",
		browserStartHash: "a".repeat(64),
		loopbackRedirect: "http://127.0.0.1:12345/codemem/auth/complete",
		timestampMs: NOW,
	};
	const privateKey = key.privateKey;
	const signAttempt = async (attemptId: string, patch: Partial<typeof fields> = {}) => {
		const input = { ...fields, ...patch, attemptId };
		const message = JSON.stringify([
			"codemem-device-rejoin-start-v1",
			CONFIG.origin,
			attemptId,
			input.deviceId,
			input.publicKey,
			keyId,
			input.browserStartHash,
			input.loopbackRedirect,
			input.timestampMs,
		]);
		const signature = await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(message));
		return { ...input, signature: Buffer.from(signature).toString("base64url") };
	};
	return { publicKey, keyId, input: await signAttempt(fields.attemptId), signAttempt };
}

async function seedBinding(db: Pick<Fixture, "run">, keyId: string, device = "device") {
	await db.run(
		`INSERT INTO coordinator_device_ownership_bindings
		(device_id, key_id, coordinator_id, identity_id, binding_id, provenance, source_ref, bound_at)
		VALUES (?, ?, 'coordinator', 'identity', 'binding', 'owner_enrollment', 'fixture', 'fixture-time')`,
		device,
		keyId,
	);
}

async function seedRemoval(
	db: Pick<Fixture, "run">,
	device: string,
	group: string,
	keyId: string,
	publicKey: string,
) {
	await db.run(
		`INSERT INTO coordinator_device_removals
		(removal_id, group_id, device_id, public_key, fingerprint, key_id, removed_at)
		VALUES (?, ?, ?, ?, 'fingerprint', ?, 'fixture-time')`,
		`removal-${group}`,
		group,
		device,
		publicKey,
		keyId,
	);
}

function registerSnapshotTest(withFixture: WithFixture) {
	it("pins only active own tombstones and same-key aliases in removal order without writing", () =>
		withFixture(async (db) => {
			const { input, publicKey, keyId } = await signingFixture();
			await seedBinding(db, keyId);
			await seedRemoval(db, "device", "group-z", keyId, publicKey);
			await seedRemoval(db, "alias", "group-alias", keyId, publicKey);
			await seedRemoval(db, "device", "group-a", keyId, publicKey);
			await seedRemoval(db, "device", "group-lifted", keyId, publicKey);
			await db.run(`UPDATE coordinator_device_removals SET lifted_at = 'fixture-lift', lifted_by_invite_id = 'fixture-invite'
			WHERE group_id = 'group-lifted'`);
			const own = [
				[1, "group-z", publicKey, "fingerprint"],
				[3, "group-a", publicKey, "fingerprint"],
			];
			const before = await readEffects(db);
			const first = await readVerifiedRejoinStartEvidence(db, CONFIG, input, NOW);
			expect(first).toEqual({
				bindingId: "binding",
				identityId: "identity",
				keyId,
				deviceId: "device",
				ownTombstones: own,
				aliasRemovalSeqs: [2],
				removalDigest: createHash("sha256")
					.update(JSON.stringify([["binding", "identity", "device", keyId], own, [2]]))
					.digest("hex"),
			});
			expect(await readVerifiedRejoinStartEvidence(db, CONFIG, input, NOW)).toEqual(first);
			expect(await readEffects(db)).toEqual(before);
			await seedRemoval(db, "alias", "another-alias-group", keyId, publicKey);
			const later = await readVerifiedRejoinStartEvidence(db, CONFIG, input, NOW);
			expect(later?.aliasRemovalSeqs).toEqual([2, 5]);
			expect(later?.removalDigest).not.toBe(first?.removalDigest);
		}));
}

async function seedBlock(
	db: Fixture,
	kind: "device_id" | "ed25519_key",
	value: string,
	publicKey: string,
) {
	await db.run(
		`INSERT INTO coordinator_device_revocations
					(subject_kind, subject_value, revocation_id, evidence_group_id, evidence_device_id,
					evidence_public_key, evidence_fingerprint, created_at)
					VALUES (?, ?, 'block', 'group', 'device', ?, 'fingerprint', 'fixture-time')`,
		kind,
		value,
		publicKey,
	);
}

type RefusalFixture = {
	name: string;
	bindingDevice?: string | null;
	tombstoneDevice?: string;
	tombstoneKey?: string;
	conflict?: boolean;
	block?: "device_id" | "ed25519_key";
	config?: Partial<{ coordinatorId: string | null; origin: string }>;
	signature?: string;
	now?: number;
};

async function seedRefusalEvidence(
	db: Fixture,
	scenario: RefusalFixture,
	keyId: string,
	publicKey: string,
) {
	if (scenario.bindingDevice !== null)
		await seedBinding(db, keyId, scenario.bindingDevice ?? "device");
	await seedRemoval(
		db,
		scenario.tombstoneDevice ?? "device",
		"group",
		keyId,
		scenario.tombstoneKey ?? publicKey,
	);
	if (scenario.conflict) await seedRemoval(db, "device", "conflict", "0".repeat(64), publicKey);
	if (scenario.block)
		await seedBlock(
			db,
			scenario.block,
			scenario.block === "device_id" ? "device" : keyId,
			publicKey,
		);
}

function registerRefusalTests(withFixture: WithFixture) {
	const cases: RefusalFixture[] = [
		{ name: "no binding", bindingDevice: null },
		{ name: "wrong device", bindingDevice: "other" },
		{ name: "wrong coordinator", config: { coordinatorId: "other" } },
		{ name: "no trusted coordinator", config: { coordinatorId: null } },
		{ name: "no own tombstone", tombstoneDevice: "alias" },
		{ name: "conflicting key", conflict: true },
		{ name: "bad recorded key", tombstoneKey: "opaque" },
		{ name: "blocked ID", block: "device_id" },
		{ name: "blocked key", block: "ed25519_key" },
		{ name: "wrong origin", config: { origin: "https://other.example.test" } },
		{ name: "bad signature", signature: "invalid" },
		{ name: "stale", now: NOW + 300_001 },
	];
	it.each(cases)("returns no evidence or writes for $name", (scenario) =>
		withFixture(async (db) => {
			const { input, publicKey, keyId } = await signingFixture();
			const config = { ...CONFIG, ...scenario.config };
			await seedRefusalEvidence(db, scenario, keyId, publicKey);
			const now = scenario.now ?? NOW;
			input.signature = scenario.signature ?? input.signature;
			const before = await readEffects(db);
			expect(await readVerifiedRejoinStartEvidence(db, config, input, now)).toBeNull();
			expect(await readEffects(db)).toEqual(before);
		}),
	);
}

export function registerRejoinStartEvidenceTests(withFixture: WithFixture) {
	registerSnapshotTest(withFixture);
	registerRefusalTests(withFixture);
}

const WRITE_CONFIG = {
	...CONFIG,
	issuer: "https://issuer.example.test",
	authConfigRevision: "fixture-revision",
};

type StartFixture = Awaited<ReturnType<typeof signingFixture>>;

const races: Record<string, (db: Fixture, signing: StartFixture) => Promise<unknown>> = {
	"block by ID": (db, signing) => seedBlock(db, "device_id", "device", signing.publicKey),
	"block by key": (db, signing) => seedBlock(db, "ed25519_key", signing.keyId, signing.publicKey),
	"new own tombstone": (db, signing) =>
		seedRemoval(db, "device", "other", signing.keyId, signing.publicKey),
	"new alias tombstone": (db, signing) =>
		seedRemoval(db, "alias", "other", signing.keyId, signing.publicKey),
	"different key under the same device": (db, signing) =>
		seedRemoval(db, "device", "other", "0".repeat(64), signing.publicKey),
	"lifted own tombstone": (db) => liftFixture(db, "group"),
	"lifted alias tombstone": (db) => liftFixture(db, "alias-group"),
	"binding drift": async (db) => {
		await db.run("DROP TRIGGER coordinator_device_ownership_immutable_update");
		await db.run("UPDATE coordinator_device_ownership_bindings SET identity_id = 'other-identity'");
	},
};

function liftFixture(db: Fixture, group: string) {
	return db.run(
		`UPDATE coordinator_device_removals SET lifted_at = 'fixture-lift',
		lifted_by_invite_id = 'fixture-invite' WHERE group_id = ?`,
		group,
	);
}

export async function verifiedFixture(db: Pick<Fixture, "run">) {
	const signing = await signingFixture();
	await seedBinding(db, signing.keyId);
	await seedRemoval(db, "device", "group", signing.keyId, signing.publicKey);
	await seedRemoval(db, "alias", "alias-group", signing.keyId, signing.publicKey);
	return signing;
}

function writer(db: Fixture, beforeWrite?: () => Promise<unknown>) {
	return {
		first: db.first,
		batch: async (statements: Parameters<AuthLinkBackend["batch"]>[0]) => {
			await beforeWrite?.();
			return db.batch(statements);
		},
	};
}

function registerWriteOutcomeTests(withFixture: WithFixture) {
	it("stores the verified pins in one pending attempt and leaves duplicates unchanged", () =>
		withFixture(async (db) => {
			const { input, publicKey, keyId } = await verifiedFixture(db);
			const evidence = await readVerifiedRejoinStartEvidence(db, CONFIG, input, NOW);
			expect(await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, input, NOW)).toBe(
				true,
			);
			const stored = () =>
				db.first({ sql: "SELECT * FROM coordinator_device_rejoin_attempts", values: [] });
			const row = await stored();
			expect(row).toMatchObject({
				attempt_id: "attempt",
				state: "pending",
				key_id: keyId,
				identity_id: "identity",
				binding_id: "binding",
				public_key: input.publicKey,
				fingerprint: createHash("sha256").update(input.publicKey).digest("hex"),
				own_tombstones_json: JSON.stringify([[1, "group", publicKey, "fingerprint"]]),
				alias_removal_seqs_json: "[2]",
				removal_digest: evidence?.removalDigest,
				created_at_ms: NOW,
				expires_at_ms: NOW + 600_000,
			});
			expect(await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, input, NOW)).toBe(
				false,
			);
			expect(await stored()).toEqual(row);
		}));

	it("never reaches the insert on an invalid signature", () =>
		withFixture(async (db) => {
			const { input } = await verifiedFixture(db);
			const before = await readEffects(db);
			const backend = writer(db, async () => {
				throw new Error("invalid proof reached the write");
			});
			expect(
				await insertVerifiedRejoinStartAttempt(
					backend,
					WRITE_CONFIG,
					{ ...input, signature: "invalid" },
					NOW,
				),
			).toBe(false);
			expect(await readEffects(db)).toEqual(before);
		}));
}

function registerCapacityTest(withFixture: WithFixture) {
	it("admits the twentieth live attempt without eviction and the twenty-first expires the oldest", () =>
		withFixture(async (db) => {
			const { signAttempt } = await verifiedFixture(db);
			const backend = writer(db);
			for (let i = 0; i < 20; i++) {
				const input = await signAttempt(`attempt-${i}`);
				expect(await insertVerifiedRejoinStartAttempt(backend, WRITE_CONFIG, input, NOW)).toBe(
					true,
				);
			}
			const excess = await signAttempt("excess");
			expect(Object.values(await attemptStates(db))).toEqual(Array(20).fill("pending"));
			expect(await insertVerifiedRejoinStartAttempt(backend, WRITE_CONFIG, excess, NOW)).toBe(true);
			expect(await attemptStates(db)).toMatchObject({ "attempt-0": "expired", excess: "pending" });
			expect(
				Object.values(await attemptStates(db)).filter((state) => state === "pending"),
			).toHaveLength(20);
		}));
}

async function attemptStates(db: Fixture): Promise<Record<string, string>> {
	const result = await db.first<{ states: string }>({
		sql: `SELECT json_group_object(attempt_id, state) AS states FROM
		 (SELECT attempt_id, state FROM coordinator_device_rejoin_attempts ORDER BY attempt_id)`,
		values: [],
	});
	return JSON.parse(result?.states ?? "{}");
}

type SeedAttempt = {
	id: string;
	state:
		| "pending"
		| "browser_claimed"
		| "oidc_verified"
		| "confirmed"
		| "failed"
		| "expired"
		| "finalized";
	created?: number;
	device?: string;
	coordinator?: string;
};

async function seedAttempts(db: Fixture, signing: StartFixture, rows: SeedAttempt[]) {
	expect(await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, signing.input, NOW)).toBe(
		true,
	);
	const template = await db.first<Record<string, string | number | null>>({
		sql: "SELECT * FROM coordinator_device_rejoin_attempts WHERE attempt_id = 'attempt'",
		values: [],
	});
	if (!template) throw new Error("Missing attempt template");
	await db.run("DELETE FROM coordinator_device_rejoin_attempts WHERE attempt_id = 'attempt'");
	for (const row of rows) {
		const created = row.created ?? NOW;
		const data = {
			...template,
			attempt_id: row.id,
			state: row.state,
			created_at_ms: created,
			expires_at_ms: created + 600_000,
			device_id: row.device ?? "device",
			coordinator_id: row.coordinator ?? "coordinator",
			browser_transaction_hash: "transaction",
			browser_binder_hash: "b".repeat(64),
			link_id: "link",
			link_authority_kind: "device_claim",
			link_generation: 1,
			destinations_json: "[]",
			non_destinations_json: "[]",
			confirmation_hash: "confirmation",
			completion_secret_hash: "c".repeat(64),
			finalized_at_ms: row.state === "finalized" ? created + 1 : null,
			final_receipt_json: row.state === "finalized" ? "{}" : null,
		};
		await db.run(
			`INSERT INTO coordinator_device_rejoin_attempts (${Object.keys(data).join(",")})
			 VALUES (${Object.keys(data)
					.map(() => "?")
					.join(",")})`,
			...Object.values(data),
		);
	}
}

const liveRows = (count: number): SeedAttempt[] =>
	Array.from({ length: count }, (_, i) => ({ id: `live-${i}`, state: "pending" }));

function registerAdmissionBoundaryTests(withFixture: WithFixture) {
	it.each([19, 20])(
		"excludes failed, expired and deadline-equal rows with %i live attempts",
		(count) =>
			withFixture(async (db) => {
				const signing = await verifiedFixture(db);
				await seedAttempts(db, signing, [
					...liveRows(count),
					{ id: "failed", state: "failed" },
					{ id: "expired", state: "expired" },
					{ id: "deadline", state: "pending", created: NOW - 600_000 },
					{ id: "old-failed", state: "failed", created: NOW - 90_000_000 },
					{ id: "finalized", state: "finalized" },
					{ id: "other-device", state: "pending", device: "other" },
					{ id: "other-coordinator", state: "pending", coordinator: "other" },
				]);
				expect(
					await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, signing.input, NOW),
				).toBe(true);
				const states = await attemptStates(db);
				expect(states).toMatchObject({
					failed: "failed",
					expired: "expired",
					deadline: "pending",
					"old-failed": "failed",
					finalized: "finalized",
					"other-device": "pending",
					"other-coordinator": "pending",
					attempt: "pending",
				});
				expect(states["live-0"]).toBe(count === 20 ? "expired" : "pending");
			}),
	);

	it.each(["oidc_verified", "confirmed"] as const)(
		"refuses twenty protected %s attempts without changing any row",
		(state) =>
			withFixture(async (db) => {
				const signing = await verifiedFixture(db);
				await seedAttempts(
					db,
					signing,
					liveRows(20).map((row) => ({ ...row, state })),
				);
				const before = await allAttempts(db);
				const prepared = await prepareVerifiedRejoinStart(
					writer(db),
					WRITE_CONFIG,
					signing.input,
					NOW,
				);
				expect(await prepared?.insert(() => NOW)).toEqual({ kind: "retry" });
				expect(await allAttempts(db)).toEqual(before);
			}),
	);
}

function registerAdmissionOrderingTests(withFixture: WithFixture) {
	it("expires the oldest eligible browser claim, preserves older protected rows, and breaks age ties by ID", () =>
		withFixture(async (db) => {
			const signing = await verifiedFixture(db);
			await seedAttempts(db, signing, [
				...liveRows(16),
				{ id: "protected-oidc", state: "oidc_verified", created: NOW - 100 },
				{ id: "protected-confirmed", state: "confirmed", created: NOW - 100 },
				{ id: "z-pending", state: "pending", created: NOW - 50 },
				{ id: "a-browser", state: "browser_claimed", created: NOW - 50 },
				{ id: "past-oidc", state: "oidc_verified", created: NOW - 600_000 },
				{ id: "past-confirmed", state: "confirmed", created: NOW - 600_000 },
			]);
			expect(
				await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, signing.input, NOW),
			).toBe(true);
			expect(await attemptStates(db)).toMatchObject({
				"a-browser": "expired",
				"z-pending": "pending",
				"protected-oidc": "oidc_verified",
				"protected-confirmed": "confirmed",
				"past-oidc": "oidc_verified",
				"past-confirmed": "confirmed",
			});
		}));
}

function registerAdmissionRollbackTests(withFixture: WithFixture) {
	it.each(["pending", "failed", "expired", "confirmed", "finalized"] as const)(
		"replay of an existing %s ID runs no write, including with a full device",
		(state) =>
			withFixture(async (db) => {
				const signing = await verifiedFixture(db);
				await seedAttempts(db, signing, [
					...liveRows(20),
					{ id: "attempt", state, created: NOW - 90_000_000 },
				]);
				// Even an UPDATE affecting no rows must not run on replay.
				await db.run(`CREATE TRIGGER reject_replay_write BEFORE UPDATE ON coordinator_device_rejoin_attempts
			 BEGIN SELECT RAISE(ABORT, 'replay_wrote'); END`);
				const before = await allAttempts(db);
				expect(
					await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, signing.input, NOW),
				).toBe(false);
				expect(await allAttempts(db)).toEqual(before);
			}),
	);

	it("rolls back eviction when the guarded INSERT changes zero rows", () =>
		withFixture(async (db) => {
			const signing = await verifiedFixture(db);
			await seedAttempts(db, signing, liveRows(20));
			await db.run(`CREATE TRIGGER skip_start BEFORE INSERT ON coordinator_device_rejoin_attempts
			 BEGIN SELECT RAISE(IGNORE); END`);
			const before = await allAttempts(db);
			expect(
				await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, signing.input, NOW),
			).toBe(false);
			expect(await allAttempts(db)).toEqual(before);
		}));

	it("rolls back eviction and propagates an unexpected INSERT failure", () =>
		withFixture(async (db) => {
			const signing = await verifiedFixture(db);
			await seedAttempts(db, signing, liveRows(20));
			await db.run(`CREATE TRIGGER reject_start BEFORE INSERT ON coordinator_device_rejoin_attempts
			 BEGIN SELECT RAISE(ABORT, 'synthetic_insert_failure'); END`);
			const before = await allAttempts(db);
			await expect(
				insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, signing.input, NOW),
			).rejects.toThrow("synthetic_insert_failure");
			expect(await allAttempts(db)).toEqual(before);
		}));
}

function registerAdmissionRaceTests(withFixture: WithFixture) {
	it("checks replay again inside the batch before eviction", () =>
		withFixture(async (db) => {
			const signing = await verifiedFixture(db);
			await seedAttempts(db, signing, liveRows(20));
			let before: unknown;
			const backend = writer(db, async () => {
				expect(
					await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, signing.input, NOW),
				).toBe(true);
				before = await allAttempts(db);
				await db.run(`CREATE TRIGGER reject_racing_replay BEFORE UPDATE ON coordinator_device_rejoin_attempts
				 BEGIN SELECT RAISE(ABORT, 'replay_wrote'); END`);
			});
			const prepared = await prepareVerifiedRejoinStart(backend, WRITE_CONFIG, signing.input, NOW);
			expect(await prepared?.insert(() => NOW)).toMatchObject({
				kind: "prior_start",
				body: { attempt_id: "attempt", expires_at_ms: NOW + 600_000 },
			});
			expect(await allAttempts(db)).toEqual(before);
		}));

	it("counts capacity inside the batch after another start takes the twentieth slot", () =>
		withFixture(async (db) => {
			const signing = await verifiedFixture(db);
			await seedAttempts(db, signing, liveRows(19));
			const other = await signing.signAttempt("other-start");
			const backend = writer(db, async () => {
				expect(await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, other, NOW)).toBe(
					true,
				);
			});
			expect(
				await insertVerifiedRejoinStartAttempt(backend, WRITE_CONFIG, signing.input, NOW),
			).toBe(true);
			const states = await attemptStates(db);
			expect(states["live-0"]).toBe("expired");
			expect(Object.values(states).filter((state) => state === "pending")).toHaveLength(20);
		}));
}

async function allAttempts(db: Fixture) {
	return db.first({
		sql: `SELECT json_group_array(json(row)) AS rows FROM
		 (SELECT json_object('id', attempt_id, 'state', state, 'expiry', expires_at_ms,
		  'created', created_at_ms, 'key', public_key, 'digest', removal_digest) AS row
		  FROM coordinator_device_rejoin_attempts ORDER BY coordinator_id, attempt_id)`,
		values: [],
	});
}

function registerLiveReplayTests(withFixture: WithFixture) {
	it("recovers a lost start reply with a fresh signature without extending or evicting at capacity", () =>
		withFixture(async (db) => {
			const signing = await verifiedFixture(db);
			const backend = writer(db);
			await seedAttempts(db, signing, liveRows(19));
			const initial = await prepareVerifiedRejoinStart(backend, WRITE_CONFIG, signing.input, NOW);
			const original = await initial?.insert(() => NOW);
			expect(original?.kind).toBe("started");
			const now = NOW + 200_000;
			const fresh = await signing.signAttempt("attempt", { timestampMs: now });
			const before = await allAttempts(db);
			const retry = await prepareVerifiedRejoinStart(backend, WRITE_CONFIG, fresh, now);
			expect(await retry?.insert(() => now)).toEqual({ ...original, kind: "prior_start" });
			expect(await allAttempts(db)).toEqual(before);
		}));

	it.each([
		["browser start hash", { browserStartHash: "f".repeat(64) }],
		["loopback redirect", { loopbackRedirect: "http://127.0.0.1:5432/codemem/auth/complete" }],
	] as const)("masks a freshly signed duplicate with a different %s", (_name, patch) =>
		withFixture(async (db) => {
			const signing = await verifiedFixture(db);
			const backend = writer(db);
			expect(
				await insertVerifiedRejoinStartAttempt(backend, WRITE_CONFIG, signing.input, NOW),
			).toBe(true);
			const before = await allAttempts(db);
			const fresh = await signing.signAttempt("attempt", patch);
			const retry = await prepareVerifiedRejoinStart(backend, WRITE_CONFIG, fresh, NOW);
			expect(await retry?.insert(() => NOW)).toEqual({ kind: "unavailable" });
			expect(await allAttempts(db)).toEqual(before);
		}),
	);
	registerReplayResolutionRaces(withFixture);
}

function registerReplayResolutionRaces(withFixture: WithFixture) {
	it.each(["failed", "expired"] as const)(
		"masks a %s duplicate even before its original deadline",
		(state) =>
			withFixture(async (db) => {
				const signing = await verifiedFixture(db);
				const backend = writer(db);
				expect(
					await insertVerifiedRejoinStartAttempt(backend, WRITE_CONFIG, signing.input, NOW),
				).toBe(true);
				await db.run(
					"UPDATE coordinator_device_rejoin_attempts SET state = ? WHERE attempt_id = 'attempt'",
					state,
				);
				const before = await allAttempts(db);
				const fresh = await signing.signAttempt("attempt", { timestampMs: NOW + 1 });
				const retry = await prepareVerifiedRejoinStart(backend, WRITE_CONFIG, fresh, NOW + 1);
				expect(await retry?.insert(() => NOW + 1)).toEqual({ kind: "unavailable" });
				expect(await allAttempts(db)).toEqual(before);
			}),
	);

	it.each(["evidence changed", "deadline reached"] as const)(
		"does not replay a receipt if %s before the duplicate read",
		(scenario) =>
			withFixture(async (db) => {
				const signing = await verifiedFixture(db);
				expect(
					await insertVerifiedRejoinStartAttempt(writer(db), WRITE_CONFIG, signing.input, NOW),
				).toBe(true);
				let now = NOW + 599_999;
				const fresh = await signing.signAttempt("attempt", { timestampMs: now });
				const before = await allAttempts(db);
				const backend = writer(db, async () => {
					if (scenario === "evidence changed")
						await seedRemoval(db, "alias", "new-alias", signing.keyId, signing.publicKey);
					else now += 1;
				});
				const retry = await prepareVerifiedRejoinStart(backend, WRITE_CONFIG, fresh, now);
				expect(await retry?.insert(() => now)).toEqual({ kind: "unavailable" });
				expect(await allAttempts(db)).toEqual(before);
			}),
	);
}

export function registerRejoinStartWriteTests(withFixture: WithFixture) {
	registerWriteOutcomeTests(withFixture);
	registerCapacityTest(withFixture);
	registerAdmissionBoundaryTests(withFixture);
	registerAdmissionOrderingTests(withFixture);
	registerAdmissionRollbackTests(withFixture);
	registerAdmissionRaceTests(withFixture);
	registerLiveReplayTests(withFixture);
	it.each(Object.entries(races))(
		"writes nothing when %s changes after verification",
		(_name, change) =>
			withFixture(async (db) => {
				const signing = await verifiedFixture(db);
				await seedAttempts(db, signing, liveRows(20));
				const before = await allAttempts(db);
				let ran = false;
				const backend = writer(db, async () => {
					await change(db, signing);
					ran = true;
				});
				expect(
					await insertVerifiedRejoinStartAttempt(backend, WRITE_CONFIG, signing.input, NOW),
				).toBe(false);
				expect(ran).toBe(true);
				expect(await allAttempts(db)).toEqual(before);
			}),
	);
}

function readEffects(db: Fixture) {
	return db.first({
		sql: `SELECT (SELECT COUNT(*) FROM coordinator_device_rejoin_attempts) AS attempts,
		 (SELECT COUNT(*) FROM coordinator_device_rejoin_audit_log) AS audit,
		 (SELECT COUNT(*) FROM enrolled_devices) AS enrolled,
		 (SELECT json_group_array(json_array(removal_seq, lifted_at)) FROM
		   (SELECT removal_seq, lifted_at FROM coordinator_device_removals ORDER BY removal_seq)) AS removals`,
		values: [],
	});
}
