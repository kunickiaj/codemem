import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, MemoryStore } from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import * as embeddings from "../../../core/src/embeddings.js";
import {
	forgetMemoryCommand,
	memoryCommand,
	rememberMemoryCommand,
	showMemoryCommand,
} from "./memory.js";

vi.mock("../../../core/src/embeddings.js", async () => {
	const actual = await vi.importActual<typeof import("../../../core/src/embeddings.js")>(
		"../../../core/src/embeddings.js",
	);
	return {
		...actual,
		embedTexts: vi.fn(),
		getEmbeddingClient: vi.fn(),
		resolveEmbeddingModel: vi.fn(() => "test-model"),
	};
});

function insertCoordinatorScope(store: MemoryStore, scopeId: string): void {
	const now = "2026-01-01T00:00:00Z";
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`,
		)
		.run(scopeId, scopeId, now, now);
}

function insertHiddenOwnedMemory(store: MemoryStore): number {
	insertCoordinatorScope(store, "unauthorized-team");
	const sessionId = store.startSession({ cwd: process.cwd(), project: "secret-project" });
	const memoryId = store.remember(sessionId, "discovery", "Hidden owned memory", "Hidden body");
	store.db
		.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?")
		.run("unauthorized-team", memoryId);
	return memoryId;
}

describe("memory command aliases", () => {
	it("keeps memory subcommands available under the memory group", () => {
		expect(memoryCommand.commands.map((command) => command.name())).toEqual([
			"show",
			"forget",
			"remember",
			"inject",
			"role-report",
			"role-compare",
			"extraction-report",
			"extraction-replay",
			"extraction-benchmark",
			"relink-report",
			"relink-plan",
		]);
	});

	it("exports top-level compatibility aliases", () => {
		expect(showMemoryCommand.name()).toBe("show");
		expect(forgetMemoryCommand.name()).toBe("forget");
		expect(rememberMemoryCommand.name()).toBe("remember");
	});

	it("keeps inject expecting a context argument", () => {
		const inject = memoryCommand.commands.find((command) => command.name() === "inject");
		expect(inject).toBeDefined();
		expect(inject?.registeredArguments[0]?.required).toBe(true);
		expect(inject?.registeredArguments[0]?.name()).toBe("context");
		expect(inject?.options.some((option) => option.long === "--working-set-file")).toBe(true);
	});

	it("registers role-report under memory with shared analysis options", () => {
		const roleReport = memoryCommand.commands.find((command) => command.name() === "role-report");
		expect(roleReport).toBeDefined();
		const longs = roleReport?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--probe");
		expect(longs).toContain("--scenario");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--json");
	});

	it("registers role-compare under memory with scenario options", () => {
		const roleCompare = memoryCommand.commands.find((command) => command.name() === "role-compare");
		expect(roleCompare).toBeDefined();
		const longs = roleCompare?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--probe");
		expect(longs).toContain("--scenario");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--json");
	});

	it("registers extraction-report under memory with session eval options", () => {
		const extractionReport = memoryCommand.commands.find(
			(command) => command.name() === "extraction-report",
		);
		expect(extractionReport).toBeDefined();
		const longs = extractionReport?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--session-id");
		expect(longs).toContain("--batch-id");
		expect(longs).toContain("--scenario");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--json");
	});

	it("registers extraction-replay under memory with replay eval options", () => {
		const extractionReplay = memoryCommand.commands.find(
			(command) => command.name() === "extraction-replay",
		);
		expect(extractionReplay).toBeDefined();
		const longs = extractionReplay?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--batch-id");
		expect(longs).toContain("--observer-tier-routing");
		expect(longs).toContain("--openai-responses");
		expect(longs).toContain("--reasoning-effort");
		expect(longs).toContain("--reasoning-summary");
		expect(longs).toContain("--max-output-tokens");
		expect(longs).toContain("--observer-temperature");
		expect(longs).toContain("--transcript-budget");
		expect(longs).toContain("--scenario");
		expect(longs).toContain("--json");
	});

	it("registers extraction-benchmark under memory with benchmark-runner options", () => {
		const extractionBenchmark = memoryCommand.commands.find(
			(command) => command.name() === "extraction-benchmark",
		);
		expect(extractionBenchmark).toBeDefined();
		const longs = extractionBenchmark?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--benchmark");
		expect(longs).toContain("--observer-provider");
		expect(longs).toContain("--observer-model");
		expect(longs).toContain("--observer-tier-routing");
		expect(longs).toContain("--openai-responses");
		expect(longs).toContain("--reasoning-effort");
		expect(longs).toContain("--reasoning-summary");
		expect(longs).toContain("--max-output-tokens");
		expect(longs).toContain("--observer-temperature");
		expect(longs).toContain("--transcript-budget");
		expect(longs).toContain("--json");
	});

	it("registers relink-report under memory with dry-run analysis options", () => {
		const relinkReport = memoryCommand.commands.find(
			(command) => command.name() === "relink-report",
		);
		expect(relinkReport).toBeDefined();
		const longs = relinkReport?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--limit");
		expect(longs).toContain("--json");
	});

	it("registers relink-plan under memory with dry-run planning options", () => {
		const relinkPlan = memoryCommand.commands.find((command) => command.name() === "relink-plan");
		expect(relinkPlan).toBeDefined();
		const longs = relinkPlan?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--limit");
		expect(longs).toContain("--json");
	});
});

describe("memory command scope safety", () => {
	it("stores vectors for manually remembered memories", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-memory-command-vector-"));
		const dbPath = join(tmpDir, "test.sqlite");
		initDatabase(dbPath);
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
			model: "test-model",
			dimensions: 384,
			embed: vi.fn(),
		});
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await rememberMemoryCommand.parseAsync(
				[
					"--kind",
					"discovery",
					"--title",
					"Manual vector memory",
					"--body",
					"Manual vector body",
					"--db-path",
					dbPath,
					"--json",
				],
				{ from: "user" },
			);

			const output = logSpy.mock.calls.at(-1)?.[0];
			const parsed = JSON.parse(String(output)) as { id: number };
			expect(parsed.id).toBeGreaterThan(0);
			expect(process.exitCode).toBeUndefined();

			const verifyStore = new MemoryStore(dbPath);
			try {
				const row = verifyStore.db
					.prepare("SELECT COUNT(*) AS n FROM memory_vectors WHERE memory_id = ?")
					.get(parsed.id) as { n: number };
				expect(row.n).toBe(1);
			} finally {
				verifyStore.close();
			}
		} finally {
			process.exitCode = originalExitCode;
			logSpy.mockRestore();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not forget memories outside visible sharing domains", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-memory-command-scope-"));
		const dbPath = join(tmpDir, "test.sqlite");
		initDatabase(dbPath);
		const store = new MemoryStore(dbPath);
		const memoryId = insertHiddenOwnedMemory(store);
		await store.flushPendingVectorWrites();
		store.close();

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await forgetMemoryCommand.parseAsync([String(memoryId), "--db-path", dbPath, "--json"], {
				from: "user",
			});

			const output = logSpy.mock.calls.at(-1)?.[0];
			expect(JSON.parse(String(output))).toMatchObject({
				error: "not_found",
				message: `Memory ${memoryId} not found`,
			});
			expect(process.exitCode).toBe(1);

			const verifyStore = new MemoryStore(dbPath);
			try {
				const row = verifyStore.db
					.prepare("SELECT active FROM memory_items WHERE id = ?")
					.get(memoryId) as { active: number };
				expect(row.active).toBe(1);
			} finally {
				verifyStore.close();
			}
		} finally {
			process.exitCode = originalExitCode;
			logSpy.mockRestore();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
