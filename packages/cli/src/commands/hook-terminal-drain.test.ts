import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHookIngestSpool } from "./hook-ingest-spool.js";
import { retainNativeHookReceipt } from "./native-hook-retained-spool.js";

vi.mock("./claude-hook-plugin-log.js", () => ({ logHookEvent: vi.fn() }));

const head = "hook-1730000000-123-1234.json";
const next = "hook-1730000001-123-1234.json";
const terminal = { outcome: "terminal", status: 400, reason: "invalid_payload" } as const;
let dir: string;
let spool: ReturnType<typeof createHookIngestSpool>;
const bytes = ' \n{"session_id":"msg_fixture","prompt":"café"}\n';

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-terminal-drain-"));
	vi.stubEnv("CODEMEM_TEST_TERMINAL_SPOOL", dir);
	spool = createHookIngestSpool({
		logPrefix: "test terminal drain",
		lockDirEnv: "CODEMEM_TEST_TERMINAL_LOCK",
		lockDirDefault: join(dir, "lock"),
		lockTtlEnv: "CODEMEM_TEST_TERMINAL_TTL",
		lockTtlDefault: 120,
		lockGraceEnv: "CODEMEM_TEST_TERMINAL_GRACE",
		lockGraceDefault: 2,
		lockAcquireAttempts: 1,
		spoolDirEnv: "CODEMEM_TEST_TERMINAL_SPOOL",
		spoolDirDefault: dir,
		lockBusyErrorName: "TestLockBusyError",
		lockBusyErrorMessage: "test lock busy",
	});
	writeFileSync(join(dir, head), bytes);
	writeFileSync(join(dir, next), JSON.stringify({ session_id: "healthy" }));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

it("retains a terminal head before delivering the healthy successor", async () => {
	// Arrange: the callback owns retention. The factory must not count rejection as delivery.
	const calls: string[] = [];
	// Act.
	const result = await spool.drainSpool(
		(_payload, receipt) => {
			calls.push(receipt);
			return receipt === head ? terminal : true;
		},
		{
			retainTerminal: async ({ receipt, rejection }) => {
				calls.push("retain");
				const retained = await retainNativeHookReceipt({ dir, receipt, ...rejection });
				return retained.outcome === "retained";
			},
		},
	);
	// Assert.
	expect(calls).toEqual([head, "retain", next]);
	expect(result).toEqual({ processed: 1, failed: 1 });
	const retained = `rejected-400-invalid_payload-${head}.retained`;
	expect(readdirSync(dir)).toEqual([retained]);
	expect(readFileSync(join(dir, retained), "utf8")).toBe(bytes);
});

it.each(["sync", "async"])(
	"does not unlink the terminal receipt when a %s callback only records success",
	async (mode) => {
		// Arrange: a deliberately recording-only callback proves that the factory owns no terminal unlink.
		const retainTerminal = vi.fn(() => (mode === "sync" ? true : Promise.resolve(true)));
		// Act.
		const result = await spool.drainSpool(
			(_payload, receipt) => (receipt === head ? terminal : true),
			{ retainTerminal },
		);
		// Assert.
		expect(result).toEqual({ processed: 1, failed: 1 });
		expect(retainTerminal).toHaveBeenCalledExactlyOnceWith({ receipt: head, rejection: terminal });
		expect(readdirSync(dir)).toEqual([head]);
		expect(readFileSync(join(dir, head), "utf8")).toBe(bytes);
	},
);

it.each(["missing", "false", "throw", "reject", "truthy", "undefined"])(
	"keeps the head and stops when retention returns %s",
	async (mode) => {
		// Arrange: only literal true can authorize moving past the rejected receipt.
		const retainTerminal = vi.fn(() => {
			if (mode === "throw") throw new Error("retention unavailable");
			if (mode === "reject") return Promise.reject(new Error("retention unavailable"));
			if (mode === "truthy") return "true" as unknown as boolean;
			if (mode === "undefined") return undefined as unknown as boolean;
			return false;
		});
		const handler = vi.fn(() => terminal);
		// Act.
		const result = await spool.drainSpool(
			handler,
			mode === "missing" ? undefined : { retainTerminal },
		);
		// Assert.
		expect(result).toEqual({ processed: 0, failed: 1 });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(retainTerminal).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
		expect(readdirSync(dir).sort()).toEqual([head, next]);
		expect(readFileSync(join(dir, head), "utf8")).toBe(bytes);
	},
);

it.each([true, false] as const)(
	"preserves boolean delivery behavior with a retention callback: %s",
	async (accepted) => {
		// Arrange.
		const retainTerminal = vi.fn(() => true);
		const handler = vi.fn(() => accepted);
		// Act.
		const result = await spool.drainSpool(handler, { retainTerminal });
		// Assert.
		expect(result).toEqual(accepted ? { processed: 2, failed: 0 } : { processed: 0, failed: 1 });
		expect(readdirSync(dir).sort()).toEqual(accepted ? [] : [head, next]);
		expect(retainTerminal).not.toHaveBeenCalled();
	},
);
