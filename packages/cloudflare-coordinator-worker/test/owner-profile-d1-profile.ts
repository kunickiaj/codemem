import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
} from "../../core/src/d1-coordinator-store.js";

export type OwnerProfileTraceStage =
	| "fixture-start"
	| "miniflare-start"
	| "miniflare-ready"
	| "schema-start"
	| "schema-ready"
	| "authority-start"
	| "authority-ready"
	| "prepare-start"
	| "prepare-ready"
	| "admit-start"
	| "admit-ready"
	| "adoption-start"
	| "adoption-ready"
	| "lost-reply-start"
	| "lost-reply-retained"
	| "client-request-start"
	| "client-request-end"
	| "browser-page-start"
	| "browser-page-ready"
	| "browser-claim-start"
	| "browser-claim-ready"
	| "browser-callback-start"
	| "browser-callback-ready"
	| "browser-confirm-start"
	| "browser-confirm-ready"
	| "reopen-start"
	| "reopen-ready"
	| "cleanup-start"
	| "cleanup-ready";

type Category =
	| "connection-schema-presence"
	| "connection-schema-readiness"
	| "owner-qualification-column"
	| "owner-qualification-readiness"
	| "select"
	| "insert"
	| "update"
	| "delete"
	| "other";
type Method = "first" | "all" | "run" | "raw" | "batch";
const META_FIELDS = ["duration", "rows_read", "rows_written"] as const;
type Metadata = Record<(typeof META_FIELDS)[number], { total: number; samples: number }>;
type Aggregate = {
	stage: OwnerProfileTraceStage;
	method: Method;
	category: Category | "batch";
	calls: number;
	inFlight: number;
	errors: number;
	// Sum of invocation durations, not elapsed stage time. Concurrent waits overlap.
	wallMs: number;
	statements: Partial<Record<Category, number>>;
	meta: Metadata;
};

function category(query: string): Category {
	const sql = query.trim();
	// Fixed shapes from readConnectionSchemaState and readOwnerLinkAuthority.
	if (
		sql.startsWith(
			"SELECT (SELECT (EXISTS (SELECT 1 FROM sqlite_master WHERE (name GLOB 'account_connection_*'",
		) &&
		sql.endsWith(" AS v2")
	)
		return "connection-schema-presence";
	if (sql.startsWith("SELECT min(column1) AS ready FROM (VALUES "))
		return "connection-schema-readiness";
	if (
		sql ===
		"SELECT EXISTS (SELECT 1 FROM pragma_table_info('coordinator_owner_enrollment_attempts') WHERE name='owner_qualification_id') AS present"
	)
		return "owner-qualification-column";
	if (isOwnerReadiness(sql)) return "owner-qualification-readiness";
	const verb = sql.split(/\s/, 1)[0]?.toLowerCase();
	if (verb === "select" || verb === "insert" || verb === "update" || verb === "delete") return verb;
	// CTEs, comments, pragmas and DDL are deliberately not parsed or printed.
	return "other";
}

function isOwnerReadiness(sql: string): boolean {
	if (!sql.endsWith(") AS ready")) return false;
	// Qualification ops use direct definitions. Owner authority normalizes the quoted
	// attempts-table header before checking its definition (0036 compatibility).
	return (
		sql.startsWith(
			"SELECT (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_owner_enrollment_",
		) ||
		(sql.startsWith("SELECT (EXISTS (SELECT 1 FROM (SELECT type,name,CASE WHEN substr(sql,1,") &&
			sql.includes(
				" ELSE sql END AS sql FROM sqlite_master) WHERE type = 'table' AND name = 'coordinator_owner_enrollment_attempts' COLLATE NOCASE",
			))
	);
}

function addMetadata(target: Metadata, result: unknown): void {
	if (!result || typeof result !== "object" || !("meta" in result)) return;
	const meta = result.meta;
	if (!meta || typeof meta !== "object") return;
	for (const field of META_FIELDS) {
		if (!(field in meta)) continue;
		const value = (meta as Record<string, unknown>)[field];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
		target[field].total += value;
		target[field].samples += 1;
	}
}

type ProfileState = {
	stage: OwnerProfileTraceStage;
	now: () => number;
	aggregates: Map<string, Aggregate>;
	originals: WeakMap<
		D1PreparedStatementLike,
		{ statement: D1PreparedStatementLike; category: Category }
	>;
};

function newAggregate(
	stage: OwnerProfileTraceStage,
	method: Method,
	category: Aggregate["category"],
): Aggregate {
	return {
		stage,
		method,
		category,
		calls: 0,
		inFlight: 0,
		errors: 0,
		wallMs: 0,
		statements: {},
		meta: {
			duration: { total: 0, samples: 0 },
			rows_read: { total: 0, samples: 0 },
			rows_written: { total: 0, samples: 0 },
		},
	};
}

function startInvocation(state: ProfileState, method: Method, categories: Category[]): Aggregate {
	const sqlCategory = method === "batch" ? "batch" : categories[0];
	const key = `${state.stage}/${method}/${sqlCategory}`;
	let aggregate = state.aggregates.get(key);
	if (!aggregate) {
		aggregate = newAggregate(state.stage, method, sqlCategory);
		state.aggregates.set(key, aggregate);
	}
	aggregate.calls += 1;
	aggregate.inFlight += 1;
	for (const category of categories)
		aggregate.statements[category] = (aggregate.statements[category] ?? 0) + 1;
	return aggregate;
}

async function measure<T>(
	state: ProfileState,
	method: Method,
	categories: Category[],
	invoke: () => Promise<T>,
): Promise<T> {
	const aggregate = startInvocation(state, method, categories);
	const start = state.now();
	try {
		const result = await invoke();
		// first() returns a user row and raw() returns rows, never a metadata envelope.
		if (method === "all" || method === "run") addMetadata(aggregate.meta, result);
		if (method === "batch" && Array.isArray(result))
			for (const entry of result) addMetadata(aggregate.meta, entry);
		return result;
	} catch (error) {
		aggregate.errors += 1;
		throw error;
	} finally {
		aggregate.inFlight -= 1;
		aggregate.wallMs += state.now() - start;
	}
}

function wrapStatement(
	state: ProfileState,
	statement: D1PreparedStatementLike,
	sqlCategory: Category,
): D1PreparedStatementLike {
	const wrapped = new Proxy(statement, {
		get(target, property) {
			if (property === "bind")
				return (...values: unknown[]) => wrapStatement(state, target.bind(...values), sqlCategory);
			if (property === "first" || property === "all" || property === "run" || property === "raw")
				return (...args: unknown[]) =>
					measure(state, property, [sqlCategory], () =>
						Reflect.apply(target[property], target, args),
					);
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	state.originals.set(wrapped, { statement, category: sqlCategory });
	return wrapped;
}

function wrapBatch(state: ProfileState, native: D1DatabaseLike) {
	const batch = native.batch;
	if (!batch) return batch;
	return (statements: D1PreparedStatementLike[]) => {
		const entries = statements.map(
			(statement) => state.originals.get(statement) ?? { statement, category: "other" as const },
		);
		return measure(
			state,
			"batch",
			entries.map((entry) => entry.category),
			() =>
				batch.call(
					native,
					entries.map((entry) => entry.statement),
				),
		);
	};
}

function wrapDatabase(state: ProfileState, native: D1DatabaseLike): D1DatabaseLike {
	return new Proxy(native, {
		get(target, property) {
			if (property === "prepare")
				return (sql: string) => wrapStatement(state, target.prepare(sql), category(sql));
			if (property === "batch") return wrapBatch(state, target);
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function snapshot(state: ProfileState) {
	// Pending calls count toward calls/inFlight, but wallMs updates only when they settle.
	const aggregates = structuredClone([...state.aggregates.values()]);
	return {
		calls: aggregates.reduce((sum, entry) => sum + entry.calls, 0),
		inFlight: aggregates.reduce((sum, entry) => sum + entry.inFlight, 0),
		wallMs: aggregates.reduce((sum, entry) => sum + entry.wallMs, 0),
		aggregates,
	};
}

// Test-only: no SQL, bindings, rows, request labels or error details enter aggregates.
export function profileOwnerD1(
	native: D1DatabaseLike,
	{
		enabled = process.env.CODEMEM_WORKER_D1_PROFILE,
		now = () => performance.now(),
	}: { enabled?: string; now?: () => number } = {},
) {
	const state: ProfileState = {
		stage: "schema-ready",
		now,
		aggregates: new Map(),
		originals: new WeakMap(),
	};
	return {
		db: enabled === "1" ? wrapDatabase(state, native) : native,
		setStage(value: OwnerProfileTraceStage) {
			state.stage = value;
		},
		summary() {
			return snapshot(state);
		},
	};
}
