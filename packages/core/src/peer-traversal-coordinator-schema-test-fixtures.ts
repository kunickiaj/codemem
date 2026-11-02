import { describe, expect, it } from "vitest";
import { registerMetadataScenarios } from "./peer-traversal-coordinator-metadata-schema-test-fixtures.js";
import {
	type CreateFixture,
	REALM,
	type SchemaDatabase,
	type SchemaFixture,
	seed,
	type Value,
} from "./peer-traversal-coordinator-schema-common-test-fixtures.js";

export {
	type SchemaDatabase,
	type SchemaFixture,
	seed,
	type Value,
} from "./peer-traversal-coordinator-schema-common-test-fixtures.js";

export const COLUMNS = [
	"session_id",
	"authority_id",
	"group_id",
	"source_device_id",
	"source_key_id",
	"target_device_id",
	"target_key_id",
	"message_a_digest",
	"prepare_created_at",
	"attempt_not_after",
	"policy_revision",
	"prepare_digest",
	"created_at_ms",
	"phase",
	"offer_digest",
	"answer_digest",
	"last_request_digest",
	"last_nonce",
	"exec_id",
	"updated_at_ms",
] as const;
export type Attempt = Record<(typeof COLUMNS)[number], Value>;
function session(f: SchemaFixture, digit: number) {
	return `${f.authority.slice(-24)}${String(digit).repeat(8)}`;
}
export function attemptRow(f: SchemaFixture, overrides: Partial<Attempt> = {}): Attempt {
	const created = Math.floor(f.now / 1000);
	return {
		session_id: session(f, 1),
		authority_id: f.authority,
		group_id: "group",
		source_device_id: "source",
		source_key_id: "b".repeat(64),
		target_device_id: "target",
		target_key_id: "c".repeat(64),
		message_a_digest: "d".repeat(64),
		prepare_created_at: created,
		attempt_not_after: created + 55,
		policy_revision: 1,
		prepare_digest: "e".repeat(64),
		created_at_ms: f.now,
		phase: 1,
		offer_digest: null,
		answer_digest: null,
		last_request_digest: "e".repeat(64),
		last_nonce: "f".repeat(32),
		exec_id: "2".repeat(32),
		updated_at_ms: f.now,
		...overrides,
	};
}
const INSERT_BASE = `INTO traversal_attempts(${COLUMNS.join(",")}) VALUES (${COLUMNS.map((_, i) => `?${i + 1}`).join(",")})`;
export const INSERT_MODES = ["insert", "replace", "ignore", "nothing", "upsert"] as const;
export function insertAttempt(
	db: SchemaDatabase,
	row: Attempt,
	mode: (typeof INSERT_MODES)[number] = "insert",
) {
	const prefixes = {
		insert: "INSERT",
		replace: "INSERT OR REPLACE",
		ignore: "INSERT OR IGNORE",
		nothing: "INSERT",
		upsert: "INSERT",
	};
	const suffixes = {
		insert: "",
		replace: "",
		ignore: "",
		nothing: " ON CONFLICT DO NOTHING",
		upsert: " ON CONFLICT DO UPDATE SET phase=excluded.phase",
	};
	return db.run(
		`${prefixes[mode]} ${INSERT_BASE}${suffixes[mode]}`,
		COLUMNS.map((column) => row[column]),
	);
}
export function updateAttempt(db: SchemaDatabase, row: Attempt, changes: Partial<Attempt>) {
	// Identifiers always come from the literal column allowlist, never bound data.
	const columns = COLUMNS.filter((column) => Object.hasOwn(changes, column));
	return db.run(
		`UPDATE traversal_attempts SET ${columns.map((column, i) => `${column}=?${i + 1}`).join(",")} WHERE session_id=?${columns.length + 1}`,
		[...columns.map((column) => changes[column] ?? null), row.session_id],
	);
}
export function successor(row: Attempt, overrides: Partial<Attempt> = {}): Attempt {
	const phase = Number(row.phase) + 1;
	const offer = phase === 2 ? "a".repeat(64) : row.offer_digest;
	const answer = phase === 4 ? "b".repeat(64) : row.answer_digest;
	let request = "c".repeat(64);
	if (phase === 2) request = String(offer);
	if (phase === 4) request = String(answer);
	return {
		...row,
		phase,
		offer_digest: offer,
		answer_digest: answer,
		last_request_digest: request,
		exec_id: String(phase + 2).repeat(32),
		updated_at_ms: Number(row.updated_at_ms) + 1,
		...overrides,
	};
}
export async function advance(f: SchemaFixture, row: Attempt, phase: number) {
	let current = row;
	while (Number(current.phase) < phase) {
		const next = successor(current);
		await updateAttempt(f.db, current, next);
		current = next;
	}
	return current;
}

// Aggregate registration preserves the full suite while metadata remains independently runnable.
export function schemaScenarios(create: CreateFixture) {
	registerMetadataScenarios(create);
	describe("digest-only attempt state", () => {
		registerPhaseProgression(create);
		registerValidBounds(create);
		registerRequiredFields(create);
		registerMissingRealm(create);
		registerHexShapes(create);
		registerInitialShapes(create);
		registerDeadlineDrift(create);
		registerFirstTransitions(create);
		registerLaterTransitions(create);
		registerSessionCollisions(create);
	});
	describe("atomic realm quotas and retention", () => {
		registerPairQuota(create);
		registerIndependentPairs(create);
		registerDeviceQuotas(create);
		registerInactiveAttempts(create);
		registerExpiredInsertsAfterSaturation(create);
		registerRetention(create);
	});
}

function registerPhaseProgression(create: CreateFixture) {
	it("stores only the contracted columns and advances all five phases with repeated actor nonce", async () => {
		const f = await create();
		await seed(f);
		const row = attemptRow(f);
		await insertAttempt(f.db, row);

		// Nonce equality across actors is not replay detection. The device ledger owns that.
		const final = await advance(f, row, 5);
		const stored = await f.db.all("SELECT * FROM traversal_attempts WHERE session_id=?1", [
			row.session_id,
		]);

		expect(stored).toEqual([final]);
		expect(Object.keys(stored[0] ?? {}).sort()).toEqual([...COLUMNS].sort());
	});
}

function registerValidBounds(create: CreateFixture) {
	it("accepts visible ASCII device bounds, byte-length group bounds and safe nonnegative times", async () => {
		const f = await create();
		await seed(f);
		const group = "é".repeat(64);
		await f.db.run(REALM, [f.authority, group, 1]);
		const row = attemptRow(f, {
			group_id: group,
			source_device_id: "!",
			target_device_id: "~".repeat(64),
			prepare_created_at: 0,
			attempt_not_after: 55,
			created_at_ms: 0,
			updated_at_ms: Number.MAX_SAFE_INTEGER,
		});

		await insertAttempt(f.db, row);

		expect(
			await f.db.all("SELECT * FROM traversal_attempts WHERE session_id=?1", [row.session_id]),
		).toEqual([row]);
	});
}

function registerRequiredFields(create: CreateFixture) {
	it.each(COLUMNS.filter((column) => column !== "offer_digest" && column !== "answer_digest"))(
		"rejects null required attempt field %s",
		async (column) => {
			const f = await create();
			await seed(f);

			const result = insertAttempt(f.db, attemptRow(f, { [column]: null }));

			await expect(result).rejects.toThrow();
		},
	);
}

function registerHexShapes(create: CreateFixture) {
	const hexColumns = [
		"session_id",
		"authority_id",
		"source_key_id",
		"target_key_id",
		"message_a_digest",
		"prepare_digest",
		"last_request_digest",
		"last_nonce",
		"exec_id",
	] as const;
	it.each(
		hexColumns.flatMap((column) => {
			const length = ["session_id", "last_nonce", "exec_id"].includes(column) ? 32 : 64;
			return [
				"A".repeat(length),
				"g".repeat(length),
				"a".repeat(length - 1),
				"a".repeat(length + 1),
				`${"a".repeat(length - 1)}\0`,
				null,
			].map((value) => ({ column, value }));
		}),
	)("rejects malformed hex $column/$value", async ({ column, value }) => {
		const f = await create();
		await seed(f);

		const result = insertAttempt(f.db, attemptRow(f, { [column]: value }));

		await expect(result).rejects.toThrow();
	});
}

const INVALID_INITIAL_STATES: Partial<Attempt>[] = [
	...["source_device_id", "target_device_id"].flatMap((column) =>
		["", " ", "a b", "a\0b", "é", "a\x7fb", "a".repeat(65)].map((value) => ({ [column]: value })),
	),
	{ target_device_id: "source" },
	{ group_id: "" },
	{ group_id: "é".repeat(65) },
	{ group_id: "a\0b" },
	{ phase: 0 },
	{ phase: 2 },
	{ phase: 5 },
	{ phase: 1.5 },
	{ last_request_digest: "a".repeat(64) },
	{ offer_digest: "a".repeat(64) },
	{ answer_digest: "a".repeat(64) },
	{ attempt_not_after: 0 },
	{ policy_revision: 0 },
	{ policy_revision: 1.5 },
	{ policy_revision: Number.MAX_SAFE_INTEGER + 1 },
	{ prepare_created_at: -1 },
	{ prepare_created_at: 0.5 },
	{ prepare_created_at: 9007199254741, attempt_not_after: 9007199254796 },
	{ created_at_ms: -1 },
	{ created_at_ms: 0.5 },
	{ created_at_ms: Number.MAX_SAFE_INTEGER + 1 },
	{ updated_at_ms: -1 },
	{ updated_at_ms: 0.5 },
	{ updated_at_ms: Number.MAX_SAFE_INTEGER + 1 },
];
function registerInitialShapes(create: CreateFixture) {
	it.each(INVALID_INITIAL_STATES)("rejects invalid initial state %j", async (changes) => {
		const f = await create();
		await seed(f);

		const result = insertAttempt(f.db, attemptRow(f, changes));

		await expect(result).rejects.toThrow();
	});
}

function registerDeadlineDrift(create: CreateFixture) {
	it.each([-1, 1])("rejects deadline drift of %s seconds", async (drift) => {
		const f = await create();
		await seed(f);
		const row = attemptRow(f);

		const result = insertAttempt(f.db, {
			...row,
			attempt_not_after: Number(row.attempt_not_after) + drift,
		});

		await expect(result).rejects.toThrow();
	});
}

const INVALID_FIRST_TRANSITIONS: Partial<Attempt>[] = [
	{ session_id: "9".repeat(32) },
	{ authority_id: "9".repeat(64) },
	{ group_id: "other" },
	{ source_device_id: "other" },
	{ target_device_id: "other" },
	{ source_key_id: "9".repeat(64) },
	{ target_key_id: "9".repeat(64) },
	{ message_a_digest: "9".repeat(64) },
	{ policy_revision: 2 },
	{ prepare_digest: "9".repeat(64) },
	{ prepare_created_at: 1, attempt_not_after: 56 },
	{ created_at_ms: 0 },
	{ exec_id: "2".repeat(32) },
	{ phase: 1 },
	{ phase: 3 },
	{ phase: 6 },
	{ updated_at_ms: 0 },
	{ offer_digest: null },
	{ offer_digest: "G".repeat(64) },
	{ answer_digest: "b".repeat(64) },
	{ last_request_digest: "9".repeat(64) },
];
function registerFirstTransitions(create: CreateFixture) {
	it.each(INVALID_FIRST_TRANSITIONS)("rejects illegal first transition %j", async (changes) => {
		const f = await create();
		await seed(f);
		const row = attemptRow(f);
		await insertAttempt(f.db, row);

		const result = updateAttempt(f.db, row, successor(row, changes));

		await expect(result).rejects.toThrow();
		expect(
			await f.db.all("SELECT * FROM traversal_attempts WHERE session_id=?1", [row.session_id]),
		).toEqual([row]);
	});
}

function registerLaterTransitions(create: CreateFixture) {
	it.each([
		[2, { offer_digest: "f".repeat(64) }],
		[2, { answer_digest: "f".repeat(64) }],
		[3, { answer_digest: null }],
		[3, { answer_digest: "G".repeat(64) }],
		[3, { last_request_digest: "f".repeat(64) }],
		[4, { answer_digest: "f".repeat(64) }],
		[4, { offer_digest: null }],
		[5, {}],
	] satisfies [number, Partial<Attempt>][])(
		"rejects phase %s digest rewrite or terminal advance %j",
		async (phase, changes) => {
			const f = await create();
			await seed(f);
			const initial = attemptRow(f);
			await insertAttempt(f.db, initial);
			const row = await advance(f, initial, phase);

			const result = updateAttempt(f.db, row, successor(row, changes));

			await expect(result).rejects.toThrow();
		},
	);
}

function registerSessionCollisions(create: CreateFixture) {
	it.each(INSERT_MODES)("aborts session collisions for %s", async (mode) => {
		const f = await create();
		await seed(f);
		const row = attemptRow(f);
		await insertAttempt(f.db, row);

		const result = insertAttempt(f.db, { ...row, target_device_id: "different" }, mode);

		await expect(result).rejects.toThrow();
		expect(
			await f.db.all("SELECT * FROM traversal_attempts WHERE session_id=?1", [row.session_id]),
		).toEqual([row]);
	});
}

function registerPairQuota(create: CreateFixture) {
	it.each(INSERT_MODES)("rejects a second live ordered pair via %s", async (mode) => {
		const f = await create();
		await seed(f);
		const row = attemptRow(f);
		await insertAttempt(f.db, row);

		const result = insertAttempt(f.db, { ...row, session_id: session(f, 3) }, mode);

		await expect(result).rejects.toThrow();
	});
}

function registerIndependentPairs(create: CreateFixture) {
	it("allows crossed pairs and identical pairs in another realm", async () => {
		const f = await create();
		await seed(f);
		const row = attemptRow(f);
		await insertAttempt(f.db, row);
		await f.db.run(REALM, [f.authority, "other", 1]);

		await insertAttempt(f.db, {
			...row,
			session_id: session(f, 3),
			source_device_id: "target",
			target_device_id: "source",
		});
		await insertAttempt(f.db, { ...row, session_id: session(f, 4), group_id: "other" });

		expect(
			await f.db.all("SELECT phase FROM traversal_attempts WHERE authority_id=?1", [f.authority]),
		).toHaveLength(3);
	});
}

function registerDeviceQuotas(create: CreateFixture) {
	it.each(["source", "target"] as const)(
		"allows four live attempts per %s and denies every fifth insertion path",
		async (side) => {
			const f = await create();
			await seed(f);
			const varyingColumn = side === "source" ? "target_device_id" : "source_device_id";
			for (let i = 1; i <= 4; i++)
				await insertAttempt(
					f.db,
					attemptRow(f, { session_id: session(f, i), [varyingColumn]: `peer-${i}` }),
				);

			for (const mode of INSERT_MODES)
				await expect(
					insertAttempt(
						f.db,
						attemptRow(f, { session_id: session(f, 5), [varyingColumn]: "peer-5" }),
						mode,
					),
				).rejects.toThrow();
			expect(
				await f.db.all("SELECT phase FROM traversal_attempts WHERE authority_id=?1", [f.authority]),
			).toHaveLength(4);
		},
	);
}

function registerInactiveAttempts(create: CreateFixture) {
	it.each(["expired", "completed"] as const)(
		"does not count %s attempts against pair or device quotas",
		async (kind) => {
			const f = await create();
			await seed(f);
			for (let i = 1; i <= 4; i++) {
				const overrides: Partial<Attempt> = { session_id: session(f, i) };
				if (kind === "expired")
					Object.assign(overrides, { prepare_created_at: 0, attempt_not_after: 55 });
				const row = attemptRow(f, overrides);
				await insertAttempt(f.db, row);
				if (kind === "completed") await advance(f, row, 5);
			}

			await insertAttempt(f.db, attemptRow(f, { session_id: session(f, 5) }));

			expect(
				await f.db.all("SELECT phase FROM traversal_attempts WHERE authority_id=?1", [f.authority]),
			).toHaveLength(5);
		},
	);
}

function registerRetention(create: CreateFixture) {
	it.each([1, 5])(
		"denies early deletion and permits old expired retention cleanup at phase %s",
		async (phase) => {
			const f = await create();
			await seed(f);
			const live = attemptRow(f);
			await insertAttempt(f.db, live);
			const expired = attemptRow(f, {
				session_id: session(f, 3),
				prepare_created_at: 0,
				attempt_not_after: 55,
			});
			await insertAttempt(f.db, expired);
			await advance(f, live, phase);
			await advance(f, expired, phase);

			await expect(
				f.db.run("DELETE FROM traversal_attempts WHERE session_id=?1", [live.session_id]),
			).rejects.toThrow();
			await f.db.run("DELETE FROM traversal_attempts WHERE session_id=?1", [expired.session_id]);
			expect(
				await f.db.all("SELECT session_id FROM traversal_attempts WHERE authority_id=?1", [
					f.authority,
				]),
			).toEqual([{ session_id: live.session_id }]);
		},
	);
}

function registerMissingRealm(create: CreateFixture) {
	it("rejects a valid-shaped attempt referencing a missing realm without storing a row", async () => {
		const f = await create();
		await seed(f);
		const row = attemptRow(f, { group_id: "missing" });

		const result = insertAttempt(f.db, row);

		await expect(result).rejects.toThrow();
		expect(
			await f.db.all("SELECT session_id FROM traversal_attempts WHERE authority_id=?1", [
				f.authority,
			]),
		).toEqual([]);
	});
}

async function saturateQuota(f: SchemaFixture, quota: "pair" | "source" | "target") {
	const limit = quota === "pair" ? 1 : 4;
	const varyingColumn = quota === "source" ? "target_device_id" : "source_device_id";
	const row = attemptRow(f);
	for (let i = 1; i <= limit; i++) {
		const changes: Partial<Attempt> = { session_id: session(f, i) };
		if (quota !== "pair") changes[varyingColumn] = `peer-${i}`;
		await insertAttempt(f.db, { ...row, ...changes });
	}
	const expired = {
		...row,
		session_id: session(f, 5),
		prepare_created_at: 0,
		attempt_not_after: 55,
	};
	const challenger = { ...row, session_id: session(f, 6) };
	if (quota !== "pair") {
		expired[varyingColumn] = "peer-1";
		challenger[varyingColumn] = "peer-5";
	}
	return { limit, expired, challenger };
}

function registerExpiredInsertsAfterSaturation(create: CreateFixture) {
	it.each(["pair", "source", "target"] as const)(
		"permits an expired insert after %s saturation without freeing live capacity",
		async (quota) => {
			const f = await create();
			await seed(f);
			const { limit, expired, challenger } = await saturateQuota(f, quota);
			const counts = () =>
				f.db.all(
					"SELECT count(*) AS total,sum(CASE WHEN phase<5 AND ?2<attempt_not_after*1000 THEN 1 ELSE 0 END) AS active FROM traversal_attempts WHERE authority_id=?1 AND group_id='group'",
					[f.authority, f.now],
				);
			expect(await counts()).toEqual([{ total: limit, active: limit }]);

			// Historical inserts do not consume capacity. They grant no HTTP admission.
			await insertAttempt(f.db, expired);

			expect(await counts()).toEqual([{ total: limit + 1, active: limit }]);
			await expect(insertAttempt(f.db, challenger)).rejects.toThrow();
			expect(await counts()).toEqual([{ total: limit + 1, active: limit }]);
		},
	);
}
