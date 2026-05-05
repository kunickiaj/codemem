import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, getSchemaVersion, MemoryStore, SCHEMA_VERSION } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statsCommand } from "./stats.js";

describe("stats command", () => {
	let tmpDir: string;
	let prevCodememConfig: string | undefined;

	beforeEach(() => {
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-stats-command-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
	});

	afterEach(() => {
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("auto-initializes a fresh database before reporting stats", async () => {
		const dbPath = join(tmpDir, "fresh.sqlite");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await statsCommand.parseAsync(["--db-path", dbPath, "--json"], { from: "user" });

			const output = logSpy.mock.calls.at(-1)?.[0];
			expect(typeof output).toBe("string");
			const result = JSON.parse(String(output));
			expect(result.database.path).toBe(dbPath);
			expect(result.database.memory_items).toBe(0);

			const db = connect(dbPath);
			try {
				expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
			} finally {
				db.close();
			}
		} finally {
			logSpy.mockRestore();
		}
	});

	it("reports memory counts through the local scope visibility gate", async () => {
		const dbPath = join(tmpDir, "scoped.sqlite");
		const store = new MemoryStore(dbPath);
		try {
			const now = "2026-01-01T00:00:00Z";
			for (const scopeId of ["authorized-team", "unauthorized-team"]) {
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(scopeId, scopeId, now, now);
			}
			store.db
				.prepare(
					`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
					 VALUES ('authorized-team', ?, 'member', 'active', 1, ?)`,
				)
				.run(store.deviceId, now);

			const sessionId = store.startSession({ cwd: process.cwd(), project: "scope-test" });
			const visibleId = store.remember(sessionId, "discovery", "Visible stats", "Visible body");
			const hiddenId = store.remember(sessionId, "discovery", "Hidden stats", "Hidden body");
			store.db
				.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?")
				.run("authorized-team", visibleId);
			store.db
				.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?")
				.run("unauthorized-team", hiddenId);
			await store.flushPendingVectorWrites();
		} finally {
			store.close();
		}

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await statsCommand.parseAsync(["--db-path", dbPath, "--json"], { from: "user" });

			const output = logSpy.mock.calls.at(-1)?.[0];
			expect(typeof output).toBe("string");
			const result = JSON.parse(String(output));
			expect(result.database.memory_items).toBe(1);
			expect(result.database.active_memory_items).toBe(1);
		} finally {
			logSpy.mockRestore();
		}
	});
});
