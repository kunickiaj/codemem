import { afterEach, expect, it, vi } from "vitest";
import type { AuthLinkBackend, AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { OwnerEnrollmentQualificationOps } from "../../core/src/coordinator-owner-enrollment-qualification.js";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
} from "../../core/src/d1-coordinator-store.js";
import { readOwnerLinkAuthority } from "../../core/src/owner-enrollment-link-authority.js";
import { profileOwnerD1 } from "../test/owner-profile-d1-profile.js";

const SECRET = "synthetic-sensitive-value";
class Statement implements D1PreparedStatementLike {
	constructor(readonly values: unknown[] = []) {}
	bind(...values: unknown[]) {
		return new Statement(values);
	}
	async first<T>() {
		return this.result as T;
	}
	async all<T>() {
		return this.result as { results: T[] };
	}
	async run() {
		return this.result;
	}
	async raw<T>() {
		return this.result as T[];
	}
	result: unknown = { results: [{ credential: SECRET }] };
}

function fixture() {
	const statement = new Statement();
	const batchResult = [{ meta: { duration: 2, rows_read: 3, rows_written: 1 } }];
	const native = {
		prepare: vi.fn(() => statement),
		batch: vi.fn(async (_statements: D1PreparedStatementLike[]) => batchResult),
		exec: vi.fn(async (_sql: string) => statement.result),
	};
	let tick = 0;
	const now = vi.fn(() => tick++);
	const profile = profileOwnerD1(native, { enabled: "1", now });
	return { statement, batchResult, native, now, profile, db: profile.db };
}

async function sourceSchemaProbes() {
	const queries: string[] = [];
	const backend: AuthLinkBackend = {
		async first<T>(statement: AuthLinkStatement) {
			queries.push(statement.sql);
			return { present: 1, v2: 1, ready: 1 } as T;
		},
		run: vi.fn(async () => 0),
		batch: vi.fn(async () => []),
	};
	await readOwnerLinkAuthority(backend, 0);
	await new OwnerEnrollmentQualificationOps(backend, {
		enabled: true,
		coordinatorId: "fixture-coordinator",
		issuer: "https://issuer.example.test",
		revision: "a".repeat(64),
	}).schemaReady();
	return queries;
}

afterEach(() => vi.unstubAllEnvs());

it.each(["first", "all", "run", "raw"] as const)(
	"preserves %s results, arguments and receiver while measuring one invocation",
	async (method) => {
		// Arrange: a fake monotonic clock avoids timing-dependent assertions.
		const { statement, native, db, profile, now } = fixture();
		const invoke = vi.spyOn(statement, method);
		profile.setStage("browser-confirm-start");
		const wrapped = db.prepare(`SELECT '${SECRET}'`);
		// Act: forward native optional arguments even though the core interface omits them.
		const result = await Reflect.apply(wrapped[method], wrapped, [SECRET]);
		// Assert: values and receiver remain native, and profiling issues no additional queries.
		expect(result).toBe(statement.result);
		expect(invoke).toHaveBeenCalledExactlyOnceWith(SECRET);
		expect(invoke.mock.contexts).toEqual([statement]);
		expect(native.prepare).toHaveBeenCalledExactlyOnceWith(`SELECT '${SECRET}'`);
		expect(native.batch).not.toHaveBeenCalled();
		expect(now).toHaveBeenCalledTimes(2);
		expect(profile.summary()).toMatchObject({
			calls: 1,
			wallMs: 1,
			aggregates: [{ stage: "browser-confirm-start", method, category: "select", errors: 0 }],
		});
		expect(JSON.stringify(profile.summary())).not.toContain(SECRET);
	},
);

it.each(["first", "all", "run", "raw"] as const)(
	"preserves the original %s rejection without exposing its details",
	async (method) => {
		// Arrange
		const { statement, db, profile } = fixture();
		const error = new Error(SECRET);
		vi.spyOn(statement, method).mockRejectedValue(error);
		// Act
		const pending = db.prepare(`UPDATE private_table SET credential = '${SECRET}'`)[method]();
		// Assert
		await expect(pending).rejects.toBe(error);
		expect(profile.summary()).toMatchObject({
			calls: 1,
			wallMs: 1,
			aggregates: [{ category: "update", errors: 1 }],
		});
		expect(JSON.stringify(profile.summary())).not.toContain(SECRET);
	},
);

it("preserves repeated binding and passes original native statements to one batch call", async () => {
	// Arrange
	const { statement, native, db, profile, batchResult } = fixture();
	const bind = vi.spyOn(statement, "bind");
	const external = new Statement(["external"]);
	const bound = db.prepare("INSERT INTO private_table VALUES (?)").bind("old").bind(SECRET, null);
	const select = db.prepare("SELECT 1");
	// Act
	const result = await db.batch?.([bound, select, external]);
	// Assert: proxies would fail a real native D1 batch, and re-binding must replace bindings.
	expect(result).toBe(batchResult);
	expect(bind).toHaveBeenCalledExactlyOnceWith("old");
	expect(native.batch).toHaveBeenCalledTimes(1);
	const delegated = native.batch.mock.calls[0][0];
	expect(delegated[0]).toBeInstanceOf(Statement);
	expect(delegated[0]).not.toBe(bound);
	expect((delegated[0] as Statement).values).toEqual([SECRET, null]);
	expect(delegated[1]).toBe(statement);
	expect(delegated[2]).toBe(external);
	expect(native.batch.mock.contexts).toEqual([native]);
	expect(profile.summary()).toMatchObject({
		calls: 1,
		aggregates: [
			{
				method: "batch",
				category: "batch",
				statements: { insert: 1, select: 1, other: 1 },
				meta: {
					duration: { total: 2, samples: 1 },
					rows_read: { total: 3, samples: 1 },
					rows_written: { total: 1, samples: 1 },
				},
			},
		],
	});
	expect(JSON.stringify(profile.summary())).not.toContain(SECRET);
});

it.each(["reject", "throw"])("preserves a batch %s and counts it once", async (failure) => {
	// Arrange
	const { native, db, profile } = fixture();
	const error = new Error(SECRET);
	if (failure === "reject") native.batch.mockRejectedValue(error);
	else
		native.batch.mockImplementation(() => {
			throw error;
		});
	// Act
	const pending = db.batch?.([db.prepare("DELETE FROM private_table")]);
	// Assert
	await expect(pending).rejects.toBe(error);
	expect(native.batch).toHaveBeenCalledTimes(1);
	expect(profile.summary()).toMatchObject({ calls: 1, wallMs: 1, aggregates: [{ errors: 1 }] });
	expect(JSON.stringify(profile.summary())).not.toContain(SECRET);
});

it("delegates an empty batch once without inventing statements or metadata", async () => {
	// Arrange
	const { native, db, profile } = fixture();
	const empty: [] = [];
	native.batch.mockResolvedValue(empty);
	// Act
	const result = await db.batch?.([]);
	// Assert
	expect(result).toBe(empty);
	expect(native.batch).toHaveBeenCalledExactlyOnceWith([]);
	expect(profile.summary()).toMatchObject({
		calls: 1,
		aggregates: [{ statements: {}, meta: { duration: { total: 0, samples: 0 } } }],
	});
});

it.each(["prepare", "bind"] as const)(
	"preserves synchronous %s errors without counting SQL execution",
	(method) => {
		// Arrange
		const { native, statement, db, profile, now } = fixture();
		const error = new Error(SECRET);
		const fail = () => {
			throw error;
		};
		if (method === "prepare") native.prepare.mockImplementation(fail);
		else vi.spyOn(statement, "bind").mockImplementation(fail);
		// Act
		const invoke = () => db.prepare(SECRET).bind(SECRET);
		// Assert
		expect(invoke).toThrow(error);
		expect(now).not.toHaveBeenCalled();
		expect(profile.summary()).toEqual({ calls: 0, inFlight: 0, wallMs: 0, aggregates: [] });
	},
);

it("aggregates only returned numeric D1 metadata, never first/raw row fields", async () => {
	// Arrange
	const { statement, db, profile } = fixture();
	statement.result = {
		credential: SECRET,
		meta: { duration: 2, rows_read: 0, rows_written: 1, credential: SECRET },
	};
	const prepared = db.prepare("SELECT 1");
	// Act
	await prepared.first();
	await prepared.raw();
	await prepared.all();
	await prepared.all();
	await prepared.run();
	// Assert: first/raw have no D1 envelope even when a row resembles one.
	const entries = profile.summary().aggregates;
	for (const method of ["first", "raw"])
		expect(entries.find((entry) => entry.method === method)?.meta).toEqual({
			duration: { total: 0, samples: 0 },
			rows_read: { total: 0, samples: 0 },
			rows_written: { total: 0, samples: 0 },
		});
	expect(entries.find((entry) => entry.method === "all")).toMatchObject({
		calls: 2,
		wallMs: 2,
		meta: {
			duration: { total: 4, samples: 2 },
			rows_read: { total: 0, samples: 2 },
			rows_written: { total: 2, samples: 2 },
		},
	});
	expect(entries.find((entry) => entry.method === "run")?.meta.duration).toEqual({
		total: 2,
		samples: 1,
	});
	expect(JSON.stringify(profile.summary())).not.toContain(SECRET);
});

it.each([
	undefined,
	null,
	{ meta: { duration: SECRET, rows_read: NaN, rows_written: -1 } },
	{ meta: { duration: Infinity } },
])("ignores absent or invalid metadata without changing results %#", async (result) => {
	// Arrange
	const { statement, db, profile } = fixture();
	statement.result = result;
	// Act
	const actual = await db.prepare("PRAGMA user_version").run();
	// Assert
	expect(actual).toBe(result);
	expect(profile.summary().aggregates).toMatchObject([
		{
			category: "other",
			meta: {
				duration: { total: 0, samples: 0 },
				rows_read: { total: 0, samples: 0 },
				rows_written: { total: 0, samples: 0 },
			},
		},
	]);
	expect(JSON.stringify(profile.summary())).not.toContain(SECRET);
});

it("separates setup authority and request stages without extra execution or caching", async () => {
	// Arrange
	const { db, profile, statement } = fixture();
	const run = vi.spyOn(statement, "run");
	const prepared = db.prepare("INSERT INTO private_table VALUES (?)");
	// Act
	profile.setStage("authority-start");
	await prepared.run();
	profile.setStage("client-request-start");
	await prepared.run();
	await prepared.run();
	// Assert
	expect(run).toHaveBeenCalledTimes(3);
	expect(profile.summary().aggregates).toMatchObject([
		{ stage: "authority-start", calls: 1 },
		{ stage: "client-request-start", calls: 2 },
	]);
});

it("preserves absent optional capabilities and delegates exec without profiling it", async () => {
	// Arrange
	const { native, db, profile, statement } = fixture();
	const minimal: D1DatabaseLike = { prepare: native.prepare };
	const withoutOptions = profileOwnerD1(minimal, { enabled: "1" }).db;
	// Act
	const result = await db.exec?.(SECRET);
	// Assert
	expect(withoutOptions.batch).toBeUndefined();
	expect(withoutOptions.exec).toBeUndefined();
	expect(result).toBe(statement.result);
	expect(native.exec).toHaveBeenCalledExactlyOnceWith(SECRET);
	expect(native.exec.mock.contexts).toEqual([native]);
	expect(profile.summary()).toEqual({ calls: 0, inFlight: 0, wallMs: 0, aggregates: [] });
});

it.each([undefined, "", "0", "true"])(
	"does not instrument unless opt-in is exactly 1 (%s)",
	async (enabled) => {
		// Arrange
		vi.stubEnv("CODEMEM_WORKER_D1_PROFILE", enabled);
		const { native, now, statement } = fixture();
		const profile = profileOwnerD1(native, { now });
		// Act
		profile.setStage("authority-start");
		const result = await profile.db.prepare(SECRET).bind(SECRET).first();
		// Assert
		expect(profile.db).toBe(native);
		expect(result).toEqual(statement.result);
		expect(now).not.toHaveBeenCalled();
		expect(profile.summary()).toEqual({ calls: 0, inFlight: 0, wallMs: 0, aggregates: [] });
	},
);

it("classifies current source schema probes separately from operation SQL", async () => {
	// Arrange: capture real SQL through a fake backend, never a database or transport.
	const probes = await sourceSchemaProbes();
	const { db, profile } = fixture();
	// Act
	for (const sql of probes) await db.prepare(sql).first();
	await db
		.prepare(`SELECT * FROM coordinator_owner_enrollment_attempts WHERE attempt_id='${SECRET}'`)
		.bind(SECRET)
		.first();
	// Assert: repeated readiness checks aggregate without retaining SQL or bindings.
	expect(profile.summary().aggregates.map(({ category, calls }) => ({ category, calls }))).toEqual([
		{ category: "owner-qualification-column", calls: 1 },
		{ category: "connection-schema-presence", calls: 2 },
		{ category: "connection-schema-readiness", calls: 2 },
		{ category: "owner-qualification-readiness", calls: 2 },
		{ category: "select", calls: 1 },
	]);
	const output = JSON.stringify(profile.summary());
	expect(output).not.toContain(SECRET);
	for (const sql of probes) expect(output).not.toContain(sql);
});

it.each([
	["SELECT 1 AS present, 1 AS v2", "select"],
	["SELECT min(column1) AS ready FROM operation_rows", "select"],
	["SELECT (1) AS ready FROM coordinator_owner_enrollment_qualifications", "select"],
	["SELECT owner_qualification_id FROM coordinator_owner_enrollment_attempts", "select"],
	["WITH schema_probe AS (SELECT 1) SELECT * FROM schema_probe", "other"],
	["/* schema readiness */ SELECT 1", "other"],
])("keeps non-probe SQL in its fallback category %#", async (sql, category) => {
	// Arrange
	const { db, profile } = fixture();
	// Act
	await db.prepare(sql).first();
	// Assert
	expect(profile.summary().aggregates).toMatchObject([{ category, calls: 1 }]);
	expect(JSON.stringify(profile.summary())).not.toContain(sql);
});

it("preserves semantic statement categories in a single native batch invocation", async () => {
	// Arrange
	const probes = await sourceSchemaProbes();
	const { db, profile, native } = fixture();
	const statements = probes.map((sql) => db.prepare(sql).bind(SECRET));
	// Act
	await db.batch?.(statements);
	// Assert
	expect(native.batch).toHaveBeenCalledTimes(1);
	expect(profile.summary()).toMatchObject({
		calls: 1,
		inFlight: 0,
		aggregates: [
			{
				method: "batch",
				category: "batch",
				inFlight: 0,
				statements: {
					"owner-qualification-column": 1,
					"connection-schema-presence": 2,
					"connection-schema-readiness": 2,
					"owner-qualification-readiness": 2,
				},
			},
		],
	});
	expect(JSON.stringify(profile.summary())).not.toContain(SECRET);
});

it.each(["resolve", "reject"] as const)(
	"reports pending calls before %s and completed duration afterward",
	async (outcome) => {
		// Arrange
		const { db, statement, profile, now } = fixture();
		const deferred = Promise.withResolvers<unknown>();
		vi.spyOn(statement, "run").mockReturnValue(deferred.promise);
		now.mockReturnValueOnce(10).mockReturnValueOnce(25);
		const error = new Error(SECRET);
		// Act
		const invocation = db.prepare("UPDATE operation_rows SET value = ?").run();
		const during = profile.summary();
		// Assert: calls counts starts, and wallMs contains only completed waits.
		expect(during).toMatchObject({
			calls: 1,
			inFlight: 1,
			wallMs: 0,
			aggregates: [{ inFlight: 1 }],
		});
		// Act
		if (outcome === "resolve") deferred.resolve(statement.result);
		else deferred.reject(error);
		// Assert
		if (outcome === "resolve") await expect(invocation).resolves.toBe(statement.result);
		else await expect(invocation).rejects.toBe(error);
		expect(profile.summary()).toMatchObject({
			calls: 1,
			inFlight: 0,
			wallMs: 15,
			aggregates: [
				{
					inFlight: 0,
					errors: outcome === "reject" ? 1 : 0,
					wallMs: 15,
				},
			],
		});
		expect(during.inFlight).toBe(1);
		expect(during.aggregates[0].inFlight).toBe(1);
		expect(JSON.stringify(profile.summary())).not.toContain(SECRET);
	},
);

it("sums pending calls across stages without moving them when the current stage changes", async () => {
	// Arrange
	const { db, statement, profile } = fixture();
	const deferred = Promise.withResolvers<unknown>();
	vi.spyOn(statement, "run").mockReturnValue(deferred.promise);
	// Act
	profile.setStage("authority-start");
	const authority = db.prepare("INSERT INTO operation_rows VALUES (1)").run();
	profile.setStage("client-request-start");
	const request = db.prepare("INSERT INTO operation_rows VALUES (2)").run();
	// Assert
	expect(profile.summary()).toMatchObject({
		calls: 2,
		inFlight: 2,
		aggregates: [
			{ stage: "authority-start", inFlight: 1 },
			{ stage: "client-request-start", inFlight: 1 },
		],
	});
	// Act
	deferred.resolve(statement.result);
	await Promise.all([authority, request]);
	// Assert
	expect(profile.summary()).toMatchObject({
		calls: 2,
		inFlight: 0,
		aggregates: [{ inFlight: 0 }, { inFlight: 0 }],
	});
});
