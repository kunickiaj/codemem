import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { initDatabase, MemoryStore } from "@codemem/core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@clack/prompts")>();
	return { ...actual, intro: vi.fn(), outro: vi.fn() };
});

import { registerRootCommands } from "../command-tree.js";
import { maintenanceCommand } from "./maintenance.js";

const database = maintenanceCommand.commands.find((command) => command.name() === "database");
const memory = maintenanceCommand.commands.find((command) => command.name() === "memory");
const backfills = maintenanceCommand.commands.find((command) => command.name() === "backfill");

describe("maintenance project repair behavior", () => {
	it.each([
		{ action: "rename", apply: false },
		{ action: "rename", apply: true },
		{ action: "normalize", apply: false },
		{ action: "normalize", apply: true },
	])("$action preserves dry-run/apply semantics (apply=$apply)", async ({ action, apply }) => {
		// Arrange: use local SQLite only and compare both affected tables with unrelated rows.
		const directory = mkdtempSync(join(tmpdir(), "codemem-project-repair-"));
		const dbPath = join(directory, "test.sqlite");
		initDatabase(dbPath);
		const store = new MemoryStore(dbPath);
		const projects = ["old_name%", "/checkout/old_name%", "other", "/checkout/oldXnameY", null];
		const startedAt = "2026-01-01T00:00:00.000Z";
		for (const [index, project] of projects.entries()) {
			store.db
				.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
				.run(startedAt, project);
			store.recordRawEvent({
				opencodeSessionId: `project-${index}`,
				eventId: `event-${index}`,
				eventType: "user_prompt",
				payload: { type: "user_prompt", prompt_text: "fixture" },
				tsWallMs: 1_767_225_600_000,
			});
			store.db
				.prepare("UPDATE raw_event_sessions SET project = ? WHERE opencode_session_id = ?")
				.run(project, `project-${index}`);
		}
		const snapshot = () => ({
			sessions: store.db
				.prepare("SELECT id, started_at, project FROM sessions ORDER BY id")
				.all() as Array<{ id: number; started_at: string; project: string | null }>,
			raw: store.db
				.prepare(
					"SELECT opencode_session_id, project FROM raw_event_sessions ORDER BY opencode_session_id",
				)
				.all() as Array<{ opencode_session_id: string; project: string | null }>,
		});
		const before = snapshot();
		const intro = vi.mocked(p.intro).mockClear();
		const outro = vi.mocked(p.outro).mockClear();
		const info = vi.spyOn(p.log, "info").mockImplementation(() => {});
		const message = vi.spyOn(p.log, "message").mockImplementation(() => {});
		try {
			// Act: parse the public path so command registration is exercised too.
			const program = registerRootCommands(new Command("codemem").enablePositionalOptions());
			const args = ["maintenance", "project", action];
			if (action === "rename") args.push("old_name%", "new-name");
			args.push("--db-path", dbPath);
			if (apply) args.push("--apply");
			await program.parseAsync(args, { from: "user" });
			const after = snapshot();
			// Assert: wildcard characters in rename inputs are literal, and default runs never write.
			const expectedProjects = projects.map((project) => {
				if (!apply || project === null) return project;
				if (action === "normalize") return project.split("/").at(-1);
				return project === "old_name%" || project === "/checkout/old_name%" ? "new-name" : project;
			});
			expect(after).toEqual({
				sessions: before.sessions.map((row, index) => ({
					...row,
					project: expectedProjects[index],
				})),
				raw: before.raw.map((row, index) => ({ ...row, project: expectedProjects[index] })),
			});
			expect(intro).toHaveBeenCalledWith(`codemem maintenance project ${action}`);
			expect(outro).toHaveBeenCalledWith(apply ? "done" : "Pass --apply to execute");
		} finally {
			store.close();
			intro.mockRestore();
			outro.mockRestore();
			info.mockRestore();
			message.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("public maintenance commands", () => {
	it("registers backfill-tags maintenance subcommand", () => {
		const backfill = backfills?.commands.find((command) => command.name() === "tags");
		expect(backfill).toBeDefined();
		const longs = backfill?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--limit");
		expect(longs).toContain("--since");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--dry-run");
		expect(longs).toContain("--json");
	});

	it("registers memory prune with repeatable and CSV kind options", () => {
		// Arrange
		const pruneMem = memory?.commands.find((command) => command.name() === "prune");
		// Act
		const pruneMemLongs = pruneMem?.options.map((option) => option.long) ?? [];
		// Assert
		expect(pruneMem).toBeDefined();
		expect(pruneMemLongs).toContain("--limit");
		expect(pruneMemLongs).toContain("--kind");
		expect(pruneMemLongs).toContain("--kinds");
		expect(pruneMemLongs).toContain("--dry-run");
		expect(pruneMemLongs).toContain("--json");
	});

	it("registers dedup-memories, backfill-dedup-keys, backfill-narrative, and ai-backfill-structured subcommands", () => {
		const dedup = memory?.commands.find((command) => command.name() === "deduplicate");
		const dedupKeys = backfills?.commands.find((command) => command.name() === "dedup-keys");
		const narrative = backfills?.commands.find((command) => command.name() === "narrative");
		const aiStructured = backfills?.commands.find((command) => command.name() === "structured");
		expect(dedup).toBeDefined();
		expect(dedupKeys).toBeDefined();
		expect(narrative).toBeDefined();
		expect(aiStructured).toBeDefined();

		const dedupLongs = dedup?.options.map((option) => option.long) ?? [];
		expect(dedupLongs).toContain("--window");
		expect(dedupLongs).toContain("--limit");
		expect(dedupLongs).toContain("--dry-run");
		expect(dedupLongs).toContain("--json");

		const dedupKeysLongs = dedupKeys?.options.map((option) => option.long) ?? [];
		expect(dedupKeysLongs).toContain("--limit");
		expect(dedupKeysLongs).toContain("--dry-run");
		expect(dedupKeysLongs).toContain("--json");

		const narrativeLongs = narrative?.options.map((option) => option.long) ?? [];
		expect(narrativeLongs).toContain("--limit");
		expect(narrativeLongs).toContain("--dry-run");
		expect(narrativeLongs).toContain("--json");

		const aiLongs = aiStructured?.options.map((option) => option.long) ?? [];
		expect(aiLongs).toContain("--limit");
		expect(aiLongs).toContain("--kinds");
		expect(aiLongs).toContain("--overwrite");
		expect(aiLongs).toContain("--dry-run");
		expect(aiLongs).toContain("--json");
	});

	it("registers prune-raw-events subcommand with age-based options", () => {
		const pruneRaw = database?.commands.find((command) => command.name() === "prune-events");
		expect(pruneRaw).toBeDefined();
		const longs = pruneRaw?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--dry-run");
		expect(longs).toContain("--max-age-days");
		expect(longs).toContain("--vacuum");
		// Age-based only: no size-budget/batch options.
		expect(longs).not.toContain("--max-size-mb");
		expect(longs).not.toContain("--batch-ops");
	});

	function seedRawEvent(store: MemoryStore, sessionId: string, eventId: string, tsWallMs: number) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId,
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: `seed ${eventId}` },
			tsWallMs,
		});
	}

	function countRawEvents(dbPath: string): number {
		const store = new MemoryStore(dbPath);
		try {
			const row = store.db.prepare("SELECT COUNT(*) AS cnt FROM raw_events").get() as {
				cnt: number;
			};
			return Number(row.cnt);
		} finally {
			store.close();
		}
	}

	it("prune-raw-events --dry-run deletes nothing", async () => {
		const pruneRaw = database?.commands.find((command) => command.name() === "prune-events");
		expect(pruneRaw).toBeDefined();
		if (!pruneRaw) throw new Error("expected prune-raw-events command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-prune-raw-")), "test.sqlite");
		initDatabase(dbPath);
		const oldTs = Date.now() - 200 * 86_400_000; // well past a 1-day cutoff
		const store = new MemoryStore(dbPath);
		seedRawEvent(store, "sess-dry", "evt-0", oldTs);
		seedRawEvent(store, "sess-dry", "evt-1", oldTs + 1000);
		store.close();
		expect(countRawEvents(dbPath)).toBe(2);

		await pruneRaw.parseAsync(
			["node", "prune-events", "--db-path", dbPath, "--max-age-days", "1", "--dry-run"],
			{ from: "node" },
		);

		expect(countRawEvents(dbPath)).toBe(2);
	});

	it("prune-raw-events deletes events older than the cutoff and keeps newer ones", async () => {
		const pruneRaw = database?.commands.find((command) => command.name() === "prune-events");
		expect(pruneRaw).toBeDefined();
		if (!pruneRaw) throw new Error("expected prune-raw-events command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-prune-raw-")), "test.sqlite");
		initDatabase(dbPath);
		const now = Date.now();
		const store = new MemoryStore(dbPath);
		// Two old events (older than a 1-day cutoff) and one recent event.
		seedRawEvent(store, "sess-old", "evt-0", now - 10 * 86_400_000);
		seedRawEvent(store, "sess-old", "evt-1", now - 5 * 86_400_000);
		seedRawEvent(store, "sess-new", "evt-2", now - 1000);
		store.close();
		expect(countRawEvents(dbPath)).toBe(3);

		await pruneRaw.parseAsync(
			["node", "prune-events", "--db-path", dbPath, "--max-age-days", "1"],
			{ from: "node" },
		);

		// Only the recent event survives.
		expect(countRawEvents(dbPath)).toBe(1);
		const store2 = new MemoryStore(dbPath);
		try {
			const remaining = store2.db.prepare("SELECT event_id FROM raw_events").all() as Array<{
				event_id: string;
			}>;
			expect(remaining.map((r) => r.event_id)).toEqual(["evt-2"]);
		} finally {
			store2.close();
		}
	});

	it("prune-raw-events rejects invalid --max-age-days and deletes nothing", async () => {
		const pruneRaw = database?.commands.find((command) => command.name() === "prune-events");
		expect(pruneRaw).toBeDefined();
		if (!pruneRaw) throw new Error("expected prune-raw-events command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-prune-raw-bad-")), "test.sqlite");
		initDatabase(dbPath);
		const store = new MemoryStore(dbPath);
		seedRawEvent(store, "sess-x", "evt-0", Date.now() - 10 * 86_400_000);
		store.close();
		expect(countRawEvents(dbPath)).toBe(1);

		const logErrorSpy = vi.spyOn(p.log, "error").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		try {
			// A mistyped age and an explicit 0 must both be rejected — a destructive
			// prune must never run on invalid input. Includes partially-numeric
			// values ("1foo"/"1.5") that Number.parseInt would silently accept as 1.
			for (const bad of ["foo", "0", "1foo", "1.5", "-1", ""]) {
				process.exitCode = undefined;
				await pruneRaw.parseAsync(
					["node", "prune-events", "--db-path", dbPath, "--max-age-days", bad],
					{ from: "node" },
				);
				expect(process.exitCode).toBe(1);
				expect(countRawEvents(dbPath)).toBe(1);
			}
		} finally {
			process.exitCode = originalExitCode;
			logErrorSpy.mockRestore();
		}
	});

	it("prune-raw-events reports a clean error (no uncaught throw) on an unreadable DB", async () => {
		const pruneRaw = database?.commands.find((command) => command.name() === "prune-events");
		expect(pruneRaw).toBeDefined();
		if (!pruneRaw) throw new Error("expected prune-raw-events command");

		// A non-SQLite file makes MemoryStore construction throw; the handler must
		// catch it and set exit code 1 rather than let an uncaught error escape.
		const badDbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-badopen-")), "not-a.sqlite");
		writeFileSync(badDbPath, "this is definitely not a sqlite database");
		const logErrorSpy = vi.spyOn(p.log, "error").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await expect(
				pruneRaw.parseAsync(
					["node", "prune-events", "--db-path", badDbPath, "--max-age-days", "30"],
					{ from: "node" },
				),
			).resolves.toBeDefined();
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode;
			logErrorSpy.mockRestore();
		}
	});

	it("rejects invalid dedup window input", async () => {
		const dedup = memory?.commands.find((command) => command.name() === "deduplicate");
		expect(dedup).toBeDefined();
		if (!dedup) throw new Error("expected dedup-memories command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-cmd-")), "test.sqlite");
		initDatabase(dbPath);
		const logErrorSpy = vi.spyOn(p.log, "error").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await dedup.parseAsync(["node", "deduplicate", "--db-path", dbPath, "--window", "foo"], {
				from: "node",
			});
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode;
			logErrorSpy.mockRestore();
		}
	});

	// `null` scope_id is the DEFAULT scope (matched by scope_id IS NULL OR = local-default).
	function seedReplicationOp(
		store: MemoryStore,
		opId: string,
		scopeId: string | null,
		createdAtIso: string,
	) {
		store.db
			.prepare(
				`INSERT INTO replication_ops
				 (op_id, entity_type, entity_id, op_type, payload_json, clock_rev,
				  clock_updated_at, clock_device_id, device_id, created_at, scope_id)
				 VALUES (?, 'memory_item', ?, 'upsert', '{}', 1, ?, 'dev-a', 'dev-a', ?, ?)`,
			)
			.run(opId, `ent-${opId}`, createdAtIso, createdAtIso, scopeId);
	}

	function countReplicationOpsByScope(dbPath: string): Map<string | null, number> {
		const store = new MemoryStore(dbPath);
		try {
			const rows = store.db
				.prepare(
					"SELECT scope_id AS scope_id, COUNT(*) AS cnt FROM replication_ops GROUP BY scope_id",
				)
				.all() as Array<{ scope_id: string | null; cnt: number }>;
			const counts = new Map<string | null, number>();
			for (const row of rows) counts.set(row.scope_id, Number(row.cnt));
			return counts;
		} finally {
			store.close();
		}
	}

	it("prune-replication-ops deletes old ops across ALL scopes, not just the default", async () => {
		const pruneRepl = database?.commands.find((command) => command.name() === "prune-history");
		expect(pruneRepl).toBeDefined();
		if (!pruneRepl) throw new Error("expected prune-replication-ops command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-prune-repl-")), "test.sqlite");
		initDatabase(dbPath);
		// All rows are well older than a 30-day cutoff so the age pass removes them.
		// No replication_cursors are seeded, so no retained floor blocks deletion.
		const oldIso = new Date(Date.now() - 200 * 86_400_000).toISOString();
		const store = new MemoryStore(dbPath);
		seedReplicationOp(store, "op-default-1", null, oldIso);
		seedReplicationOp(store, "op-default-2", null, oldIso);
		seedReplicationOp(store, "op-oss-1", "oss", oldIso);
		seedReplicationOp(store, "op-oss-2", "oss", oldIso);
		seedReplicationOp(store, "op-legacy-1", "legacy-shared-review", oldIso);
		seedReplicationOp(store, "op-legacy-2", "legacy-shared-review", oldIso);
		store.close();

		const before = countReplicationOpsByScope(dbPath);
		expect(before.get(null)).toBe(2);
		expect(before.get("oss")).toBe(2);
		expect(before.get("legacy-shared-review")).toBe(2);

		await pruneRepl.parseAsync(
			["node", "prune-history", "--db-path", dbPath, "--max-age-days", "30"],
			{ from: "node" },
		);

		// Every scope must be pruned to zero — the regression deletes only the default scope.
		const after = countReplicationOpsByScope(dbPath);
		expect(after.get(null) ?? 0).toBe(0);
		expect(after.get("oss") ?? 0).toBe(0);
		expect(after.get("legacy-shared-review") ?? 0).toBe(0);
	});

	it("prune-replication-ops --dry-run deletes nothing across all scopes", async () => {
		const pruneRepl = database?.commands.find((command) => command.name() === "prune-history");
		expect(pruneRepl).toBeDefined();
		if (!pruneRepl) throw new Error("expected prune-replication-ops command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-prune-repl-dry-")), "test.sqlite");
		initDatabase(dbPath);
		const oldIso = new Date(Date.now() - 200 * 86_400_000).toISOString();
		const store = new MemoryStore(dbPath);
		seedReplicationOp(store, "op-default-1", null, oldIso);
		seedReplicationOp(store, "op-oss-1", "oss", oldIso);
		seedReplicationOp(store, "op-legacy-1", "legacy-shared-review", oldIso);
		store.close();

		await pruneRepl.parseAsync(
			["node", "prune-history", "--db-path", dbPath, "--max-age-days", "30", "--dry-run"],
			{ from: "node" },
		);

		const after = countReplicationOpsByScope(dbPath);
		expect(after.get(null)).toBe(1);
		expect(after.get("oss")).toBe(1);
		expect(after.get("legacy-shared-review")).toBe(1);
	});
});
