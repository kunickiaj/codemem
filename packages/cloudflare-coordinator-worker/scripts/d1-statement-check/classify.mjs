/** Pure helpers for the D1 statement check. */

/**
 * Compile errors that name a D1 limit. D1's documented limits: 100 columns per table,
 * 100 bound parameters, 32 function arguments, 100,000-byte statements, 2,000,000-byte
 * values and 50-byte LIKE/GLOB patterns. Its SQLite also caps result columns at 100,
 * compound SELECTs at 5 terms, and how deeply WITH names and expressions nest.
 */
const LIMIT_ERRORS = [
	{ kind: "with_table_limit", text: "nested too deep" },
	{ kind: "expression_depth", text: "Expression tree is too large" },
	{ kind: "result_columns", text: "too many columns in result set" },
	{ kind: "table_columns", text: "too many columns on" },
	{ kind: "compound_select", text: "too many terms in compound SELECT" },
	{ kind: "function_arguments", text: "too many arguments on function" },
	{ kind: "bound_parameters", text: "too many SQL variables" },
	{ kind: "value_size", text: "string or blob too big" },
	{ kind: "statement_length", text: "statement too long" },
	{ kind: "like_pattern", text: "LIKE or GLOB pattern too complex" },
];
const MAX_PARAMETERS = 100;
const MAX_STATEMENT_BYTES = 100_000;

/** Returns the D1 limit a compile error names, or null for any other outcome. */
export function limitKind(message) {
	if (!message) return null;
	return LIMIT_ERRORS.find((limit) => message.includes(limit.text))?.kind ?? null;
}

/** The documented D1 limits a statement exceeds before it is compiled at all. */
export function staticLimits(sql, parameterCount) {
	const limits = [];
	if (parameterCount > MAX_PARAMETERS) limits.push("bound_parameters");
	if (new TextEncoder().encode(sql).byteLength > MAX_STATEMENT_BYTES)
		limits.push("statement_length");
	return limits;
}

class CompileRefusal extends Error {
	constructor(reason) {
		super(`cannot compile: ${reason}`);
	}
}

const isIdentifierChar = (ch) => /[A-Za-z0-9_$]/u.test(ch) || ch > "\u007f";

/** The index after a quoted run that closes with `close`; a doubled `close` escapes it. */
function skipQuoted(sql, start, close, { doubled }) {
	for (let i = start + 1; i < sql.length; i++) {
		if (sql[i] !== close) continue;
		if (doubled && sql[i + 1] === close) {
			i++;
			continue;
		}
		return i + 1;
	}
	throw new CompileRefusal(`unterminated ${close} quote`);
}

/**
 * Reads a statement the way SQLite's tokenizer does, as far as binding needs: strings,
 * quoted identifiers and comments hide `?`, `?NNN` sets the next index, `?` takes it.
 * Returns how many parameters SQLite numbers and whether the first word is EXPLAIN.
 * A CREATE TRIGGER body's semicolons belong to it until `; END`, as in sqlite3_complete.
 * Refuses named parameters (D1 binds by position only), a second statement and any
 * unterminated quote or comment, rather than guess.
 */
export function scanStatement(sql) {
	let highest = 0;
	const words = [];
	let ended = false;
	let inTriggerBody = false;
	let afterSemicolon = false;
	let i = 0;
	const isTrigger = () =>
		words[0] === "CREATE" &&
		(words[1] === "TRIGGER" || (/^TEMP(ORARY)?$/u.test(words[1] ?? "") && words[2] === "TRIGGER"));
	while (i < sql.length) {
		const ch = sql[i];
		const next = sql[i + 1];
		if (/\s/u.test(ch)) {
			i++;
			continue;
		}
		if (ch === "-" && next === "-") {
			const end = sql.indexOf("\n", i);
			i = end < 0 ? sql.length : end + 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = sql.indexOf("*/", i + 2);
			if (end < 0) throw new CompileRefusal("unterminated comment");
			i = end + 2;
			continue;
		}
		if (ended) throw new CompileRefusal("more than one statement");
		if (ch === ";") {
			if (!inTriggerBody) ended = true;
			afterSemicolon = true;
			i++;
			continue;
		}
		const followsSemicolon = afterSemicolon;
		afterSemicolon = false;
		if (ch === "'") i = skipQuoted(sql, i, "'", { doubled: true });
		else if (ch === '"') i = skipQuoted(sql, i, '"', { doubled: true });
		else if (ch === "`") i = skipQuoted(sql, i, "`", { doubled: true });
		else if (ch === "[") i = skipQuoted(sql, i, "]", { doubled: false });
		else if (ch === "?") {
			let end = i + 1;
			while (end < sql.length && /[0-9]/u.test(sql[end])) end++;
			if (end === i + 1) highest += 1;
			else {
				const index = Number(sql.slice(i + 1, end));
				if (index < 1 || index > 32766) throw new CompileRefusal(`parameter ?${index}`);
				highest = Math.max(highest, index);
			}
			i = end;
		} else if (ch === ":" || ch === "@" || ch === "$") {
			throw new CompileRefusal(`named parameter at offset ${i}`);
		} else if (isIdentifierChar(ch)) {
			let end = i;
			while (end < sql.length && isIdentifierChar(sql[end])) end++;
			const word = sql.slice(i, end).toUpperCase();
			words.push(word);
			if (word === "BEGIN" && isTrigger()) inTriggerBody = true;
			else if (word === "END" && inTriggerBody && followsSemicolon) inTriggerBody = false;
			i = end;
		} else {
			if (words.length === 0) words.push("");
			i++;
		}
	}
	if (inTriggerBody) throw new CompileRefusal("unterminated trigger body");
	return { parameterCount: highest, explains: words[0] === "EXPLAIN" };
}

/**
 * A statement D1 only compiles: EXPLAIN never runs it. The SQL is left exactly as
 * written and every parameter is bound to NULL, so literals and lengths stay real.
 */
export function toCompileOnly(sql) {
	const { parameterCount, explains } = scanStatement(sql);
	return {
		sql: explains ? sql : `EXPLAIN ${sql}`,
		values: Array.from({ length: parameterCount }, () => null),
	};
}

/**
 * Statements whose failure to compile on D1 is excused. Each names the exact function
 * that prepares it and the exact SQL, so a production statement never matches. Only
 * statements that never run on D1 belong here: test oracles and probes, and statements of
 * the built-in SQLite coordinator and local memory store that the same tests prepare. An
 * excused statement that does compile is still counted as checked.
 */
export const EXCLUSIONS = [
	{
		file: "coordinator-auth-lifecycle-upgrade-test-fixture.ts",
		function: "rawAuthSnapshot",
		sql: /^SELECT (?:s\.rowid AS original_rowid,)?typeof\(s\."[^"]+"\) AS "[^"]+:type",hex\(CAST\(s\./u,
		reason:
			"test oracle rawAuthSnapshot reads every legacy auth column three ways on local SQLite; over D1's 100 result columns, never run on D1",
	},
	{
		file: "better-sqlite-coordinator-store.ts",
		function: "initializeSchema",
		sql: /^ALTER TABLE \w+ ADD COLUMN \w+ TEXT$/u,
		reason: "the built-in SQLite coordinator's own column upgrade; D1 upgrades by migration",
	},
	{
		file: "coordinator-auth-historical-test-fixture.ts",
		function: "prepareHistoricalAccountDatabase",
		sql: /^PRAGMA database_list$/u,
		reason: "test fixture inspects its local SQLite file",
	},
	{
		file: "schema-bootstrap.ts",
		function: "isSqliteVecLoaded",
		sql: /^SELECT vec_version\(\) AS v$/u,
		reason: "local memory store probes its sqlite-vec extension",
	},
	{
		file: "db.ts",
		function: "hasPlannerStats",
		sql: /^SELECT 1 FROM sqlite_stat1 LIMIT 1$/u,
		reason: "local memory store reads its planner statistics",
	},
	{
		file: "local-identity-generation.ts",
		function: "readLocalIdentityGeneration",
		sql: /^SELECT actor_id FROM local_identity_generation WHERE id = 1$/u,
		reason: "local identity table of a device's own store",
	},
	{
		file: "coordinator-enrollment-context.ts",
		function: "identityGeneration",
		sql: /^SELECT generation, actor_id FROM local_identity_generation WHERE id = 1$/u,
		reason: "local identity table of a device's own store",
	},
	{
		file: "coordinator-runtime.test.ts",
		function: ["savePeerRotationSettings", ""],
		sql: /^UPDATE sync_peers SET name = @name,/u,
		reason: "test writes a device's local sync peer table with named parameters",
	},
	{
		file: "coordinator-account-link-runtime.test.ts",
		function: "localSnapshot",
		sql: /^SELECT \* FROM "memory_vectors"$/u,
		reason: "test snapshot of a device's local sqlite-vec table",
	},
	{
		file: "coordinator-auth-lifecycle-sqlite-recognition.test.ts",
		function: "snapshot",
		sql: /^SELECT \* FROM temp\."\w+"$/u,
		reason: "test snapshot of local SQLite temp tables",
	},
	{
		file: "coordinator-auth-lifecycle-upgrade.test.ts",
		function: "",
		sql: /^SELECT \* FROM external\.retained$/u,
		reason: "test reads an attached local SQLite file",
	},
	{
		file: "coordinator-device-revocation-store.test.ts",
		function: "exec",
		sql: /^CREATE TEMP TRIGGER (?:ignore_nonce|fail_nonce|fail_key_revocation) /u,
		reason: "test injects a failure with a temp trigger on local SQLite",
	},
	{
		file: "coordinator-identity-group-grant-store.test.ts",
		function: "exec",
		sql: /^CREATE TEMP TRIGGER fail_grant_insert /u,
		reason: "test injects a failure with a temp trigger on local SQLite",
	},
	{
		file: "coordinator-auth-store-test-fixtures.ts",
		function: "run",
		sql: /\b(?:record_suppressed_winner|fail_resolution_write)\(/u,
		reason: "test rewrites a statement to call a function it registers on local SQLite",
	},
	{
		file: "coordinator-auth-session-retention.test.ts",
		function: "",
		sql: /^(?: \/\* leading comment \*\/ BeGiN \/\* mode \*\/(?: (?:deferred|immediate|exclusive))?(?: transaction)?|COMMIT)$/u,
		reason: "test of transaction keyword recognition on local SQLite; D1 has no SQL transactions",
	},
	{
		file: "coordinator-auth-device-claim-schema.test.ts",
		function: "insert",
		sql: /^INSERT OR REPLACE INTO coordinator_auth_device_claims \((?:rowid|_rowid_|oid),/u,
		reason: "test probes that the WITHOUT ROWID claims table rejects rowid aliases",
	},
	{
		file: "coordinator-owner-enrollment-qualification-schema.test.ts",
		function: "query",
		sql: /^SELECT (?:rowid|_rowid_|oid) FROM coordinator_owner_enrollment_qualifications$/u,
		reason: "test probes that the WITHOUT ROWID qualifications table rejects rowid aliases",
	},
	{
		file: "coordinator-owner-enrollment-qualification-schema.test.ts",
		function: "exec",
		sql: /^(?:UPDATE coordinator_owner_enrollment_qualifications SET (?:rowid|_rowid_|oid) = \?|INSERT INTO coordinator_owner_enrollment_qualifications \(.*\b(?:rowid|_rowid_|oid)\b)/su,
		reason: "test probes that the WITHOUT ROWID qualifications table rejects rowid aliases",
	},
	{
		file: "coordinator-owner-enrollment-commit-test-fixtures.ts",
		function: "run",
		sql: /^INSERT INTO nonexistent_commit_test_table VALUES \(1\)$/u,
		reason: "test makes a batch fail on a table that does not exist",
	},
	{
		file: "coordinator-auth-read-set.test.ts",
		function: "run",
		sql: /^INSERT INTO missing_table VALUES \(1\)$/u,
		reason: "test makes a batch fail on a table that does not exist",
	},
];

/**
 * Schema objects the local D1 cannot create, by name and the exact reason. They belong to
 * a device's local memory store, which tests open beside the coordinator.
 */
export const SCHEMA_EXCLUSIONS = [
	{
		name: "memory_vectors",
		sql: /^CREATE VIRTUAL TABLE memory_vectors USING vec0\(/u,
		reason: "sqlite-vec table of the local memory store; D1 has no vec0 module",
	},
];

// Frames above the prepare call where the preparing function may sit: callbacks such as
// a map callback and Array.map come first.
const ORIGIN_FRAMES = 6;

/** The exclusion that matches where and what a statement was prepared, or null. */
export function exclusionFor(sql, origin, exclusions = EXCLUSIONS) {
	const frames = (origin ?? []).slice(0, ORIGIN_FRAMES);
	return (
		exclusions.find(
			(entry) =>
				entry.sql.test(sql) &&
				frames.some(
					(frame) =>
						[entry.function].flat().includes(frame.function) && frame.file?.endsWith(entry.file),
				),
		) ?? null
	);
}

/** Whether a schema object is a known local-store object the local D1 cannot create. */
export function schemaExclusionFor(object) {
	return (
		SCHEMA_EXCLUSIONS.find((entry) => entry.name === object.name && entry.sql.test(object.sql)) ??
		null
	);
}

/**
 * The verdict for each statement from its compile attempts on every schema it was
 * prepared on. A limit on any schema puts it over the limit. Otherwise it is checked
 * once it compiled on one schema: tests also prepare statements on schemas that lack a
 * table on purpose. A statement that compiled nowhere is unchecked. An exclusion only
 * excuses a statement that is over a limit or unchecked.
 */
export function aggregateAttempts(attempts, { exclusions = EXCLUSIONS } = {}) {
	const bySql = Map.groupBy(attempts, (entry) => entry.sql);
	const result = {
		total: bySql.size,
		attempts: attempts.length,
		checked: 0,
		erroredElsewhere: 0,
		overLimit: [],
		unchecked: [],
		excluded: [],
		schemaFailures: [],
		unusedExclusions: [],
	};
	const used = new Set();
	for (const [sql, entries] of bySql) {
		const origin = entries.find((entry) => entry.origin?.length)?.origin ?? [];
		const failed = entries.filter(({ outcome }) => outcome.kind !== "compiled");
		const limits = [
			...new Set(entries.flatMap(({ outcome }) => (outcome.kind === "limit" ? [outcome.limit] : []))),
		];
		// The same SQL may be prepared from several places; any of them may be the excused one.
		const exclusion =
			entries
				.map((entry) => exclusionFor(sql, entry.origin, exclusions))
				.find((match) => match !== null) ?? null;
		if (exclusion) used.add(exclusion);
		const compiledSomewhere = failed.length < entries.length;
		if (exclusion && (limits.length || !compiledSomewhere)) {
			result.excluded.push({ sql, reason: exclusion.reason });
			continue;
		}
		if (limits.length) {
			result.overLimit.push({ sql, limits, origin });
			continue;
		}
		if (compiledSomewhere) {
			result.checked += 1;
			result.erroredElsewhere += failed.length;
			continue;
		}
		const errors = [...new Set(failed.map(({ outcome }) => outcome.message ?? outcome.kind))];
		result.unchecked.push({ sql, errors, origin });
	}
	// An exclusion nothing matched is stale and could hide a renamed production statement.
	result.unusedExclusions = exclusions.filter((entry) => !used.has(entry)).map((entry) => entry.reason);
	return result;
}

/** Passes only when every statement was checked or explicitly excluded, and none is over a limit. */
export function verdict(result) {
	const problems = [];
	if (result.overLimit.length) problems.push(`${result.overLimit.length} exceed D1 limits`);
	if (result.unchecked.length) problems.push(`${result.unchecked.length} could not be checked`);
	if (result.schemaFailures.length)
		problems.push(`${result.schemaFailures.length} schema objects could not be created`);
	if (result.unusedExclusions?.length)
		problems.push(`${result.unusedExclusions.length} exclusions matched no statement`);
	if (problems.length) return { ok: false, message: `Statement check failed: ${problems.join(", ")}.` };
	return { ok: true, message: "Every captured statement compiles within D1 limits." };
}

/**
 * Reads captured records: one entry per statement and schema it was prepared on, with
 * the frames that prepared it, and each captured schema by its hash.
 */
export function readCapture(lines) {
	const statements = new Map();
	const schemas = new Map();
	for (const line of lines) {
		if (!line.trim()) continue;
		const { kind, hash, value } = JSON.parse(line);
		if (kind === "statement") statements.set(hash, value);
		else if (kind === "schema") schemas.set(value.hash, value.objects);
	}
	return { statements: [...statements.values()], schemas };
}

const SCHEMA_ORDER = ["table", "index", "view", "trigger"];
// The tables FTS5 creates for each of its virtual tables.
const SHADOW_SUFFIXES = ["data", "idx", "content", "docsize", "config"];

/**
 * Tables first, so indexes, views and triggers find them. A virtual table's shadow tables
 * are left out: creating the virtual table creates them, and SQLite reserves their names.
 */
export function orderSchema(objects) {
	const virtual = objects
		.filter((object) => /^CREATE VIRTUAL TABLE/iu.test(object.sql ?? ""))
		.map((object) => object.name);
	const shadow = new Set(
		virtual.flatMap((name) => SHADOW_SUFFIXES.map((suffix) => `${name}_${suffix}`)),
	);
	return objects
		.filter(
			(object) =>
				SCHEMA_ORDER.includes(object.type) &&
				!object.name.startsWith("sqlite_") &&
				!shadow.has(object.name),
		)
		.sort((a, b) => SCHEMA_ORDER.indexOf(a.type) - SCHEMA_ORDER.indexOf(b.type));
}
