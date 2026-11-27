import type { Database } from "better-sqlite3";

export interface CapturedPlan {
	sql: string;
	/** The `detail` column of EXPLAIN QUERY PLAN, one entry per step. */
	steps: string[];
}

function tableAliases(sql: string, table: string): string[] {
	const pattern = new RegExp(
		`\\b(?:from|join|update|into)\\s+["\`]?${table}["\`]?(?:\\s+(?:as\\s+)?["\`]?(\\w+)["\`]?)?`,
		"gi",
	);
	const reserved = new Set([
		"where",
		"inner",
		"left",
		"join",
		"on",
		"set",
		"order",
		"group",
		"limit",
		"indexed",
	]);
	const aliases = new Set<string>();
	for (const match of sql.matchAll(pattern)) {
		aliases.add(table);
		const alias = match[1]?.toLowerCase();
		if (alias && !reserved.has(alias)) aliases.add(alias);
	}
	return [...aliases];
}

function explain(db: Database, statements: Iterable<string>): CapturedPlan[] {
	const plans: CapturedPlan[] = [];
	for (const sql of statements) {
		if (!/^\s*(select|insert|update|delete|with)\b/i.test(sql)) continue;
		const parameters = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null);
		const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{
			detail: string;
		}>;
		plans.push({ sql, steps: rows.map((row) => row.detail) });
	}
	return plans;
}

/** Records every statement prepared on `db` until `stop`, which returns their query plans. */
export function recordPlans(db: Database): { stop(): CapturedPlan[] } {
	const prepare = db.prepare;
	const seen = new Set<string>();
	db.prepare = ((sql: string) => {
		seen.add(sql);
		return prepare.call(db, sql);
	}) as Database["prepare"];
	return {
		stop() {
			db.prepare = prepare;
			return explain(db, seen);
		},
	};
}

/** Runs `work` and returns the query plan of every row statement it prepared on `db`. */
export function capturePlans(db: Database, work: () => void): CapturedPlan[] {
	const recording = recordPlans(db);
	let plans: CapturedPlan[] = [];
	try {
		work();
	} finally {
		// Also restores `prepare` when `work` throws.
		plans = recording.stop();
	}
	return plans;
}

/**
 * The statements whose plan reads a whole table or a whole index of it. `SCAN` is SQLite's
 * word for that; a lookup or a range is a `SEARCH`. `exceptIndexes` names partial indexes
 * that hold only the rows with work, where reading all of the index is the intent.
 */
export function statementsScanning(
	plans: CapturedPlan[],
	table: string,
	options: { exceptIndexes?: readonly string[] } = {},
): string[] {
	const allowed = (step: string) =>
		(options.exceptIndexes ?? []).some((index) => step.includes(`INDEX ${index}`));
	return plans
		.filter(({ sql, steps }) =>
			tableAliases(sql, table).some((alias) =>
				steps.some((step) => new RegExp(`^SCAN ${alias}\\b`, "i").test(step) && !allowed(step)),
			),
		)
		.map(({ sql }) => sql.replace(/\s+/g, " ").trim());
}
