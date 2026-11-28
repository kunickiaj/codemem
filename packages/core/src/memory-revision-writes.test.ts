import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importMemories } from "./export-import.js";
import { backfillNarrativeFromBody } from "./maintenance/backfill-narrative.js";
import { backfillTagsText } from "./maintenance/backfill-tags.js";
import { scanSecretsRetroactive } from "./maintenance/scan-secrets.js";
import { recordLocalCreationSnapshot } from "./memory-creation-provenance.js";
import { REPLICATED_MEMORY_COLUMNS, writeMemoryRevision } from "./memory-revision-writes.js";
import { allocateLocalMemorySource } from "./memory-source-identity.js";
import { SecretScanner } from "./secret-scanner.js";
import { recordReplicationOp } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

const LOCAL = "local-device";
const NOW = "2026-11-27T12:00:00.000Z";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, 'key', 'fp', ?)",
	).run(LOCAL, NOW);
});

afterEach(() => db.close());

/** A session summary whose import key either has this device's creation binding or none. */
function insertMemory(
	author: "this device" | "unverified",
	fields: { origin?: string | null; body?: string; title?: string } = {},
): number {
	return db.transaction(() => {
		const importKey =
			author === "this device" ? allocateLocalMemorySource(db).entityId : `key:${Math.random()}`;
		const memoryId = Number(
			db
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
					 visibility, origin_device_id, active, metadata_json, import_key, scope_id, rev)
					 VALUES (?, 'session_summary', ?, ?, ?, ?, 'shared', ?, 1, '{}', ?, 'scope-a', 3)`,
				)
				.run(
					insertTestSession(db),
					fields.title ?? "Title",
					fields.body ?? "Body",
					NOW,
					NOW,
					fields.origin === undefined ? LOCAL : fields.origin,
					importKey,
				).lastInsertRowid,
		);
		// The creating transaction records the copy, as remember() does.
		if (author === "this device") recordLocalCreationSnapshot(db, memoryId);
		return memoryId;
	})();
}

function stored(memoryId: number) {
	return db.prepare("SELECT rev, narrative, active FROM memory_items WHERE id = ?").get(memoryId);
}

function ops() {
	return db
		.prepare("SELECT op_type, clock_rev, clock_device_id, payload_json FROM replication_ops")
		.all() as Array<{
		op_type: string;
		clock_rev: number;
		clock_device_id: string;
		payload_json: string | null;
	}>;
}

describe("writeMemoryRevision on a memory this device created", () => {
	it("takes the next revision and records its op with the change", () => {
		const memoryId = insertMemory("this device");

		expect(writeMemoryRevision(db, { memoryId, changes: { narrative: "New" }, now: NOW })).toBe(
			true,
		);

		expect(stored(memoryId)).toEqual({ rev: 4, narrative: "New", active: 1 });
		const [op] = ops();
		expect(op).toMatchObject({ op_type: "upsert", clock_rev: 4, clock_device_id: LOCAL });
		expect(JSON.parse(op?.payload_json ?? "{}")).toMatchObject({ narrative: "New" });
	});

	it("records a deactivation as a delete", () => {
		const memoryId = insertMemory("this device");

		writeMemoryRevision(db, { memoryId, changes: { active: 0 }, now: NOW });

		expect(ops()).toEqual([
			expect.objectContaining({ op_type: "delete", clock_rev: 4, payload_json: null }),
		]);
	});

	it("writes nothing when its op cannot be recorded", () => {
		const memoryId = insertMemory("this device");
		db.exec(`CREATE TRIGGER refuse_op BEFORE INSERT ON replication_ops
			BEGIN SELECT RAISE(ABORT, 'refused'); END`);

		expect(() => writeMemoryRevision(db, { memoryId, changes: { narrative: "New" } })).toThrow(
			"refused",
		);

		expect(stored(memoryId)).toEqual({ rev: 3, narrative: null, active: 1 });
	});

	it("writes nothing once the revision moved past the one it read", () => {
		const memoryId = insertMemory("this device");

		expect(
			writeMemoryRevision(db, { memoryId, changes: { narrative: "New" }, expectedRev: 2 }),
		).toBe(false);

		expect(stored(memoryId)).toEqual({ rev: 3, narrative: null, active: 1 });
		expect(ops()).toEqual([]);
	});
});

describe("writeMemoryRevision on a memory this device cannot show it created", () => {
	it.each([
		["another device's origin", "other-device"],
		["this device's origin", LOCAL],
		["a blank origin", ""],
		["no origin", null],
		["a local origin", "local"],
	])("changes this device's copy only, with %s", (_case, origin) => {
		const memoryId = insertMemory("unverified", { origin });
		const before = db
			.prepare("SELECT updated_at, metadata_json FROM memory_items WHERE id = ?")
			.get(memoryId);

		writeMemoryRevision(db, {
			memoryId,
			changes: { narrative: "Local" },
			now: "2026-11-28T00:00:00.000Z",
		});

		expect(stored(memoryId)).toEqual({ rev: 3, narrative: "Local", active: 1 });
		expect(
			db.prepare("SELECT updated_at, metadata_json FROM memory_items WHERE id = ?").get(memoryId),
		).toEqual(before);
		expect(ops()).toEqual([]);
	});

	it("writes nothing once a value it was worked out from changed", () => {
		const memoryId = insertMemory("unverified", { origin: "other-device" });

		expect(
			writeMemoryRevision(db, {
				memoryId,
				changes: { narrative: "From the old body" },
				expectedValues: { body_text: "Old body" },
			}),
		).toBe(false);

		expect(stored(memoryId)).toEqual({ rev: 3, narrative: null, active: 1 });
	});
});

describe("maintenance on an imported shared memory with no origin", () => {
	it("stays on this device: no revision, no clock change and no op", () => {
		// Arrange: a file store with this device's identity imports another store's export.
		const dir = mkdtempSync(join(tmpdir(), "codemem-import-revision-"));
		try {
			const dbPath = join(dir, "store.sqlite");
			const fileDb = new Database(dbPath);
			initTestSchema(fileDb);
			fileDb
				.prepare(
					"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, 'key', 'fp', ?)",
				)
				.run(LOCAL, NOW);
			fileDb.close();
			importMemories(
				{
					version: "1.0",
					exported_at: NOW,
					export_metadata: {
						tool_version: "codemem",
						projects: ["api"],
						total_memories: 1,
						total_sessions: 1,
						include_inactive: false,
						filters: {},
					},
					sessions: [
						{
							id: 1,
							started_at: NOW,
							project: "api",
							metadata_json: {},
							import_key: "session-imported",
						},
					],
					memory_items: [
						{
							id: 7,
							session_id: 1,
							kind: "session_summary",
							title: "Imported",
							body_text: "## Completed\nImported work",
							visibility: "shared",
							created_at: NOW,
							updated_at: NOW,
							metadata_json: {},
							rev: 2,
							import_key: "memory-imported",
						},
					],
					session_summaries: [],
					user_prompts: [],
				},
				{ dbPath },
			);
			const imported = new Database(dbPath);
			const before = imported
				.prepare(
					"SELECT rev, updated_at, origin_device_id FROM memory_items WHERE import_key = 'memory-imported'",
				)
				.get();
			expect(before).toMatchObject({ rev: 2, origin_device_id: null });

			// Act
			backfillNarrativeFromBody(imported);

			// Assert
			expect(
				imported
					.prepare(
						"SELECT rev, updated_at, origin_device_id, narrative FROM memory_items WHERE import_key = 'memory-imported'",
					)
					.get(),
			).toEqual({ ...(before as object), narrative: "Imported work" });
			expect(imported.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get()).toBe(0);
			imported.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("redacting a memory sync may already have delivered", () => {
	const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

	beforeEach(() => {
		db.prepare(
			`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
			 VALUES ('scope-a', 'Scope A', 'team', 'coordinator', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
	});

	function body(memoryId: number): unknown {
		return db.prepare("SELECT body_text FROM memory_items WHERE id = ?").pluck().get(memoryId);
	}

	it("stays local on a row from before creation records that this device sent, and the report lists it", () => {
		const memoryId = insertMemory("unverified", { body: `token ${SECRET}` });
		recordReplicationOp(db, { memoryId, opType: "upsert", deviceId: LOCAL, createdAt: NOW });
		const opsBefore = ops().length;

		const result = scanSecretsRetroactive(db);

		expect(body(memoryId)).not.toContain(SECRET);
		expect(stored(memoryId)).toMatchObject({ rev: 3 });
		expect(ops()).toHaveLength(opsBefore);
		expect(result.unpropagatedRedactions).toEqual([{ id: memoryId, scope_id: "scope-a" }]);
	});

	it("lists a row that only snapshot pages could have delivered", () => {
		const memoryId = insertMemory("unverified", { body: `token ${SECRET}` });

		const result = scanSecretsRetroactive(db);

		expect(ops()).toEqual([]);
		expect(result.unpropagatedRedactions).toEqual([{ id: memoryId, scope_id: "scope-a" }]);
	});

	it("lists a row whose ops retention already pruned", () => {
		const memoryId = insertMemory("unverified", { body: `token ${SECRET}` });
		recordReplicationOp(db, { memoryId, opType: "upsert", deviceId: LOCAL, createdAt: NOW });
		db.prepare("DELETE FROM replication_ops").run();

		const result = scanSecretsRetroactive(db);

		expect(result.unpropagatedRedactions).toEqual([{ id: memoryId, scope_id: "scope-a" }]);
	});

	it("leaves out a row in a scope sync never serves", () => {
		const memoryId = insertMemory("unverified", { body: `token ${SECRET}` });
		db.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = ?").run(memoryId);

		const result = scanSecretsRetroactive(db);

		expect(body(memoryId)).not.toContain(SECRET);
		expect(result.unpropagatedRedactions).toEqual([]);
	});

	it("propagates on a copy this device created, which the report leaves out", () => {
		const memoryId = insertMemory("this device", { body: `token ${SECRET}` });
		recordReplicationOp(db, { memoryId, opType: "upsert", deviceId: LOCAL, createdAt: NOW });

		const result = scanSecretsRetroactive(db);

		expect(stored(memoryId)).toMatchObject({ rev: 4 });
		expect(result.unpropagatedRedactions).toEqual([]);
	});
});

/** A scanner that runs a concurrent writer the first time the backfill redacts its derived text. */
function scannerThatEditsFirst(edit: () => void): SecretScanner {
	const scanner = new SecretScanner();
	const scan = scanner.scan.bind(scanner);
	let edited = false;
	scanner.scan = (text: string) => {
		if (!edited) {
			edited = true;
			edit();
		}
		return scan(text);
	};
	return scanner;
}

describe("a backfill that reads before a concurrent redaction", () => {
	it.each(["this device", "unverified"] as const)(
		"keeps the narrative it would have derived from the old body off a memory %s wrote",
		(author) => {
			const memoryId = insertMemory(author, { body: "## Completed\ntoken=ghp_old_secret_value" });
			const redact = () =>
				writeMemoryRevision(db, { memoryId, changes: { body_text: "## Completed\n[REDACTED]" } });

			const result = backfillNarrativeFromBody(db, { scanner: scannerThatEditsFirst(redact) });

			expect(result).toMatchObject({ updated: 0, skipped: 1 });
			expect(
				db.prepare("SELECT narrative FROM memory_items WHERE id = ?").pluck().get(memoryId),
			).toBeNull();
		},
	);

	it.each(["this device", "unverified"] as const)(
		"keeps tags derived from an old title off a memory %s wrote",
		(author) => {
			const memoryId = insertMemory(author, { title: "Rotate ghp_old_secret_value" });
			db.prepare("UPDATE memory_items SET tags_text = '' WHERE id = ?").run(memoryId);
			const redact = () =>
				writeMemoryRevision(db, { memoryId, changes: { title: "Rotate [REDACTED]" } });

			const result = backfillTagsText(db, { scanner: scannerThatEditsFirst(redact) });

			expect(result).toMatchObject({ updated: 0 });
			expect(
				db.prepare("SELECT tags_text FROM memory_items WHERE id = ?").pluck().get(memoryId),
			).toBe("");
		},
	);
});

const PACKAGES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Writers that change replicated columns without a revision, each with why that is safe. */
const EXEMPT_WRITERS: Array<{ file: string; snippet: string; reason: string }> = [
	{
		file: "core/src/scope-stamping.ts",
		snippet: "SET scope_id = ?",
		reason: "Stamps a scope on a row without one, inside the transaction recording its op.",
	},
	{
		file: "core/src/local-origin-claim.ts",
		snippet: "SET origin_device_id = ?",
		reason:
			"Names this device where a legacy row it wrote names no origin; receivers already derive it from the sender.",
	},
	{
		file: "core/src/ingest-pipeline.ts",
		snippet: "set({ metadata_json: toJson(meta) })",
		reason:
			"Notes the replacement on a row already deleted; a deleted memory's op carries no content.",
	},
	{
		file: "viewer-server/src/routes/sync.ts",
		snippet: "visibility = 'private'",
		reason:
			"Changes copies another device wrote, which take no revision here, and only narrows who may read them.",
	},
	{
		file: "core/src/maintenance/relink.ts",
		snippet: "set({ session_id: options.survivingSessionId })",
		reason:
			"Joins sessions of one stream and one Project, so the Project an op sends is unchanged; peers keep their own sessions.",
	},
	{
		file: "core/src/db.ts",
		snippet: "SET project = (",
		reason: "Copies the session's Project onto rows without one; ops already send that Project.",
	},
];

/** Source files that write memory rows, without tests and fixtures. */
function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return ["node_modules", "dist", "static"].includes(entry.name) ? [] : sourceFiles(path);
		const isTest = /\.test\.ts$|-test-fixtures\.ts$|-test-harness\.ts$|test-utils\.ts$/u.test(
			entry.name,
		);
		return entry.name.endsWith(".ts") && !isTest ? [path] : [];
	});
}

/** The SQL string literal around an `UPDATE memory_items`, from its opening quote to its closing one. */
function sqlLiteral(text: string, at: number): string {
	const opening = Math.max(
		text.lastIndexOf("`", at),
		text.lastIndexOf('"', at),
		text.lastIndexOf("'", at),
	);
	const quote = text[opening] ?? "`";
	const closing = text.indexOf(quote, at);
	return text.slice(opening + 1, closing < 0 ? undefined : closing);
}

/** The object passed to the Drizzle `.set(...)` after `at`, braces balanced. */
function drizzleSet(text: string, at: number): string {
	const start = text.indexOf(".set(", at);
	if (start < 0) return "";
	let depth = 0;
	for (let index = start + 5; index < text.length; index++) {
		if (text[index] === "{") depth++;
		if (text[index] === "}" && --depth === 0) return text.slice(start, index + 2);
	}
	return text.slice(start);
}

interface MemoryRowWrite {
	assignments: string;
	style: "sql" | "drizzle";
}

/** The assignments of each memory row write: an SQL SET clause, or a Drizzle `.set(...)` object. */
function memoryRowWrites(text: string): MemoryRowWrite[] {
	const writes: MemoryRowWrite[] = [];
	for (const match of text.matchAll(/UPDATE memory_items\b/gu)) {
		const statement = sqlLiteral(text, match.index);
		const set = statement.split(/\bSET\b/iu)[1] ?? "";
		writes.push({ assignments: set.split(/\bWHERE\b/iu)[0] ?? set, style: "sql" });
	}
	for (const match of text.matchAll(/\.update\((?:schema\.)?memoryItems\)/gu))
		writes.push({ assignments: drizzleSet(text, match.index), style: "drizzle" });
	return writes;
}

function replicatedColumnsSet(write: MemoryRowWrite): string[] {
	const assigned = write.style === "sql" ? "\\s*=" : "\\s*(?::|,|\\})";
	return REPLICATED_MEMORY_COLUMNS.filter((column) =>
		new RegExp(`\\b${column}\\b${assigned}`, "u").test(write.assignments),
	);
}

/** Whether the write gives `rev` a new value: anything but itself in SQL, any value in Drizzle. */
function assignsRevision(write: MemoryRowWrite): boolean {
	if (write.style === "sql") return /\brev\s*=\s*(?!rev\b)\S/u.test(write.assignments);
	return /\brev\s*(?::\s*\S|,|\})/u.test(write.assignments);
}

/** Writes in the source that set replicated columns without a revision. */
function unversionedWrites(text: string): Array<MemoryRowWrite & { columns: string[] }> {
	return memoryRowWrites(text)
		.map((write) => ({ ...write, columns: replicatedColumnsSet(write) }))
		.filter((write) => write.columns.length > 0 && !assignsRevision(write));
}

describe("the check for writers of replicated memory columns", () => {
	it.each([
		[
			"a revision named only in WHERE",
			"db.prepare(`UPDATE memory_items SET narrative = ? WHERE id = ? AND rev = ?`)",
		],
		[
			"a revision assigned to itself",
			'db.prepare("UPDATE memory_items SET narrative = ?, rev = rev WHERE id = ?")',
		],
		["a prompt link", 'db.prepare("UPDATE memory_items SET user_prompt_id = ? WHERE id = ?")'],
		[
			"a revision mentioned after the statement",
			"db.prepare(`UPDATE memory_items SET title = ?`).run(t); const rev = 1;",
		],
		[
			"a Drizzle write without one",
			"d.update(schema.memoryItems).set({ narrative, updated_at: now }).where(x)",
		],
	])("flags %s", (_case, source) => {
		expect(unversionedWrites(source)).toHaveLength(1);
	});

	it.each([
		[
			"SQL",
			'db.prepare("UPDATE memory_items SET narrative = ?, rev = COALESCE(rev, 0) + 1 WHERE id = ?")',
		],
		["Drizzle", "d.update(schema.memoryItems).set({ narrative, rev: next }).where(x)"],
		[
			"a write of no replicated column",
			'db.prepare("UPDATE memory_items SET dedup_key = ? WHERE id = ?")',
		],
	])("accepts a versioned %s write", (_case, source) => {
		expect(unversionedWrites(source)).toEqual([]);
	});
});

describe("every writer of replicated memory columns", () => {
	it("takes a revision, goes through writeMemoryRevision, or is exempt for a stated reason", () => {
		const roots = readdirSync(PACKAGES).map((name) => join(PACKAGES, name, "src"));
		const unexplained: string[] = [];
		const used = new Set<string>();
		for (const file of roots.flatMap((root) => {
			try {
				return sourceFiles(root);
			} catch {
				return [];
			}
		})) {
			const name = relative(PACKAGES, file);
			for (const write of unversionedWrites(readFileSync(file, "utf8"))) {
				const exempt = EXEMPT_WRITERS.find(
					(writer) =>
						writer.file === name &&
						write.assignments.includes(writer.snippet.replace(/^SET /u, "")),
				);
				if (exempt) used.add(`${exempt.file}:${exempt.snippet}`);
				else unexplained.push(`${name}: ${write.columns.join(", ")}`);
			}
		}

		expect(unexplained).toEqual([]);
		expect([...used].sort()).toEqual(
			EXEMPT_WRITERS.map((writer) => `${writer.file}:${writer.snippet}`).sort(),
		);
	});
});
