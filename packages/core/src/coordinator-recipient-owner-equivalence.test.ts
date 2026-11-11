// Consumes the same recipient invite twice on the same D1 database: once as the ported
// store sends its batches, with read-set guards first, and once with every batch rebuilt
// the old way, with the pre-port pins inside the statements and confirmations that carried
// them. A fact changed just before a batch must give the same answer and the same rows.
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { type Fixture, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	type NegativeOwnerConsistency,
	prepareOriginalNegativeOwnerConsistency,
} from "./coordinator-owner-negative-original-sql-test-fixtures.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";
import {
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";
import {
	originalRecipientConfirmation,
	originalRecipientOwnerWriteSql,
	originalRepairNegative,
	prepareOriginalUnknownNamespaceOwnerConsistency,
} from "./coordinator-recipient-owner-original-sql-test-fixtures.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

// Invites are created at this time, so their stored timestamps stay ordered as the
// ownership evidence checks require when a consumed invite is read back.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-06T00:00:00.000Z"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const GUARD_MARKER = "auth_snapshot_changed";
const CONFIRMATION =
	/^SELECT CASE WHEN \(([\s\S]*)\) THEN 1 ELSE json\('recipient_invite_authorization_failed'\) END AS confirmed$/;
type Stage = "token" | "repair" | "grant";
const STAGE: [Stage, RegExp][] = [
	["token", /UPDATE coordinator_invites SET token\s*=/],
	["repair", /UPDATE enrolled_devices SET identity_id\s*=/],
	["grant", /UPDATE coordinator_invites SET bootstrap_grant_id\s*=/],
];
type Bound = { query: string; values: unknown[] };

/** The old pins, prepared at the first batch, and what each old batch wrote. */
interface OriginalPins {
	full: NegativeOwnerConsistency;
	tokenChanges: number;
	repairChanges: number;
}

/** Rebuilds one ported recipient batch as the old store sent it. */
function originalBatch(
	stage: Stage,
	pins: OriginalPins,
	writes: Bound[],
	guard: AuthLinkStatement,
) {
	const retained = pins.full.retainedRecheck;
	const firstWrite = pins.tokenChanges === 1 ? retained : pins.full;
	const recovery = pins.repairChanges === 1 ? retained : firstWrite;
	const pinned = (bound: Bound, pin: AuthLinkStatement): AuthLinkStatement => ({
		sql: originalRecipientOwnerWriteSql(bound.query, pin),
		values: [...pin.values, ...(bound.values as AuthLinkStatement["values"])],
	});
	if (stage === "token")
		return [
			...writes.map((bound, index) => pinned(bound, index === 0 ? pins.full : retained)),
			originalRecipientConfirmation(retained, guard),
		];
	if (stage === "repair")
		return [
			...writes.map((bound) => pinned(bound, firstWrite)),
			originalRecipientConfirmation(originalRepairNegative(firstWrite, retained), guard),
		];
	return [
		...writes.map((bound) => pinned(bound, recovery)),
		originalRecipientConfirmation(recovery, guard),
	];
}

interface Run {
	subject: RaceSubject;
	/** Old pins: absent for the ported run. */
	original?: { unknownNamespace: boolean; pins?: OriginalPins };
	/** Runs once just before the first batch of this stage. */
	before?: { stage: Stage; change: () => void };
	/** The recipient batches this run sent, in order. */
	reached: Stage[];
}

/** The guards, writes and confirmation of a recipient batch, or null for any other batch. */
function recipientBatch(entries: Bound[]) {
	const lead = entries.findIndex(({ query }) => !query.includes(GUARD_MARKER));
	const last = entries.at(-1);
	const match = last && CONFIRMATION.exec(last.query.trim());
	const writes = entries.slice(lead, -1);
	const stage = STAGE.find(([, pattern]) => pattern.test(writes[0]?.query ?? ""))?.[0];
	if (!match || !stage || writes.length === 0) return null;
	const guard = {
		sql: match[1] ?? "",
		values: (last?.values ?? []) as AuthLinkStatement["values"],
	};
	return { lead, writes, stage, guard };
}

/** The old pins of an original run, prepared at its first recipient batch. */
async function originalPins(
	run: Run,
	reader: Parameters<typeof prepareOriginalNegativeOwnerConsistency>[0],
): Promise<OriginalPins | undefined> {
	const original = run.original;
	if (!original || original.pins) return original?.pins;
	const full = original.unknownNamespace
		? await prepareOriginalUnknownNamespaceOwnerConsistency(reader, run.subject)
		: await prepareOriginalNegativeOwnerConsistency(reader, run.subject);
	if (!full) throw new Error("the original refused where the read set allowed");
	original.pins = { full, tokenChanges: 0, repairChanges: 0 };
	return original.pins;
}

/** A D1 database over the fixture that can rebuild recipient batches the old way. */
function recipientDatabase(db: Database, run: Run): D1DatabaseLike {
	const inner = sqliteD1(db);
	const bound = new WeakMap<object, Bound>();
	const reader = {
		first: async <T>({ sql, values }: AuthLinkStatement) =>
			inner
				.prepare(sql)
				.bind(...values)
				.first<T>(),
		all: async <T>({ sql, values }: AuthLinkStatement) => db.prepare(sql).all(...values) as T[],
	};
	const prepare = (query: string): D1PreparedStatementLike => {
		let values: unknown[] = [];
		const statement: D1PreparedStatementLike = {
			bind: (...next) => {
				values = next;
				bound.set(statement, { query, values });
				return statement;
			},
			first: (...args) =>
				inner
					.prepare(query)
					.bind(...values)
					.first(...args),
			all: () =>
				inner
					.prepare(query)
					.bind(...values)
					.all(),
			raw: () =>
				inner
					.prepare(query)
					.bind(...values)
					.raw(),
			run: () =>
				inner
					.prepare(query)
					.bind(...values)
					.run(),
		};
		bound.set(statement, { query, values });
		return statement;
	};
	return {
		prepare,
		async batch(statements) {
			const entries = statements.map((statement) => {
				const entry = bound.get(statement);
				if (!entry) throw new Error("unknown statement");
				return entry;
			});
			const shape = recipientBatch(entries);
			if (!shape) return inner.batch(statements.map(rebind));
			run.reached.push(shape.stage);
			const pins = await originalPins(run, reader);
			if (run.before?.stage === shape.stage) {
				const { change } = run.before;
				run.before = undefined;
				change();
			}
			if (!pins) return inner.batch(statements.map(rebind));
			const rebuilt = originalBatch(shape.stage, pins, shape.writes, shape.guard);
			const results = await inner.batch(
				rebuilt.map(({ sql, values }) => inner.prepare(sql).bind(...values)),
			);
			const changes = Number((results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0);
			if (shape.stage === "token") pins.tokenChanges = changes;
			if (shape.stage === "repair") pins.repairChanges = changes;
			// The ported code reads its guards' results first.
			return [
				...Array.from({ length: shape.lead }, () => ({ results: [], meta: { changes: 0 } })),
				...results,
			];
		},
	};
	function rebind(statement: D1PreparedStatementLike) {
		const entry = bound.get(statement);
		if (!entry) throw new Error("unknown statement");
		return inner.prepare(entry.query).bind(...entry.values);
	}
}

/** Fixed random bytes, so both runs mint the same grant IDs. */
function fixedRandom() {
	let next = 0;
	vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
		<T extends ArrayBufferView | null>(array: T) => {
			const bytes = new Uint8Array((array as ArrayBufferView).buffer);
			for (let i = 0; i < bytes.length; i++) bytes[i] = (next++ * 37) % 256;
			return array;
		},
	);
	return () => {
		next = 0;
	};
}

async function consume(db: Database, input: CoordinatorConsumeRecipientInviteInput, run: Run) {
	const store = new D1CoordinatorStore(recipientDatabase(db, run));
	return store.consumeRecipientInvite(input).then(
		(value) => ({ status: value.status, grant: value.bootstrap_grant?.grant_id ?? null }),
		(error: unknown) => ({ error: String((error as Error).message) }),
	);
}

type Base = "missing" | "empty" | "retained";
interface Case {
	name: string;
	base: Base;
	kind: "team_member" | "add_device";
	stage: Stage;
	/** A consumed invite whose identity is cleared, or whose grant is missing, first. */
	prior?: "consumed" | "missing grant" | "missing grant, cleared identity";
	unknownNamespace?: boolean;
	arrange?: (db: Database, s: RaceSubject) => void;
	change: (db: Database, s: RaceSubject, keyId: string) => void;
}

const storeResolution = (db: Database, s: RaceSubject, keyId: string) =>
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
const nothing = () => undefined;
const RETAINED_CHANGES = NEGATIVE_OWNER_CHANGES.filter((race) => race.reads !== "enrollment");

const CASES: Case[] = [
	...(["team_member", "add_device"] as const).flatMap((kind): Case[] => [
		{ name: `${kind}, nothing changing`, base: "retained", kind, stage: "token", change: nothing },
		...RETAINED_CHANGES.map(
			(race): Case => ({
				name: `${kind}, ${race.fact} (${race.reads})`,
				base: "retained",
				kind,
				stage: "token",
				...(race.arrange ? { arrange: race.arrange } : {}),
				change: (db, s) => race.change(db, s),
			}),
		),
	]),
	...([false, true] as const).flatMap((unknownNamespace): Case[] => {
		const ns = unknownNamespace ? "no namespace" : "trusted namespace";
		return [
			{
				name: `${ns}, empty table, nothing changing`,
				base: "empty",
				kind: "add_device",
				stage: "token",
				unknownNamespace,
				change: nothing,
			},
			{
				name: `${ns}, missing table, nothing changing`,
				base: "missing",
				kind: "add_device",
				stage: "token",
				unknownNamespace,
				change: nothing,
			},
			{
				name: `${ns}, the table appearing`,
				base: "missing",
				kind: "add_device",
				stage: "token",
				unknownNamespace,
				change: (db) => db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
			},
			{
				name: `${ns}, an index appearing`,
				base: "empty",
				kind: "add_device",
				stage: "token",
				unknownNamespace,
				change: (db) =>
					db.exec("CREATE INDEX raced_index ON coordinator_legacy_owner_resolutions(created_at)"),
			},
			{
				name: `${ns}, a resolution being stored`,
				base: "empty",
				kind: "add_device",
				stage: "token",
				unknownNamespace,
				change: storeResolution,
			},
		];
	}),
	...(
		[
			["repair", "consumed"],
			["grant", "missing grant"],
			["grant", "missing grant, cleared identity"],
		] as const
	).flatMap(([stage, prior]): Case[] => {
		const history = RETAINED_CHANGES.find((race) => race.reads === "history");
		const resolution = RETAINED_CHANGES.find((race) => race.reads.startsWith("retained"));
		const changes: [string, Case["change"]][] = [
			["nothing changing", nothing],
			["retained history changing", (db, s) => history?.change(db, s)],
			["a retained resolution being stored", (db, s) => resolution?.change(db, s)],
		];
		return changes.map(([what, change]) => ({
			name: `${stage} after ${prior}, ${what}`,
			base: "retained",
			kind: "add_device",
			stage,
			prior,
			change,
		}));
	}),
];

async function fixture(c: Case) {
	const f: Fixture = setupStore("D1");
	cleanup.push(async () => {
		await f.store.close();
		if (f.db.open) f.db.close();
	});
	const harness = {
		store: f.store,
		input: revocationInput("equivalence"),
		exec: async (sql: string, ...values: unknown[]) => {
			f.db.prepare(sql).run(...values);
		},
		rows: async (table: string) => f.db.prepare(`SELECT * FROM ${table}`).all(),
	};
	const invitation = await recipientInvite(harness, c.kind);
	const trusted = { ...invitation.input, coordinatorId: "coordinator-a" };
	const { coordinatorId: _namespace, ...legacy } = trusted;
	const input: CoordinatorConsumeRecipientInviteInput = c.unknownNamespace ? legacy : trusted;
	const subject: RaceSubject = {
		coordinatorId: "coordinator-a",
		groupId: harness.input.groupId,
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
		ownerIdentityId: input.identityId,
	};
	if (c.base === "missing") f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
	else f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	if (c.base === "retained") await retainProducerOwner(f.db, subject);
	await priorState(f, c, input);
	c.arrange?.(f.db, subject);
	return { db: f.db, input, subject };
}

async function priorState(f: Fixture, c: Case, input: CoordinatorConsumeRecipientInviteInput) {
	if (c.prior === "consumed") {
		await f.store.consumeRecipientInvite(input);
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id=?")
			.run(input.deviceId);
	}
	if (c.prior?.startsWith("missing grant")) {
		const seed = `${input.deviceId}-seed`;
		f.db.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?").run(seed);
		await f.store.consumeRecipientInvite(input);
		f.db.prepare("UPDATE enrolled_devices SET enabled=1 WHERE device_id=?").run(seed);
	}
	// With the identity cleared, the repair writes a row and grant recovery then checks
	// only the retained guards; otherwise it checks the full set.
	if (c.prior === "missing grant, cleared identity")
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id=?")
			.run(input.deviceId);
}

describe("recipient invite on D1", () => {
	it.each(CASES)("answers and writes like the original with $name", async (c) => {
		// Arrange
		const { db, input, subject } = await fixture(c);
		const keyId = String(await ed25519KeyIdForRevocation(subject.publicKey));
		const reset = fixedRandom();
		const runOnce = async (original: boolean) => {
			reset();
			db.exec("SAVEPOINT equivalence");
			const run: Run = {
				subject,
				...(original ? { original: { unknownNamespace: c.unknownNamespace ?? false } } : {}),
				before: { stage: c.stage, change: () => c.change(db, subject, keyId) },
				reached: [],
			};
			const outcome = await consume(db, input, run);
			const rows = producerSnapshot(db);
			db.exec("ROLLBACK TO equivalence; RELEASE equivalence");
			return { outcome, rows, reached: run.reached };
		};
		// Act
		const original = await runOnce(true);
		const ported = await runOnce(false);
		// Assert: both reached the stage under test, and answered and wrote alike.
		expect(original.reached).toContain(c.stage);
		if (c.change === nothing) expect(original.outcome).toHaveProperty("status");
		expect(ported).toEqual(original);
	});
});
