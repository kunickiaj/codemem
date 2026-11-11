/** Pure helpers for the D1 statement check. */

/** D1 refuses these at compile time; anything else is unrelated to statement shape. */
const LIMIT_ERRORS = [
	{ kind: "with_table_limit", text: "nested too deep" },
	{ kind: "expression_depth", text: "Expression tree is too large" },
];

/**
 * Turns a captured statement into one D1 only compiles. EXPLAIN never runs the
 * statement, and literal placeholders avoid D1's bound-parameter count check.
 */
export function toCompileOnly(sql) {
	const literal = sql.replace(/\?\d*/g, "'x'").trimStart();
	return /^EXPLAIN\b/i.test(literal) ? literal : `EXPLAIN ${literal}`;
}

/** Returns the D1 limit a compile error names, or null for any other outcome. */
export function limitKind(message) {
	if (!message) return null;
	return LIMIT_ERRORS.find((limit) => message.includes(limit.text))?.kind ?? null;
}

/** Reads captured records, keeping one statement per hash and one definition per schema object. */
export function readCapture(lines) {
	const statements = new Map();
	const schema = new Map();
	for (const line of lines) {
		if (!line.trim()) continue;
		const { kind, hash, value } = JSON.parse(line);
		if (kind === "statement") statements.set(hash, value);
		// Fixtures for older schema versions redefine tables. The longest definition is the newest.
		else if (kind === "schema" && value.sql.length > (schema.get(value.name)?.sql.length ?? 0))
			schema.set(value.name, value);
	}
	return { statements: [...statements.values()], schema: [...schema.values()] };
}

const SCHEMA_ORDER = ["table", "index", "view", "trigger"];

/** Tables first, so indexes, views and triggers find them. */
export function orderSchema(objects) {
	return objects
		.filter((object) => SCHEMA_ORDER.includes(object.type) && !object.name.startsWith("sqlite_"))
		.sort((a, b) => SCHEMA_ORDER.indexOf(a.type) - SCHEMA_ORDER.indexOf(b.type));
}

/**
 * Compares this run with the recorded baseline. The baseline is a ceiling that only
 * moves down: new over-limit statements fail, and fewer ask for the baseline to drop.
 */
export function compareWithBaseline(overLimit, baseline) {
	if (overLimit > baseline.overLimit)
		return {
			ok: false,
			message: `${overLimit} statements exceed D1 limits; the baseline allows ${baseline.overLimit}.`,
		};
	if (overLimit < baseline.overLimit)
		return {
			ok: false,
			message: `${overLimit} statements exceed D1 limits, fewer than the baseline of ${baseline.overLimit}. Lower overLimit in baseline.json to ${overLimit}.`,
		};
	return { ok: true, message: `${overLimit} statements exceed D1 limits, matching the baseline.` };
}
