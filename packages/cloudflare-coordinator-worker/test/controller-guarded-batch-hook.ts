/** One native execution: a single statement, or every statement of one atomic batch. */
export interface NativeExecution {
	queries: string[];
	binds: number[];
	batch: boolean;
}

// A controller review's winning write and its final answer: the batch its read-set guards
// lead, ending in the plain insert or the current-attestation read.
const CONTROLLER_INSERT = /^\s*INSERT INTO coordinator_auth_controller_attestations\s*\(/u;
const CONTROLLER_CURRENT = /^\s*SELECT a\.\* FROM coordinator_auth_controller_attestations a\b/u;

/** The guarded batch that writes a controller review, or the one that answers its retry. */
export function controllerGuardedStage(execution: NativeExecution): "create" | "retry" | null {
	const last = execution.queries.at(-1) ?? "";
	if (!execution.batch) return null;
	if (CONTROLLER_INSERT.test(last)) return "create";
	if (CONTROLLER_CURRENT.test(last)) return "retry";
	return null;
}

/**
 * Wraps native D1 so `before` runs ahead of each execution, then forwards the real
 * statements unchanged. Batches get the native statements back, and run atomically.
 */
export function hookNativeD1(
	native: D1Database,
	before: (execution: NativeExecution) => Promise<void>,
): D1Database {
	const statements = new WeakMap<
		D1PreparedStatement,
		{ native: D1PreparedStatement; query: string; binds: number }
	>();
	const wrap = (statement: D1PreparedStatement, query: string, binds = 0): D1PreparedStatement => {
		const wrapped = new Proxy(statement, {
			get(statement, property) {
				if (property === "bind")
					return (...values: unknown[]) => wrap(statement.bind(...values), query, values.length);
				if (property === "run" || property === "first" || property === "all" || property === "raw")
					return async (...args: unknown[]) => {
						await before({ queries: [query], binds: [binds], batch: false });
						return Reflect.apply(Reflect.get(statement, property), statement, args);
					};
				const value = Reflect.get(statement, property);
				return typeof value === "function" ? value.bind(statement) : value;
			},
		});
		statements.set(wrapped, { native: statement, query, binds });
		return wrapped;
	};
	return new Proxy(native, {
		get(database, property) {
			if (property === "prepare") return (query: string) => wrap(database.prepare(query), query);
			if (property === "batch")
				return async (batch: D1PreparedStatement[]) => {
					const entries = batch.map((statement) => {
						const entry = statements.get(statement);
						if (!entry) throw new Error("statement was not prepared through the hook");
						return entry;
					});
					await before({
						queries: entries.map(({ query }) => query),
						binds: entries.map(({ binds }) => binds),
						batch: true,
					});
					return database.batch(entries.map(({ native }) => native));
				};
			const value = Reflect.get(database, property);
			return typeof value === "function" ? value.bind(database) : value;
		},
	});
}
