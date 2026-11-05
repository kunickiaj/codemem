import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { connect, initTestSchema, MemoryStore } from "@codemem/core";
import {
	readRelayServicePin,
	reconcileRelayServicePin,
} from "@codemem/core/internal/relay-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { testSigner } from "../../../core/src/relay-server-test-fixtures.js";
import { approveRelayKeyCommand, relayKeysCommand } from "./sync-relay-keys.js";

const COORDINATOR = "https://coord.example";
const PINNED = CANONICAL_PUBLIC_KEY;
const CANDIDATE = testSigner(3).publicKey;
const OTHER = testSigner(4).publicKey;

const ctx = {
	dir: "",
	dbPath: "",
	configPath: "",
	logSpy: undefined as unknown as ReturnType<typeof vi.spyOn>,
	previousExitCode: undefined as typeof process.exitCode,
};

function withDb<T>(run: (store: MemoryStore) => T): T {
	const store = new MemoryStore(ctx.dbPath);
	try {
		return run(store);
	} finally {
		store.close();
	}
}

function pin(groupId: string, ...keys: string[]) {
	withDb((store) => {
		for (const advertisedKey of keys)
			reconcileRelayServicePin(store.db, { coordinatorId: COORDINATOR, groupId, advertisedKey });
	});
}

const stored = (groupId: string) =>
	withDb((store) => readRelayServicePin(store.db, COORDINATOR, groupId));
const approve = (...args: string[]) =>
	approveRelayKeyCommand.parseAsync(
		[...args, "--db-path", ctx.dbPath, "--config", ctx.configPath],
		{ from: "user" },
	);
const jsonOutput = () => JSON.parse(String(ctx.logSpy.mock.calls.at(-1)?.[0]));

beforeEach(() => {
	ctx.dir = mkdtempSync(join(tmpdir(), "sync-relay-keys-test-"));
	ctx.dbPath = join(ctx.dir, "mem.sqlite");
	ctx.configPath = join(ctx.dir, "config.json");
	writeFileSync(ctx.configPath, JSON.stringify({ sync_coordinator_url: COORDINATOR }));
	const db = connect(ctx.dbPath);
	initTestSchema(db);
	db.close();
	ctx.logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	ctx.previousExitCode = process.exitCode;
	process.exitCode = undefined;
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(ctx.dir, { recursive: true, force: true });
	process.exitCode = ctx.previousExitCode;
});

describe("sync relay-keys", () => {
	it("lists pins with state, pinned key, candidate, and last candidate as JSON", async () => {
		pin("team-a", PINNED, CANDIDATE);
		pin("team-b", PINNED, OTHER, PINNED);

		await relayKeysCommand.parseAsync(["--db-path", ctx.dbPath, "--json"], { from: "user" });

		expect(jsonOutput()).toEqual([
			expect.objectContaining({
				coordinator_id: COORDINATOR,
				group_id: "team-a",
				state: "pending_change",
				pinned_key: PINNED,
				candidate_key: CANDIDATE,
				last_candidate_key: null,
			}),
			expect.objectContaining({
				group_id: "team-b",
				state: "pinned",
				candidate_key: null,
				last_candidate_key: OTHER,
			}),
		]);
		expect(process.exitCode).toBeUndefined();
	});

	it("lists pins as text", async () => {
		pin("team-a", PINNED, CANDIDATE);
		const message = vi.spyOn(p.log, "message").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await relayKeysCommand.parseAsync(["--db-path", ctx.dbPath], { from: "user" });

		const text = String(message.mock.calls[0]?.[0]);
		expect(text).toContain("state: paused, key change pending approval");
		expect(text).toContain(`pinned key: ${PINNED}`);
		expect(text).toContain(`candidate: ${CANDIDATE}`);
		expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
			"1 pin(s), 1 pending approval",
		);
	});
});

describe("sync approve-relay-key", () => {
	it("is a sibling of relay-keys so the command path stays at two levels", () => {
		expect(relayKeysCommand.commands).toHaveLength(0);
		expect(approveRelayKeyCommand.name()).toBe("approve-relay-key");
	});

	it("approves the exact pending candidate", async () => {
		pin("team-a", PINNED, CANDIDATE);

		await approve("team-a", "--key", `${CANDIDATE} operator-comment`, "--json");

		expect(jsonOutput()).toEqual({
			ok: true,
			coordinator_id: COORDINATOR,
			group_id: "team-a",
			pinned_key: CANDIDATE,
			previous_key: PINNED,
		});
		expect(stored("team-a")).toMatchObject({ state: "pinned", pinnedKey: CANDIDATE });
		expect(process.exitCode).toBeUndefined();
	});

	it("refuses a key that is not the pending candidate and shows both keys", async () => {
		pin("team-a", PINNED, CANDIDATE);

		await approve("team-a", "--key", OTHER, "--json");

		expect(jsonOutput()).toMatchObject({ error: "candidate_mismatch" });
		expect(jsonOutput().message).toContain(PINNED);
		expect(jsonOutput().message).toContain(CANDIDATE);
		expect(stored("team-a")).toMatchObject({ state: "pending_change", candidateKey: CANDIDATE });
		expect(process.exitCode).toBe(1);
	});

	it("requires --key when it cannot prompt", async () => {
		pin("team-a", PINNED, CANDIDATE);

		await approve("team-a", "--json");

		expect(jsonOutput()).toMatchObject({ error: "key_required" });
		expect(stored("team-a")?.state).toBe("pending_change");
		expect(process.exitCode).toBe(2);
	});

	it("reports nothing pending", async () => {
		pin("team-a", PINNED);

		await approve("team-a", "--key", CANDIDATE, "--json");

		expect(jsonOutput()).toMatchObject({ error: "nothing_pending" });
		expect(stored("team-a")).toMatchObject({ state: "pinned", pinnedKey: PINNED });
		expect(process.exitCode).toBe(1);
	});

	it("refuses approval without an https coordinator URL", async () => {
		writeFileSync(ctx.configPath, JSON.stringify({ sync_coordinator_url: "http://coord.example" }));

		await approve("team-a", "--key", CANDIDATE, "--json");

		expect(jsonOutput()).toMatchObject({ error: "coordinator_not_configured" });
		expect(process.exitCode).toBe(1);
	});
});
