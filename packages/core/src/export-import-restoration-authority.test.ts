import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type Database } from "./db.js";
import { getEmbeddingClient } from "./embeddings.js";
import { type ExportPayload, importMemories } from "./export-import.js";
import { refreshManagedScopeFixture } from "./managed-scope-test-fixtures.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFileSync: vi.fn(() => {
		throw new Error("External subprocess disabled");
	}),
}));
vi.mock("./embeddings.js", async (original) => ({
	...(await original<typeof import("./embeddings.js")>()),
	getEmbeddingClient: vi.fn(() => {
		throw new Error("No provider calls allowed");
	}),
}));

const marker = `export-session:v1:${"c".repeat(64)}`;
const stamp = "2026-03-01T00:00:00Z";
let db: Database;
let dbPath: string;
let keysDir: string;

function payload(redacted = false): ExportPayload {
	return {
		version: "1.0",
		exported_at: stamp,
		export_metadata: {
			tool_version: "codemem",
			projects: ["alpha"],
			total_memories: 1,
			total_sessions: 1,
			include_inactive: false,
			filters: {},
		},
		sessions: [
			{
				id: 1,
				export_session_key: marker,
				...(redacted
					? { export_session_redacted: true }
					: {
							started_at: stamp,
							cwd: "/fixture",
							project: "alpha",
							user: "fixture",
							metadata_json: { secret: "session secret" },
						}),
			},
		],
		memory_items: [
			{
				id: 100,
				session_id: 1,
				project: "alpha",
				scope_id: "managed",
				import_key: "memory-managed",
				kind: "feature",
				title: "Managed",
				body_text: "Body",
				created_at: stamp,
				updated_at: stamp,
				user_prompt_id: redacted ? null : 10,
				user_prompt_import_key: redacted ? null : "prompt-managed",
			},
		],
		user_prompts: redacted
			? []
			: [
					{
						id: 10,
						session_id: 1,
						import_key: "prompt-managed",
						prompt_text: "prompt secret",
						created_at: stamp,
						created_at_epoch: 1,
					},
				],
		session_summaries: redacted
			? []
			: [
					{
						id: 20,
						session_id: 1,
						import_key: "summary-managed",
						request: "summary secret",
						created_at: stamp,
						created_at_epoch: 1,
					},
				],
	};
}

function revoke() {
	db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'managed'").run();
}

function restorationPayload(mode: string) {
	const incoming = payload();
	switch (mode) {
		case "omitted":
			delete incoming.memory_items[0].scope_id;
			break;
		case "forged":
			incoming.memory_items[0].scope_id = "local-default";
			break;
		case "mixed":
			incoming.memory_items.push({
				...incoming.memory_items[0],
				id: 101,
				scope_id: "local-default",
				import_key: "local-memory",
			});
			break;
		case "hijacked":
			incoming.sessions[0].export_session_key = `export-session:v1:${"d".repeat(64)}`;
			break;
		case "missing-memory":
			incoming.memory_items = [];
			break;
		case "forged-session":
			incoming.memory_items[0].session_id = 999;
			break;
		case "forged-session-with-local":
		case "omitted-managed-with-local":
			incoming.memory_items.push({
				id: 101,
				session_id: 1,
				scope_id: "local-default",
				import_key: "local-memory",
				created_at: stamp,
			});
			if (mode === "forged-session-with-local") incoming.memory_items[0].session_id = 999;
			else incoming.memory_items.shift();
			break;
	}
	return incoming;
}

function bytes() {
	// Include committed WAL pages before comparing the main database image.
	db.pragma("wal_checkpoint(TRUNCATE)");
	return readFileSync(dbPath);
}

function keyBytes() {
	return readdirSync(keysDir)
		.sort()
		.map((name) => readFileSync(join(keysDir, name)));
}

function rows() {
	return [
		"sessions",
		"memory_items",
		"user_prompts",
		"session_summaries",
		"sync_device",
		"scope_memberships",
	].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

beforeEach(async () => {
	const dir = mkdtempSync(join(tmpdir(), "codemem-restoration-authority-"));
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	vi.stubEnv("CODEMEM_DEVICE_ID", "fixture-device");
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	dbPath = join(dir, "fixture.sqlite");
	keysDir = join(dir, "keys");
	db = connect(dbPath);
	initTestSchema(db);
	db.prepare(
		`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at) VALUES ('managed', 'managed', 'team', 'coordinator', 1, 'active', ?, ?)`,
	).run(stamp, stamp);
	db.prepare(
		`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at) VALUES ('managed', 'fixture-device', 'member', 'active', 1, ?)`,
	).run(stamp);
	await refreshManagedScopeFixture(db, {
		keysDir,
		deviceId: "fixture-device",
		scopeIds: ["managed"],
	});
});
afterEach(() => {
	db.close();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("current authority for import restoration", () => {
	it.each([
		"unchanged",
		"omitted",
		"forged",
		"mixed",
		"hijacked",
		"missing-memory",
		"forged-session",
		"forged-session-with-local",
		"omitted-managed-with-local",
	])("denies revoked placeholder restoration with %s memory labels atomically", (mode) => {
		// Arrange: an earlier authorized slice contains no unscoped source context.
		importMemories(payload(true), { dbPath });
		revoke();
		const incoming = restorationPayload(mode);
		const before = rows();
		const image = bytes();
		const keys = keyBytes();
		// Act
		const act = () => importMemories(incoming, { dbPath });
		// Assert: restoration cannot use a dedupe key as an authorization grant.
		expect(act).toThrow(/unauthorized_scope/);
		expect(rows()).toEqual(before);
		expect(bytes()).toEqual(image);
		expect(keyBytes()).toEqual(keys);
	});

	it("allows an active member to import context into a different canonical session without moving a deduped memory", () => {
		// Arrange
		importMemories(payload(true), { dbPath });
		const incoming = payload();
		incoming.sessions[0].export_session_key = `export-session:v1:${"d".repeat(64)}`;
		const before = db.prepare("SELECT * FROM memory_items").get();
		// Act
		const result = importMemories(incoming, { dbPath });
		// Assert
		expect(result).toMatchObject({
			sessions: 1,
			memory_items: 0,
			user_prompts: 1,
			session_summaries: 1,
		});
		expect(db.prepare("SELECT * FROM memory_items").get()).toEqual(before);
		expect(db.prepare("SELECT COUNT(*) FROM sessions").pluck().get()).toBe(2);
	});

	it("rolls back an earlier local session write when a later restoration is denied", () => {
		// Arrange
		importMemories(payload(true), { dbPath });
		revoke();
		const incoming = payload();
		incoming.sessions.unshift({
			id: 2,
			export_session_key: `export-session:v1:${"e".repeat(64)}`,
			started_at: stamp,
		});
		incoming.memory_items.unshift({
			id: 101,
			session_id: 2,
			scope_id: "local-default",
			import_key: "local-new",
			created_at: stamp,
		});
		const before = rows();
		const image = bytes();
		// Act
		const act = () => importMemories(incoming, { dbPath });
		// Assert
		expect(act).toThrow(/unauthorized_scope/);
		expect(rows()).toEqual(before);
		expect(bytes()).toEqual(image);
	});

	it.each(["epoch", "archived", "environment-device"])(
		"uses current stored authority rather than %s",
		(mode) => {
			// Arrange
			importMemories(payload(true), { dbPath });
			if (mode === "epoch")
				db.prepare(
					"UPDATE replication_scopes SET membership_epoch = 2 WHERE scope_id = 'managed'",
				).run();
			if (mode === "archived")
				db.prepare(
					"UPDATE replication_scopes SET status = 'archived' WHERE scope_id = 'managed'",
				).run();
			if (mode === "environment-device") {
				revoke();
				db.prepare(
					"INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at) VALUES ('managed', 'other-device', 'member', 'active', 1, ?)",
				).run(stamp);
				vi.stubEnv("CODEMEM_DEVICE_ID", "other-device");
			}
			const before = rows();
			// Act
			const act = () => importMemories(payload(), { dbPath });
			// Assert
			expect(act).toThrow(/unauthorized_scope/);
			expect(rows()).toEqual(before);
		},
	);
});

describe("authorized restoration and read-only imports", () => {
	it.each(["omitted", "local-default", "unregistered"])(
		"ignores %s scope labels on a fully deduped read-only import",
		(scope) => {
			// Arrange
			importMemories(payload(), { dbPath });
			revoke();
			const incoming = payload();
			if (scope === "omitted") delete incoming.memory_items[0].scope_id;
			else incoming.memory_items[0].scope_id = scope;
			const before = rows();
			const image = bytes();
			const keys = keyBytes();
			// Act
			const result = importMemories(incoming, { dbPath });
			// Assert
			expect(result).toMatchObject({
				sessions: 0,
				memory_items: 0,
				user_prompts: 0,
				session_summaries: 0,
			});
			expect(rows()).toEqual(before);
			expect(bytes()).toEqual(image);
			expect(keyBytes()).toEqual(keys);
		},
	);
	it("restores the same memory and its context after membership returns", () => {
		// Arrange
		importMemories(payload(true), { dbPath });
		const memory = db.prepare("SELECT * FROM memory_items").get();
		revoke();
		db.prepare("UPDATE scope_memberships SET status = 'active' WHERE scope_id = 'managed'").run();
		// Act
		const result = importMemories(payload(), { dbPath });
		// Assert
		expect(result).toMatchObject({ memory_items: 0, user_prompts: 1, session_summaries: 1 });
		expect(db.prepare("SELECT * FROM memory_items").get()).toEqual({
			...(memory as object),
			user_prompt_id: expect.any(Number),
		});
		expect(db.prepare("SELECT metadata_json FROM sessions").pluck().get()).toContain(
			"session secret",
		);
	});

	it.each([false, true])(
		"accepts exact read-only reimport after revocation (redacted=%s)",
		(redacted) => {
			// Arrange
			const incoming = payload(redacted);
			importMemories(incoming, { dbPath });
			if (redacted) {
				const session = db.prepare("SELECT metadata_json FROM sessions").pluck().get() as string;
				const metadata = JSON.parse(session);
				delete metadata.placeholder_project;
				db.prepare("UPDATE sessions SET metadata_json = ?").run(JSON.stringify(metadata));
			}
			revoke();
			const before = rows();
			const image = bytes();
			const keys = keyBytes();
			// Act
			const result = importMemories(incoming, { dbPath });
			// Assert: even legacy project bookkeeping must remain read-only.
			expect(result).toMatchObject({
				sessions: 0,
				memory_items: 0,
				user_prompts: 0,
				session_summaries: 0,
			});
			expect(rows()).toEqual(before);
			expect(bytes()).toEqual(image);
			expect(keyBytes()).toEqual(keys);
			expect(getEmbeddingClient).not.toHaveBeenCalled();
			expect(execFileSync).not.toHaveBeenCalled();
		},
	);

	it.each(["prompt", "summary", "link"])(
		"denies a new %s on an already full revoked session",
		(mode) => {
			// Arrange
			importMemories(payload(), { dbPath });
			const incoming = payload();
			if (mode === "prompt") incoming.user_prompts[0].import_key = "new-prompt";
			if (mode === "summary") incoming.session_summaries[0].import_key = "new-summary";
			if (mode === "link") db.prepare("UPDATE memory_items SET user_prompt_id = NULL").run();
			revoke();
			const before = rows();
			const image = bytes();
			// Act
			const act = () => importMemories(incoming, { dbPath });
			// Assert
			expect(act).toThrow(/unauthorized_scope/);
			expect(rows()).toEqual(before);
			expect(bytes()).toEqual(image);
		},
	);

	it.each(["prompt", "summary", "link"])(
		"allows an authorized new %s on an already full session",
		(mode) => {
			// Arrange
			importMemories(payload(), { dbPath });
			const incoming = payload();
			if (mode === "prompt") incoming.user_prompts[0].import_key = "new-prompt";
			if (mode === "summary") incoming.session_summaries[0].import_key = "new-summary";
			if (mode === "link") db.prepare("UPDATE memory_items SET user_prompt_id = NULL").run();
			// Act
			const result = importMemories(incoming, { dbPath });
			// Assert
			expect(result).toMatchObject({
				memory_items: 0,
				user_prompts: mode === "prompt" ? 1 : 0,
				session_summaries: mode === "summary" ? 1 : 0,
			});
			expect(db.prepare("SELECT user_prompt_id FROM memory_items").pluck().get()).not.toBeNull();
		},
	);
});

describe("generated memory keys with blank remaps", () => {
	it("restores context using the actual generated dedupe key", () => {
		// Arrange
		const initial = payload(true);
		delete initial.memory_items[0].import_key;
		importMemories(initial, { dbPath, remapProject: "" });
		const incoming = payload();
		delete incoming.memory_items[0].import_key;
		// Act
		const result = importMemories(incoming, { dbPath, remapProject: "" });
		// Assert
		expect(result).toMatchObject({ memory_items: 0, user_prompts: 1, session_summaries: 1 });
	});

	it("rejects a revoked generated-key import into a different session despite a forged local scope label", () => {
		// Arrange
		const initial = payload(true);
		delete initial.memory_items[0].import_key;
		importMemories(initial, { dbPath, remapProject: "" });
		revoke();
		const incoming = payload();
		delete incoming.memory_items[0].import_key;
		incoming.memory_items[0].scope_id = "local-default";
		incoming.sessions[0].export_session_key = `export-session:v1:${"d".repeat(64)}`;
		const before = rows();
		const image = bytes();
		// Act
		const act = () => importMemories(incoming, { dbPath, remapProject: "" });
		// Assert
		expect(act).toThrow(/unauthorized_scope: managed/);
		expect(rows()).toEqual(before);
		expect(bytes()).toEqual(image);
	});
});

describe("authorized context imports across deduped session mappings", () => {
	it("imports a full canonical session with an explicit managed memory key into a new project remap idempotently", () => {
		// Arrange
		importMemories(payload(), { dbPath });
		const memory = db.prepare("SELECT * FROM memory_items").get();
		const children = ["user_prompts", "session_summaries"].map((table) =>
			db.prepare(`SELECT * FROM ${table}`).all(),
		);
		const incoming = payload();
		const options = { dbPath, remapProject: "beta" };
		// Act
		const result = importMemories(incoming, options);
		const restored = db.serialize();
		const repeated = importMemories(incoming, options);
		// Assert: context is importable, but the deduped memory and old children stay put.
		expect(result).toEqual({
			sessions: 1,
			memory_items: 0,
			user_prompts: 0,
			session_summaries: 0,
			dryRun: false,
		});
		expect(repeated).toEqual({
			sessions: 0,
			memory_items: 0,
			user_prompts: 0,
			session_summaries: 0,
			dryRun: false,
		});
		expect(db.prepare("SELECT * FROM memory_items").get()).toEqual(memory);
		expect(
			["user_prompts", "session_summaries"].map((table) =>
				db.prepare(`SELECT * FROM ${table}`).all(),
			),
		).toEqual(children);
		expect(
			db.prepare("SELECT import_key, metadata_json FROM sessions WHERE project = 'beta'").get(),
		).toMatchObject({
			import_key: expect.stringContaining(`${marker}:remap:`),
			metadata_json: expect.stringContaining("session secret"),
		});
		expect(db.serialize()).toEqual(restored);
	});

	it.each(["managed", "local-default", "omitted"])(
		"denies a revoked remap using the stored scope despite incoming %s scope",
		(scope) => {
			// Arrange
			importMemories(payload(), { dbPath });
			revoke();
			const incoming = payload();
			if (scope === "omitted") delete incoming.memory_items[0].scope_id;
			else incoming.memory_items[0].scope_id = scope;
			const image = bytes();
			const wal = readFileSync(`${dbPath}-wal`);
			const allTables = db.serialize();
			const keys = keyBytes();
			// Act
			const act = () => importMemories(incoming, { dbPath, remapProject: "beta" });
			// Assert: every table, including membership cache, and both SQLite files stay unchanged.
			expect(act).toThrow(/unauthorized_scope: managed/);
			expect(db.serialize()).toEqual(allTables);
			expect(readFileSync(dbPath)).toEqual(image);
			expect(readFileSync(`${dbPath}-wal`)).toEqual(wal);
			expect(keyBytes()).toEqual(keys);
		},
	);

	it("imports a canonical redacted reference after a legacy full import without promoting or reparenting its rows", () => {
		// Arrange
		const legacy = payload();
		delete legacy.sessions[0].export_session_key;
		importMemories(legacy, { dbPath });
		const before = rows();
		// Act
		const result = importMemories(payload(true), { dbPath });
		const imported = db.serialize();
		const repeated = importMemories(payload(true), { dbPath });
		// Assert: the reference has its own placeholder, while legacy source context remains unchanged.
		expect(result).toEqual({
			sessions: 1,
			memory_items: 0,
			user_prompts: 0,
			session_summaries: 0,
			dryRun: false,
		});
		expect(repeated).toEqual({
			sessions: 0,
			memory_items: 0,
			user_prompts: 0,
			session_summaries: 0,
			dryRun: false,
		});
		expect(rows()[0][0]).toEqual(before[0][0]);
		expect(rows().slice(1)).toEqual(before.slice(1));
		expect(
			db.prepare("SELECT started_at, cwd, project FROM sessions WHERE import_key = ?").get(marker),
		).toEqual({ started_at: "", cwd: null, project: null });
		expect(db.serialize()).toEqual(imported);
	});

	it("denies a canonical redacted reference after revocation of a legacy full import", () => {
		// Arrange
		const legacy = payload();
		delete legacy.sessions[0].export_session_key;
		importMemories(legacy, { dbPath });
		revoke();
		const image = bytes();
		const wal = readFileSync(`${dbPath}-wal`);
		const allTables = db.serialize();
		const keys = keyBytes();
		// Act
		const act = () => importMemories(payload(true), { dbPath });
		// Assert
		expect(act).toThrow(/unauthorized_scope: managed/);
		expect(db.serialize()).toEqual(allTables);
		expect(readFileSync(dbPath)).toEqual(image);
		expect(readFileSync(`${dbPath}-wal`)).toEqual(wal);
		expect(keyBytes()).toEqual(keys);
	});
});

describe("session lookup index", () => {
	it.each(["same", "distinct"])(
		"indexes a thousand %s-session memories without per-memory find calls",
		(mode) => {
			// Arrange: observe lookups, not elapsed time or SQL parameter limits.
			const incoming = payload(true);
			incoming.memory_items = Array.from({ length: 1000 }, (_, index) => ({
				...incoming.memory_items[0],
				id: index + 100,
				session_id: mode === "same" ? 1 : index + 1,
				scope_id: "local-default",
				import_key: `indexed-memory-${index}`,
			}));
			if (mode === "distinct")
				incoming.sessions = Array.from({ length: 1000 }, (_, index) => ({
					id: index + 1,
					export_session_key: `export-session:v1:${(index + 1).toString(16).padStart(64, "0")}`,
					export_session_redacted: true,
				}));
			const find = vi.spyOn(incoming.sessions, "find");
			// Act
			const result = importMemories(incoming, { dbPath });
			// Assert
			expect(result).toMatchObject({ sessions: mode === "same" ? 1 : 1000, memory_items: 1000 });
			expect(find).not.toHaveBeenCalled();
			expect(db.prepare("SELECT COUNT(DISTINCT session_id) FROM memory_items").pluck().get()).toBe(
				mode === "same" ? 1 : 1000,
			);
		},
	);

	it("keeps the first normalized duplicate session's redaction for prompt resolution", () => {
		// Arrange: children are already stored, so only first-match prompt resolution matters.
		importMemories(payload(), { dbPath });
		db.prepare("UPDATE memory_items SET user_prompt_id = NULL").run();
		const incoming = payload();
		incoming.sessions.unshift({
			id: "1",
			export_session_key: marker,
			export_session_redacted: true,
		});
		const find = vi.spyOn(incoming.sessions, "find");
		// Act
		const result = importMemories(incoming, { dbPath });
		// Assert
		expect(result).toMatchObject({ memory_items: 0, user_prompts: 0 });
		expect(db.prepare("SELECT user_prompt_id FROM memory_items").pluck().get()).toBeNull();
		expect(find).not.toHaveBeenCalled();
	});

	it("does not match nonnumeric source session IDs", () => {
		// Arrange: Number(id) === Number(session_id) never matched NaN in Array.find.
		const incoming = payload();
		incoming.sessions[0].id = "not-a-number";
		incoming.memory_items[0].session_id = "not-a-number";
		incoming.user_prompts[0].session_id = "not-a-number";
		incoming.session_summaries = [];
		// Act
		const result = importMemories(incoming, { dbPath });
		// Assert: session mapping keeps its old behavior, but incoming redaction lookup has no NaN match.
		expect(result).toMatchObject({ sessions: 1, memory_items: 1, user_prompts: 1 });
		expect(db.prepare("SELECT user_prompt_id FROM memory_items").pluck().get()).not.toBeNull();
	});
});
