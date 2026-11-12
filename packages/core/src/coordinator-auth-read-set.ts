import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";

/**
 * Read-set validation for coordinator authorization.
 *
 * D1 has no interactive transactions, so a decision cannot read, decide and write under
 * one lock. A decision instead works in three steps:
 *
 * 1. Read the facts with small plain queries ({@link readSnapshot}).
 * 2. Decide in TypeScript from those rows alone.
 * 3. Write in one atomic batch whose first statements re-run every read and abort the
 *    batch unless each read still supports the decision ({@link writeGuarded}).
 *
 * The decision is void unless its guards run in the batch that writes.
 */

/**
 * One fact query. It returns one JSON value per row in a column named `row`, usually
 * `json_object(...) AS row`. It needs an explicit ORDER BY so the same rows always give
 * the same text. Write it without a WITH clause: production D1 refuses large statements
 * that resolve WITH names, and the guard embeds the read a second time.
 *
 * A read may compute a 0/1 verdict in SQL, such as `'proven', EXISTS (...)`, when a
 * proof joins several tables and its NULL handling is easier to keep exact in SQL. The
 * guard re-runs the whole read, so the verdict is evaluated again inside the winning
 * batch and a changed verdict aborts it.
 */
export interface AuthRead extends AuthLinkStatement {
	/**
	 * Replaces the default guard, which requires the read to return byte-identical rows.
	 * Use it only when the decision survives some changes to those rows, for example a
	 * list that may lose entries but must not gain any. It receives the JSON array text
	 * of the rows that were read, and returns a statement with exactly one value: 1 while
	 * the decision still holds.
	 */
	holds?: (seenRows: string) => AuthLinkStatement;
}

/** The caller states the row shape of its own reads; the rows come from its SQL. */
type RowsByName = Record<string, unknown[]>;

export interface AuthReadSnapshot<Rows extends RowsByName> {
	/** Parsed rows of each read. */
	rows: Rows;
	/** One statement per read. Each aborts its batch when the read no longer holds. */
	guards: Record<keyof Rows, AuthLinkStatement>;
}

export type GuardedWriteResult =
	/** Every guard held and every write assertion passed. */
	| "committed"
	/** A read no longer supports the decision. Nothing was written. */
	| "changed"
	/** A write changed an unexpected number of rows. Nothing was written. */
	| "unmatched";

// json_extract rejects a path without a leading "$", so SQLite raises an error that names
// the path. SQLite and D1 both put the path in the error message. Callers never see the
// markers: writeGuarded turns them into a GuardedWriteResult.
const SNAPSHOT_CHANGED = "auth_snapshot_changed";
const WRITE_UNMATCHED = "auth_write_unmatched";

function abortUnless(condition: string, marker: string): string {
	return `SELECT CASE WHEN ${condition} THEN 1 ELSE json_extract('{}', '${marker}') END AS held`;
}

const collected = (sql: string) =>
	`SELECT coalesce(json_group_array(json(row)), '[]') AS rows FROM (${sql})`;

/** An SQL condition that is true while the read still supports the decision. */
function holdsCondition(read: AuthRead, seenRows: string): AuthLinkStatement {
	if (!read.holds)
		return { sql: `(${collected(read.sql)}) IS ?`, values: [...read.values, seenRows] };
	const predicate = read.holds(seenRows);
	return { sql: `(SELECT * FROM (${predicate.sql})) IS 1`, values: predicate.values };
}

const abortWhenChanged = (condition: AuthLinkStatement): AuthLinkStatement => ({
	sql: abortUnless(condition.sql, SNAPSHOT_CHANGED),
	values: condition.values,
});

/**
 * A guard from a caller's own SQL condition, for reads whose rows are compared another
 * way than the default guard does. It aborts its batch, as a changed read does, unless
 * the condition is true.
 */
export const snapshotGuard = abortWhenChanged;

export interface ReadSnapshotOptions {
	/**
	 * Builds each guard from its condition instead of the default guard, whose failure
	 * {@link writeGuarded} reports as "changed". For a batch that must fail its own way,
	 * or must check the read only when another condition of that batch holds.
	 */
	guard?: (condition: AuthLinkStatement) => AuthLinkStatement;
}

/** Follows a write in the batch. Aborts unless that write changed exactly `expected` rows. */
export function changedRows(expected = 1): AuthLinkStatement {
	return { sql: abortUnless("changes() = ?", WRITE_UNMATCHED), values: [expected] };
}

type RowReader = Pick<AuthLinkBackend, "first" | "readBatch">;
type Collected = { rows: string } | null | undefined;

// Without a read batch the reads run one by one. That is still safe: the guards re-check
// every read in the write batch, so a write commits only if all of them hold at once.
async function firstRows(
	backend: RowReader,
	statements: AuthLinkStatement[],
): Promise<Collected[]> {
	if (backend.readBatch)
		return (await backend.readBatch<{ rows: string }>(statements)).map((rows) => rows[0]);
	const rows: Collected[] = [];
	for (const statement of statements) rows.push(await backend.first<{ rows: string }>(statement));
	return rows;
}

async function readCollected(
	backend: RowReader,
	statements: AuthLinkStatement[],
): Promise<string[]> {
	if (statements.length === 0) return [];
	return (await firstRows(backend, statements)).map((row) => {
		if (typeof row?.rows !== "string") throw new Error("auth_read_set_unavailable");
		return row.rows;
	});
}

function parseRows(text: string): unknown[] {
	const rows: unknown = JSON.parse(text);
	if (!Array.isArray(rows)) throw new Error("auth_read_set_unavailable");
	return rows;
}

/** Runs the named reads and returns their rows with the guards that pin them. */
export async function readSnapshot<Rows extends RowsByName>(
	backend: RowReader,
	reads: Record<keyof Rows, AuthRead>,
	options: ReadSnapshotOptions = {},
): Promise<AuthReadSnapshot<Rows>> {
	const guardFor = (read: AuthRead, seenRows: string) =>
		(options.guard ?? abortWhenChanged)(holdsCondition(read, seenRows));
	const names = Object.keys(reads) as (keyof Rows)[];
	const seen = await readCollected(
		backend,
		names.map((name) => ({ sql: collected(reads[name].sql), values: reads[name].values })),
	);
	const entries = names.map((name, index) => ({ name, text: seen[index] as string }));
	return {
		rows: Object.fromEntries(entries.map(({ name, text }) => [name, parseRows(text)])) as Rows,
		guards: Object.fromEntries(
			entries.map(({ name, text }) => [name, guardFor(reads[name], text)]),
		) as Record<keyof Rows, AuthLinkStatement>,
	};
}

/** Whether an error is a default guard's refusal: a read no longer holds. */
export function isSnapshotChanged(error: unknown): boolean {
	return String((error as { message?: unknown } | null)?.message ?? error).includes(
		SNAPSHOT_CHANGED,
	);
}

/** A backend whose reads can run together as one snapshot. */
export type AtomicReader = Required<Pick<AuthLinkBackend, "readBatch">>;

/**
 * Types a store backend's read batch as required. Every store backend has one. A
 * backend without it refuses each read batch instead of reading one statement at a
 * time, which would check the guards at different moments.
 */
export function requireReadBatch<B extends Pick<AuthLinkBackend, "readBatch">>(
	backend: B,
): Omit<B, "readBatch"> & AtomicReader {
	const readBatch = backend.readBatch?.bind(backend);
	const refuse = async <T>(): Promise<T[][]> => {
		throw new Error("auth_read_batch_required");
	};
	return { ...backend, readBatch: readBatch ?? refuse };
}

/**
 * Runs the guards and then `statement` as one read batch, and returns the statement's
 * first row. `changed` when a guard no longer holds.
 */
export async function readAfterGuards<T>(
	backend: AtomicReader,
	guards: readonly AuthLinkStatement[],
	statement: AuthLinkStatement,
): Promise<{ changed: true } | { changed: false; row: T | null }> {
	try {
		const rows = await backend.readBatch<T>([...guards, statement]);
		return { changed: false, row: rows[guards.length]?.[0] ?? null };
	} catch (error) {
		if (isSnapshotChanged(error)) return { changed: true };
		throw error;
	}
}

/** Whether every guard still holds, checked together in one read batch. */
export async function guardsHold(
	backend: AtomicReader,
	guards: readonly AuthLinkStatement[],
): Promise<boolean> {
	const read = await readAfterGuards(backend, guards, { sql: "SELECT 1 AS held", values: [] });
	return !read.changed;
}

/**
 * Runs the guards and then the writes as one atomic batch. Any other error propagates,
 * so an unknown outcome is never reported as a refusal.
 */
export async function writeGuarded(
	backend: Pick<AuthLinkBackend, "batch">,
	guards: readonly AuthLinkStatement[],
	writes: readonly AuthLinkStatement[],
): Promise<GuardedWriteResult> {
	try {
		await backend.batch([...guards, ...writes]);
		return "committed";
	} catch (error) {
		if (isSnapshotChanged(error)) return "changed";
		const message = String((error as { message?: unknown } | null)?.message ?? error);
		if (message.includes(WRITE_UNMATCHED)) return "unmatched";
		throw error;
	}
}
