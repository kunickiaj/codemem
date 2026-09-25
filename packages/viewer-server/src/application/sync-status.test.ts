import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import { safeDaemonIssueCode } from "./sync-status.js";

describe("safe daemon issue codes", () => {
	it("classifies a coordinator request timeout without returning private error details", () => {
		const error =
			"daemon tick callback failed: coordinator enrollment maintenance failed for 1 group [private-group:list_devices:request_timeout]";
		const code = safeDaemonIssueCode("error", error);
		expect(code).toBe("coordinator_timeout");
		expect(JSON.stringify({ daemon_issue_code: code })).not.toContain("private-group");
		expect(
			safeDaemonIssueCode(
				"error",
				"coordinator enrollment maintenance failed for 4 groups [first:list_devices:bad_response, +3 more] (coordinator_timeout)",
			),
		).toBe("coordinator_timeout");
	});

	it("does not surface a resolved or unrelated error as coordinator trouble", () => {
		const error =
			"coordinator enrollment maintenance failed for 1 group [private-group:other_failure]";
		expect(safeDaemonIssueCode("ok", error)).toBeNull();
		expect(safeDaemonIssueCode("error", error)).toBe("coordinator_error");
		expect(safeDaemonIssueCode("error", "peer private-id failed")).toBeNull();
	});
});

it("keeps redacted status consistent when a runtime phase masks an older daemon error", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codemem-sync-status-test-"));
	const configPath = join(directory, "config.json");
	const dbPath = join(directory, "mem.sqlite");
	const previousConfig = process.env.CODEMEM_CONFIG;
	writeFileSync(configPath, JSON.stringify({ sync_enabled: true }));
	process.env.CODEMEM_CONFIG = configPath;
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	rawDb.close();
	let store: MemoryStore | null = null;
	try {
		store = new MemoryStore(dbPath);
		store.db
			.prepare("INSERT INTO sync_daemon_state(id, last_error, last_error_at) VALUES (1, ?, ?)")
			.run(
				"coordinator enrollment maintenance failed [private-group:list_devices:request_timeout]",
				new Date().toISOString(),
			);
		let phase: "starting" | "running" | "error" = "starting";
		const app = createApp({
			storeFactory: () => store as MemoryStore,
			getSyncRuntimeStatus: () => ({
				phase,
				detail: phase === "error" ? "startup failed at /private/secret/path" : null,
			}),
		});
		const starting = (await (await app.request("/api/sync/status")).json()) as Record<
			string,
			unknown
		>;
		expect(starting.daemon_state).toBe("starting");
		expect((starting.status as Record<string, unknown>).daemon_issue_code).toBeNull();
		phase = "running";
		const failed = (await (await app.request("/api/sync/status")).json()) as Record<
			string,
			unknown
		>;
		expect(failed.daemon_state).toBe("error");
		expect((failed.status as Record<string, unknown>).daemon_issue_code).toBe(
			"coordinator_timeout",
		);
		expect(JSON.stringify(failed)).not.toContain("private-group");
		phase = "error";
		const runtimeFailure = (await (await app.request("/api/sync/status")).json()) as Record<
			string,
			unknown
		>;
		expect(runtimeFailure.daemon_state).toBe("error");
		expect((runtimeFailure.status as Record<string, unknown>).daemon_issue_code).toBeNull();
		expect(runtimeFailure.daemon_detail).toBe(
			"Background sync failed. Open diagnostics for details.",
		);
		expect(JSON.stringify(runtimeFailure)).not.toContain("/private/secret/path");
		expect(JSON.stringify(runtimeFailure)).not.toContain("private-group");
		const diagnostics = (await (
			await app.request("/api/sync/status?includeDiagnostics=1")
		).json()) as Record<string, unknown>;
		expect(diagnostics.daemon_detail).toBe("startup failed at /private/secret/path");
	} finally {
		store?.close();
		if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = previousConfig;
		rmSync(directory, { recursive: true, force: true });
	}
});
