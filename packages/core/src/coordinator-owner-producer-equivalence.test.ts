// Runs each producer's write batch twice on the same database: once as the ported
// producer sends it, with the read-set guards first, and once rebuilt the old way, with
// the pre-port retained-owner pin inside the statements that carried it. A fact changed
// after the reads must leave both batches with the same rows written.
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	config as reconnectConfig,
	input as reconnectInput,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import { reconnectFixture } from "../../cloudflare-coordinator-worker/test/account-reconnect-fixture.js";
import {
	input,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import {
	type AuthLinkBackend,
	AuthLinkOperations,
	type AuthLinkStatement,
} from "./coordinator-auth-link.js";
import { advance, attempt, cfg, finalize, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import { commitOwnerEnrollment } from "./coordinator-owner-enrollment-commit.js";
import { commitWriterFixture } from "./coordinator-owner-enrollment-historical-test-fixture.js";
import { prepareOriginalNegativeOwnerConsistency } from "./coordinator-owner-negative-original-sql-test-fixtures.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";
import {
	originalFirstLinkBatch,
	originalOwnerEnrollmentBatch,
} from "./coordinator-owner-producer-original-sql-test-fixtures.js";
import {
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";
import type { D1CoordinatorStore } from "./d1-coordinator-store.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

const GUARD_MARKER = "auth_snapshot_changed";
type Compose = (writes: AuthLinkStatement[], pin: AuthLinkStatement) => AuthLinkStatement[];
type Change = (db: Database, s: RaceSubject, keyId: string) => void;
type Snapshot = ReturnType<typeof producerSnapshot>;

interface Outcome {
	reached: boolean;
	original?: Snapshot;
	ported?: Snapshot;
	written?: boolean;
	error?: unknown;
}

/**
 * Wraps the backend so that its next batch, after the producer's reads, prepares the old
 * pin, applies the change, runs the old batch in a savepoint it then rolls back, and
 * finally runs the ported batch. Each records the rows its atomic batch leaves.
 */
function differential(
	db: Database,
	backend: AuthLinkBackend,
	subject: RaceSubject,
	compose: Compose,
	change: () => void,
) {
	const outcome: Outcome = { reached: false };
	const wrapped: AuthLinkBackend = {
		...backend,
		all: async <T>(s: AuthLinkStatement) => db.prepare(s.sql).all(...s.values) as T[],
		batch: async (statements) => {
			if (outcome.reached) return backend.batch(statements);
			outcome.reached = true;
			const leading = statements.findIndex((s) => !s.sql.includes(GUARD_MARKER));
			const writes = statements.slice(leading);
			const pin = await prepareOriginalNegativeOwnerConsistency(wrapped, subject);
			if (!pin) throw new Error("the original refused where the read set allowed");
			change();
			const before = producerSnapshot(db);
			outcome.original = runOriginal(db, compose(writes, pin)) ? producerSnapshot(db) : before;
			db.exec("ROLLBACK TO original_batch; RELEASE original_batch");
			try {
				const result = await backend.batch(statements);
				outcome.written = true;
				return result;
			} catch (error) {
				outcome.error = error;
				throw error;
			} finally {
				outcome.ported = producerSnapshot(db);
			}
		},
	};
	return { backend: wrapped, outcome };
}

/** Runs the old batch inside a savepoint. False when a statement aborted it. */
function runOriginal(db: Database, statements: AuthLinkStatement[]): boolean {
	db.exec("SAVEPOINT original_batch");
	try {
		for (const s of statements) db.prepare(s.sql).run(...s.values);
		return true;
	} catch {
		return false;
	}
}

const resolution: Change = (db, s, keyId) =>
	db
		.prepare(
			`INSERT INTO coordinator_legacy_owner_resolutions (coordinator_id,resolution_id,resolution_version,device_id,key_id,owner_identity_id,purpose,scope,source_attestation_id,source_group_id,source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at)
 VALUES (?,'raced-resolution',1,?,?,'owner-A','existing_account_owner','historical_included_owner_labels_only','raced-source','raced-group',1,?,?,NULL,'2026-09-01T00:00:00.000Z','raced-review',?,?,'[]','2026-09-02T00:00:00.000Z')`,
		)
		.run(
			s.coordinatorId,
			s.deviceId,
			keyId,
			s.publicKey,
			s.fingerprint,
			"b".repeat(64),
			"d".repeat(64),
		);

interface Case {
	name: string;
	catalog: "missing" | "empty" | "retained";
	arrange?: (db: Database, s: RaceSubject) => void;
	change: Change;
	/** Whether the ported batch commits. */
	written: boolean;
}

const NO_RETAINED_CASES: Case[] = [
	{ name: "nothing changing", catalog: "empty", change: () => undefined, written: true },
	{
		name: "nothing changing, no table",
		catalog: "missing",
		change: () => undefined,
		written: true,
	},
	{
		name: "the missing table appearing",
		catalog: "missing",
		change: (db) => db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
		written: false,
	},
	{
		name: "the table gaining an index",
		catalog: "empty",
		change: (db) =>
			db.exec("CREATE INDEX raced_index ON coordinator_legacy_owner_resolutions(created_at)"),
		written: false,
	},
	{ name: "a resolution being stored", catalog: "empty", change: resolution, written: false },
];
const RETAINED_CASES: Case[] = [
	{
		name: "nothing changing, retained",
		catalog: "retained",
		change: () => undefined,
		written: true,
	},
	...NEGATIVE_OWNER_CHANGES.filter((race) => race.reads !== "enrollment").map(
		(race): Case => ({
			name: `${race.fact} (${race.reads})`,
			catalog: "retained",
			...(race.arrange ? { arrange: race.arrange } : {}),
			change: (db, s) => race.change(db, s),
			written: false,
		}),
	),
];

async function arrangeCatalog(db: Database, c: Case, s: RaceSubject) {
	if (c.catalog === "missing") db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
	else db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	if (c.catalog === "retained") await retainProducerOwner(db, s);
	c.arrange?.(db, s);
}

function expectSameRows(outcome: Outcome, c: Case) {
	expect(outcome.reached).toBe(true);
	if (c.written) expect(String(outcome.error ?? "")).toBe("");
	expect(outcome.ported).toEqual(outcome.original);
	expect(outcome.written ?? false).toBe(c.written);
}

describe.each(["SQLite", "D1"] as const)("owner enrollment on %s", (kind) => {
	it.each([...NO_RETAINED_CASES, ...RETAINED_CASES])(
		"writes like the original with $name",
		async (c) => {
			// Arrange
			const f = await commitWriterFixture();
			cleanup.push(() => f.close());
			const s: RaceSubject = {
				coordinatorId: f.row.coordinator_id,
				groupId: "group-a",
				deviceId: f.row.device_id,
				publicKey: f.row.public_key,
				fingerprint: f.row.fingerprint,
				ownerIdentityId: f.row.identity_id ?? "",
			};
			await arrangeCatalog(f.db, c, s);
			const keyId = String(await ed25519KeyIdForRevocation(s.publicKey));
			const d1 = sqliteD1(f.db);
			const base: AuthLinkBackend =
				kind === "SQLite"
					? f.backend
					: {
							...f.backend,
							batch: async (statements) => {
								if (!d1.batch) throw new Error("fixture batch missing");
								return d1.batch(statements.map((st) => d1.prepare(st.sql).bind(...st.values)));
							},
						};
			const run = differential(f.db, base, s, originalOwnerEnrollmentBatch, () =>
				c.change(f.db, s, keyId),
			);
			// Act
			await commitOwnerEnrollment({ ...f.input(), backend: run.backend });
			// Assert
			expectSameRows(run.outcome, c);
		},
	);
});

/** A backend over the fixture database, through the D1 adapter or directly. */
function linkBackend(db: Database, kind: "SQLite" | "D1"): AuthLinkBackend {
	const d1 = sqliteD1(db);
	return {
		first: async <T>({ sql, values }: AuthLinkStatement) =>
			kind === "D1"
				? d1
						.prepare(sql)
						.bind(...values)
						.first<T>()
				: ((db.prepare(sql).get(...values) as T | undefined) ?? null),
		run: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
		batch: async (statements) => {
			if (kind === "SQLite")
				return db.transaction(() =>
					statements.map((st) => db.prepare(st.sql).run(...st.values).changes),
				)();
			if (!d1.batch) throw new Error("fixture batch missing");
			const results = await d1.batch(statements.map((st) => d1.prepare(st.sql).bind(...st.values)));
			return results.map((result) =>
				Number((result as { meta: { changes: number } }).meta.changes),
			);
		},
	};
}

// With retained ownership a first link refuses at its binding on main and here alike:
// the claim the batch inserts changes the claims evidence the binding pins.
describe.each(["SQLite", "D1"] as const)("first account link on %s", (kind) => {
	const cases = [...NO_RETAINED_CASES, { ...RETAINED_CASES[0], written: false } as Case];
	it.each(cases)("writes like the original with $name", async (c) => {
		// Arrange
		const store = setupStore("D1", { authClock: () => NOW });
		cleanup.push(async () => {
			await store.store.close();
			if (store.db.open) store.db.close();
		});
		const f = { ...store, cfg: { ...cfg }, now: NOW };
		f.db.exec(seedEnrollmentSql);
		await advance(
			f as Parameters<typeof advance>[0],
			"confirmed",
			attempt({
				authority: { kind: "device_claim", identityId: input.identityId },
				signer: input.signer,
			}),
		);
		const s: RaceSubject = {
			coordinatorId: cfg.coordinatorId,
			...input.signer,
			ownerIdentityId: input.identityId,
		};
		await arrangeCatalog(f.db, c, s);
		const keyId = String(await ed25519KeyIdForRevocation(s.publicKey));
		const run = differential(f.db, linkBackend(f.db, kind), s, originalFirstLinkBatch, () =>
			c.change(f.db, s, keyId),
		);
		// Act
		await new AuthLinkOperations(run.backend, () => NOW).finalizeAuthLinkAttempt(
			finalize({ signer: input.signer, fingerprint: input.signer.fingerprint }),
			f.cfg,
		);
		// Assert
		expectSameRows(run.outcome, c);
	});
});

// A reconnect carries no binding statements, and the account connection schema is present.
describe("account reconnect with the connection schema", () => {
	it.each(NO_RETAINED_CASES.filter((c) => c.catalog === "empty"))(
		"writes like the original with $name",
		async (c) => {
			// Arrange
			const store = setupStore("D1", { authClock: () => NOW });
			cleanup.push(async () => {
				await store.store.close();
				if (store.db.open) store.db.close();
			});
			const hook: { backend?: AuthLinkBackend } = {};
			const base = linkBackend(store.db, "D1");
			const routed: AuthLinkBackend = {
				...base,
				batch: (statements) => (hook.backend ?? base).batch(statements),
			};
			const f = await reconnectFixture(store.store as D1CoordinatorStore, routed);
			await f.disconnect(1);
			const relink = await f.confirmed(1);
			const s: RaceSubject = {
				coordinatorId: reconnectConfig.coordinatorId,
				...reconnectInput.signer,
				ownerIdentityId: reconnectInput.identityId,
			};
			await arrangeCatalog(store.db, c, s);
			const keyId = String(await ed25519KeyIdForRevocation(s.publicKey));
			const run = differential(store.db, base, s, originalFirstLinkBatch, () =>
				c.change(store.db, s, keyId),
			);
			hook.backend = run.backend;
			// Act
			await new AuthLinkOperations(run.backend, () => f.clock.now).finalizeAuthLinkAttempt(
				relink.proof,
				reconnectConfig,
			);
			// Assert
			expectSameRows(run.outcome, c);
		},
	);
});
