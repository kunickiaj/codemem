/**
 * The compile phase of the D1 statement check: rebuilds each captured schema in a local D1
 * and compiles every statement prepared on it there.
 *
 * D1 batches cut the round trips. A batch runs its statements in order and rolls all of
 * them back if one fails, so a batch that succeeds means each statement in it succeeds on
 * its own. When a batch fails, its statements run again one by one, exactly as they would
 * without batching, so every reported error comes from a statement run alone.
 */
import {
	aggregateAttempts,
	limitKind,
	orderSchema,
	schemaExclusionFor,
	schemaOrder,
	staticLimits,
	toCompileOnly,
} from "./classify.mjs";

// Statements per batch. Larger batches save little once round trips are amortized.
const BATCH_SIZE = 100;

/**
 * The local D1 with each statement prepared once. Through the platform proxy, preparing and
 * binding are each a round trip to the local runtime, which cost more than compiling. The
 * statement object only holds the SQL and its parameters, so D1 compiles it again against
 * the current schema every time it runs.
 */
function localD1(db) {
	const statements = new Map();
	return {
		batch: (list) => db.batch(list),
		statement(sql, values = []) {
			// Every bound value is null, so the SQL and how many values it binds identify it.
			const key = `${values.length}\n${sql}`;
			if (!statements.has(key)) statements.set(key, db.prepare(sql).bind(...values));
			return statements.get(key);
		},
	};
}

async function compileError(d1, sql, values) {
	try {
		await d1.statement(sql, values).all();
		return null;
	} catch (error) {
		return String(error?.message ?? error);
	}
}

/** Whether every statement ran in one batch. A failed batch has changed nothing. */
async function batchSucceeds(d1, statements) {
	try {
		await d1.batch(statements.map(({ sql, values }) => d1.statement(sql, values)));
		return true;
	} catch {
		return false;
	}
}

/** Runs statements in order and returns each one's error, or null where it succeeded. */
async function runInOrder(d1, statements) {
	if (statements.length > 1 && (await batchSucceeds(d1, statements)))
		return statements.map(() => null);
	const errors = [];
	for (const { sql, values } of statements) errors.push(await compileError(d1, sql, values));
	return errors;
}

/**
 * Each compile-only statement's error, or null where it compiled. They leave the database
 * unchanged, so a failed batch is split in half until each error is found alone.
 */
async function compileErrors(d1, statements) {
	if (statements.length === 0) return [];
	if (statements.length === 1)
		return [await compileError(d1, statements[0].sql, statements[0].values)];
	if (await batchSucceeds(d1, statements)) return statements.map(() => null);
	const half = statements.length >> 1;
	return [
		...(await compileErrors(d1, statements.slice(0, half))),
		...(await compileErrors(d1, statements.slice(half))),
	];
}

async function compileErrorsBatched(d1, statements) {
	const errors = [];
	for (let start = 0; start < statements.length; start += BATCH_SIZE)
		errors.push(...(await compileErrors(d1, statements.slice(start, start + BATCH_SIZE))));
	return errors;
}

const DROP_ORDER = ["trigger", "view", "index", "table"];

/** The local D1's own objects, which no captured schema names. */
async function currentSchema(d1) {
	const { results } = await d1
		.statement(
			"SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
		)
		.all();
	return results;
}

/** The objects of the schema now in the local D1 after dropping each one `objects` lacks or defines differently. */
async function dropStale(d1, objects) {
	const wanted = new Map(objects.map((object) => [object.name, object.sql]));
	const current = await currentSchema(d1);
	const stale = current
		.filter((object) => wanted.get(object.name) !== object.sql)
		.sort((a, b) => DROP_ORDER.indexOf(a.type) - DROP_ORDER.indexOf(b.type));
	if (stale.length === 0) return current;
	// A drop may fail once an earlier one took the object with it; that is expected.
	await runInOrder(
		d1,
		stale.map((object) => ({
			sql: `DROP ${object.type.toUpperCase()} IF EXISTS "${object.name}"`,
		})),
	);
	return currentSchema(d1);
}

/**
 * Makes the local D1 hold exactly `objects`: drops what differs, then creates what is
 * missing. Returns each object that could not be created.
 */
async function applySchema(d1, objects) {
	const present = new Set((await dropStale(d1, objects)).map((object) => object.name));
	const excluded = [];
	const creates = [];
	for (const object of orderSchema(objects)) {
		if (present.has(object.name)) continue;
		const exclusion = schemaExclusionFor(object);
		if (exclusion) excluded.push({ name: object.name, reason: exclusion.reason });
		else creates.push(object);
	}
	const errors = await runInOrder(d1, creates);
	const failures = creates.flatMap((object, index) =>
		errors[index] ? [{ name: object.name, error: errors[index] }] : [],
	);
	return { failures, excluded };
}

/** An outcome decided before the statement reaches D1, or the statement to compile there. */
function prepareOutcome(sql) {
	let compiled;
	try {
		compiled = toCompileOnly(sql);
	} catch (error) {
		return { outcome: { kind: "refused", message: String(error?.message ?? error) } };
	}
	const [limit] = staticLimits(sql, compiled.values.length);
	if (limit) return { outcome: { kind: "limit", limit } };
	return { compiled };
}

function errorOutcome(error) {
	if (!error) return { kind: "compiled" };
	const kind = limitKind(error);
	return kind ? { kind: "limit", limit: kind } : { kind: "error", message: error };
}

/** Each statement's outcome on the schema now in the local D1. */
async function compileOutcomes(d1, statements) {
	const prepared = statements.map(({ sql }) => prepareOutcome(sql));
	const pending = prepared.filter((entry) => entry.compiled);
	const errors = await compileErrorsBatched(
		d1,
		pending.map((entry) => entry.compiled),
	);
	pending.forEach((entry, index) => {
		entry.outcome = errorOutcome(errors[index]);
	});
	return prepared.map((entry) => entry.outcome);
}

/**
 * Compiles each statement on every schema it was prepared on and returns every attempt,
 * with the schema objects that could not be created or were excluded.
 */
export async function compileAttempts(db, capture) {
	const d1 = localD1(db);
	const attempts = [];
	const schemaFailures = new Map();
	const schemaExcluded = new Map();
	const bySchema = Map.groupBy(capture.statements, (statement) => statement.schema);
	const missing = [...bySchema.keys()].filter((hash) => !capture.schemas.has(hash));
	for (const hash of missing)
		for (const { sql, origin } of bySchema.get(hash))
			attempts.push({ sql, schema: hash, outcome: { kind: "schema_missing" }, origin });
	const rebuilt = schemaOrder(capture.schemas).filter((hash) => bySchema.has(hash));
	for (const hash of rebuilt) {
		const applied = await applySchema(d1, capture.schemas.get(hash));
		for (const failure of applied.failures)
			schemaFailures.set(`${failure.name}\n${failure.error}`, failure);
		for (const entry of applied.excluded) schemaExcluded.set(entry.name, entry);
		const statements = bySchema.get(hash);
		const outcomes = await compileOutcomes(d1, statements);
		statements.forEach(({ sql, origin }, index) => {
			attempts.push({ sql, schema: hash, outcome: outcomes[index], origin });
		});
	}
	return {
		attempts,
		schemaFailures: [...schemaFailures.values()],
		schemaExcluded: [...schemaExcluded.values()],
		schemas: bySchema.size,
		schemasRebuilt: rebuilt.length,
	};
}

/** Compiles every captured statement and returns the verdict for each. */
export async function checkStatements(db, capture) {
	const { attempts, ...rest } = await compileAttempts(db, capture);
	return { ...aggregateAttempts(attempts), ...rest };
}
