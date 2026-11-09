import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookIngestSpool, type SpoolHandler } from "./hook-ingest-spool.js";

vi.mock("./claude-hook-plugin-log.js", () => ({ logHookEvent: vi.fn() }));

type SpoolHandlerReturn = Awaited<ReturnType<SpoolHandler>>;
type EntrySnapshot = { bytes: Buffer; mtimeMs: number };

function seedEntries(queueDir: string, tags: string[]): Map<string, EntrySnapshot> {
	const snapshots = new Map<string, EntrySnapshot>();
	for (const [index, tag] of tags.entries()) {
		const name = `hook-${String(index).padStart(4, "0")}.json`;
		const path = join(queueDir, name);
		const bytes = Buffer.from(`${JSON.stringify({ tag, text: "é\n" })}\n`);
		writeFileSync(path, bytes, { mode: 0o600 });
		utimesSync(path, 1_700_000_000, 1_700_000_000);
		snapshots.set(name, { bytes, mtimeMs: statSync(path).mtimeMs });
	}
	return snapshots;
}

function expectPreserved(queueDir: string, snapshots: Map<string, EntrySnapshot>): void {
	expect(readdirSync(queueDir).sort()).toEqual([...snapshots.keys()]);
	for (const [name, snapshot] of snapshots) {
		const path = join(queueDir, name);
		expect(readFileSync(path)).toEqual(snapshot.bytes);
		expect(statSync(path).mtimeMs).toBe(snapshot.mtimeMs);
	}
}

describe("hook spool delivery outcomes", () => {
	let root: string;
	let queueDir: string;
	let spool: ReturnType<typeof createHookIngestSpool>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codemem-spool-outcomes-"));
		queueDir = join(root, "spool");
		mkdirSync(queueDir, { mode: 0o700 });
		vi.stubEnv("CODEMEM_TEST_OUTCOME_SPOOL_DIR", "");
		spool = createHookIngestSpool({
			logPrefix: "test hook ingest",
			lockDirEnv: "CODEMEM_TEST_OUTCOME_LOCK_DIR",
			lockDirDefault: join(root, "lock"),
			lockTtlEnv: "CODEMEM_TEST_OUTCOME_LOCK_TTL",
			lockTtlDefault: 120,
			lockGraceEnv: "CODEMEM_TEST_OUTCOME_LOCK_GRACE",
			lockGraceDefault: 2,
			lockAcquireAttempts: 1,
			spoolDirEnv: "CODEMEM_TEST_OUTCOME_SPOOL_DIR",
			spoolDirDefault: queueDir,
			lockBusyErrorName: "TestLockBusyError",
			lockBusyErrorMessage: "test lock busy",
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it.each([true, { outcome: "accepted" }] as const)(
		"deletes a receipt only after accepted delivery: %j",
		async (outcome) => {
			// Arrange: cover structured acceptance and existing boolean callers.
			seedEntries(queueDir, ["old"]);
			const handler = vi.fn(() => outcome);

			// Act.
			const result = await spool.drainSpool(handler);

			// Assert: retain the public counts and receipt callback contract.
			expect(result).toEqual({ processed: 1, failed: 0 });
			expect(handler).toHaveBeenCalledExactlyOnceWith(
				{ tag: "old", text: "é\n" },
				"hook-0000.json",
			);
			expect(readdirSync(queueDir)).toEqual([]);
		},
	);

	it("processes every accepted entry in filename order", async () => {
		// Arrange.
		seedEntries(queueDir, ["old", "middle", "healthy"]);
		const seen: unknown[] = [];

		// Act.
		const result = await spool.drainSpool(async (payload) => {
			seen.push(payload.tag);
			return { outcome: "accepted" };
		});

		// Assert.
		expect(seen).toEqual(["old", "middle", "healthy"]);
		expect(result).toEqual({ processed: 3, failed: 0 });
		expect(readdirSync(queueDir)).toEqual([]);
	});

	it("deletes an accepted prefix but stops at the next retryable entry", async () => {
		// Arrange.
		const snapshots = seedEntries(queueDir, ["accepted", "retryable", "healthy"]);
		const seen: unknown[] = [];

		// Act.
		const result = await spool.drainSpool((payload) => {
			seen.push(payload.tag);
			if (payload.tag === "accepted") return { outcome: "accepted" };
			return { outcome: "retryable" };
		});

		// Assert: later healthy delivery must not overtake the retained head.
		expect(result).toEqual({ processed: 1, failed: 1 });
		expect(seen).toEqual(["accepted", "retryable"]);
		snapshots.delete("hook-0000.json");
		expectPreserved(queueDir, snapshots);
	});

	it.each([
		false,
		{ outcome: "retryable" },
		{ outcome: "terminal", status: 400, reason: "invalid_payload" },
		{ outcome: "terminal", status: 413, reason: "payload_too_large" },
	] as const)("preserves the active head and blocks healthy delivery: %j", async (outcome) => {
		// Arrange: terminal outcomes do not authorize retention or deletion yet.
		const snapshots = seedEntries(queueDir, ["old-rejected", "healthy"]);
		const handler = vi.fn(() => outcome);

		// Act.
		const result = await spool.drainSpool(handler);

		// Assert.
		expect(result).toEqual({ processed: 0, failed: 1 });
		expect(handler).toHaveBeenCalledExactlyOnceWith(
			{ tag: "old-rejected", text: "é\n" },
			"hook-0000.json",
		);
		expectPreserved(queueDir, snapshots);
	});

	const invalidOutcomes: Array<{ label: string; value: unknown }> = [
		{ label: "empty object", value: {} },
		{ label: "empty array", value: [] },
		{ label: "nonempty array", value: [true] },
		{ label: "accepted string", value: "accepted" },
		{ label: "true string", value: "true" },
		{ label: "positive number", value: 1 },
		{ label: "negative number", value: -1 },
		{ label: "zero", value: 0 },
		{ label: "boxed boolean", value: Object(true) },
		{ label: "null", value: null },
		{ label: "undefined", value: undefined },
		{ label: "unknown outcome", value: { outcome: "unknown" } },
		{ label: "incomplete terminal", value: { outcome: "terminal" } },
		{ label: "wrong terminal status", value: { outcome: "terminal", status: 500 } },
	];

	it.each(invalidOutcomes)("does not delete for invalid $label", async ({ value }) => {
		// Arrange: deliberately cross the typed boundary with malformed runtime data.
		const snapshots = seedEntries(queueDir, ["old-rejected", "healthy"]);
		const handler = vi.fn(() => value as unknown as SpoolHandlerReturn);

		// Act.
		const result = await spool.drainSpool(handler);

		// Assert: JavaScript truthiness cannot authorize cleanup.
		expect(result).toEqual({ processed: 0, failed: 1 });
		expect(handler).toHaveBeenCalledTimes(1);
		expectPreserved(queueDir, snapshots);
	});

	it.each(["throw", "reject", "getter"] as const)(
		"preserves entries when handler delivery fails through %s",
		async (failure) => {
			// Arrange: exceptions must not authorize cleanup or escape the drain.
			const snapshots = seedEntries(queueDir, ["old-rejected", "healthy"]);
			const handler = vi.fn(() => {
				if (failure === "throw") throw new Error("synthetic handler failure");
				if (failure === "reject") return Promise.reject(new Error("synthetic rejection"));
				const malformed: unknown = Object.defineProperty({}, "outcome", {
					get() {
						throw new Error("synthetic getter failure");
					},
				});
				return malformed as unknown as SpoolHandlerReturn;
			});

			// Act.
			const result = await spool.drainSpool(handler);

			// Assert.
			expect(result).toEqual({ processed: 0, failed: 1 });
			expect(handler).toHaveBeenCalledTimes(1);
			expectPreserved(queueDir, snapshots);
		},
	);
});
