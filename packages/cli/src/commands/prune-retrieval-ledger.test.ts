import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabasePruneRetrievalLedgerCommand } from "./prune-retrieval-ledger.js";

function seed(dbPath: string): void {
	const db = connect(dbPath);
	try {
		const attempt = db.prepare(
			`INSERT INTO retrieval_attempts(
				attempt_id, contract_version, surface, trigger, started_at, retrieval_status,
				delivery_status, candidate_count, selected_count, persisted_candidate_count,
				recorder_version, retention_until, retention_pinned
			) VALUES (?, 1, 'prompt_pack', 'automatic', '2026-01-01T00:00:00.000Z', 'succeeded',
				'handed_off', 1, 1, 1, 'test', ?, ?)`,
		);
		const exposure = db.prepare(
			"INSERT INTO retrieval_exposures(attempt_id, rank, disposition, handoff_status) VALUES (?, 1, 'dropped', 'not_attempted')",
		);
		for (let index = 0; index < 5; index++) {
			attempt.run(`expired-${index}`, "2026-02-01T00:00:00.000Z", 0);
			exposure.run(`expired-${index}`);
		}
		attempt.run("pinned", "2026-02-01T00:00:00.000Z", 1);
		attempt.run("future", "2999-01-01T00:00:00.000Z", 0);
	} finally {
		db.close();
	}
}

async function run(args: string[]): Promise<unknown> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await createDatabasePruneRetrievalLedgerCommand().parseAsync(args, { from: "user" });
		return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
	} finally {
		log.mockRestore();
	}
}

describe("maintenance database prune-retrieval-ledger", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codemem-prune-ledger-"));
		dbPath = join(dir, "mem.sqlite");
		seed(dbPath);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		process.exitCode = undefined;
	});

	it("reports what is past retention on a dry run and deletes nothing", async () => {
		const result = (await run(["--db-path", dbPath, "--dry-run", "--json"])) as {
			dry_run: boolean;
			purged: unknown;
			before: { retrieval_attempts: number; expired_retrieval_attempts: number };
		};
		expect(result.dry_run).toBe(true);
		expect(result.purged).toBeNull();
		expect(result.before).toMatchObject({ retrieval_attempts: 7, expired_retrieval_attempts: 5 });
	});

	it("deletes every expired attempt in small batches and keeps pinned and future ones", async () => {
		const result = (await run(["--db-path", dbPath, "--batch-size", "2", "--json"])) as {
			purged: { retrieval_attempts: number; batches: number };
			after: { retrieval_attempts: number; retrieval_exposures: number };
		};
		expect(result.purged).toMatchObject({ retrieval_attempts: 5 });
		expect(result.purged.batches).toBeGreaterThanOrEqual(3);
		expect(result.after).toMatchObject({ retrieval_attempts: 2, retrieval_exposures: 0 });
	});

	it("rejects an invalid batch size with exit code 2", async () => {
		const result = await run(["--db-path", dbPath, "--batch-size", "0", "--json"]);
		expect(result).toMatchObject({ error: "invalid_batch_size" });
		expect(process.exitCode).toBe(2);
	});
});
