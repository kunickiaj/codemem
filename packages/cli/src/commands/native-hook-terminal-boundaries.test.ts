import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ingestClaudeHookPayload } from "./claude-hook-ingest.js";
import { ingestPiHookPayload } from "./pi-hook-ingest.js";

vi.mock("./claude-hook-plugin-log.js", () => ({ logHookEvent: vi.fn() }));
const head = "hook-1730000000-123-1234.json";
const second = "hook-1730000001-123-1234.json";
const floor = "_codememBoundaryThroughEventSeq";
const ts = "2026-09-17T12:00:00.000Z";
let home: string;
let dir: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-native-boundaries-"));
	dir = join(home, "spool");
	mkdirSync(dir);
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	for (const provider of ["CLAUDE", "PI"]) {
		vi.stubEnv(`CODEMEM_${provider}_HOOK_SPOOL_DIR`, dir);
		vi.stubEnv(`CODEMEM_${provider}_HOOK_LOCK_DIR`, join(home, `${provider}-lock`));
	}
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_FLUSH", "1");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});
function seed(payload: Record<string, unknown>, receipt = head) {
	const bytes = ` \n${JSON.stringify(payload)}\n`;
	writeFileSync(join(dir, receipt), bytes);
	return bytes;
}
function pi(tag: string, boundary = false) {
	return {
		piEvent: boundary ? "session_shutdown" : "session_start",
		sessionId: `fixture-${tag}`,
		ts,
		tag,
	};
}
function transport(reply: () => Response) {
	const calls: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("expected serialized request");
			const payload = JSON.parse(init.body);
			calls.push(payload.tag);
			return payload.tag === "healthy"
				? Response.json({ accepted: 1, queued: 1 }, { status: 202 })
				: reply();
		}),
	);
	return calls;
}
const opts = { host: "127.0.0.1", port: 38888 };
function db() {
	return join(home, "fixture.sqlite");
}

it("Claude retains an older SessionEnd rejection before delivering the current ordinary event", async () => {
	// Arrange: local boundary fallback belongs only to the current invocation's boundary.
	const bytes = seed({ hook_event_name: "SessionEnd", session_id: "older", tag: "head" });
	const calls = transport(() =>
		Response.json({ error: "payload too large", max_bytes: 1 }, { status: 413 }),
	);
	const directIngest = vi.fn(() => ({ inserted: 1, skipped: 0 }));
	const boundaryFlush = vi.fn();
	// Act.
	const result = await ingestClaudeHookPayload(
		{
			hook_event_name: "UserPromptSubmit",
			session_id: "healthy",
			prompt: "fixture",
			tag: "healthy",
		},
		opts,
		{ resolveDb: db, directIngest, boundaryFlush },
	);
	// Assert: the older boundary stays available for operator recovery without blocking healthy delivery.
	expect(calls).toEqual(["head", "healthy"]);
	expect(result).toEqual({ inserted: 0, skipped: 0, via: "http" });
	expect(directIngest).not.toHaveBeenCalled();
	expect(boundaryFlush).not.toHaveBeenCalled();
	const retained = `rejected-413-payload_too_large-${head}.retained`;
	expect(readdirSync(dir)).toEqual([retained]);
	expect(readFileSync(join(dir, retained), "utf8")).toBe(bytes);
});

it.each([true, false])(
	"Claude current boundary gets its local fallback before retention: direct success %s",
	async (success) => {
		// Arrange: an old ordinary rejection can be retained. The current boundary still has a fallback obligation.
		seed({
			hook_event_name: "UserPromptSubmit",
			session_id: "old",
			prompt: "fixture",
			tag: "head",
		});
		const calls = transport(() =>
			Response.json({ error: "payload too large", max_bytes: 1 }, { status: 413 }),
		);
		const current = { hook_event_name: "SessionEnd", session_id: "current", tag: "current" };
		const directIngest = vi.fn(() => {
			if (!success) throw new Error("temporary local write failure");
			return { inserted: 1, skipped: 0 };
		});
		const boundaryFlush = vi.fn();
		// Act.
		const result = await ingestClaudeHookPayload(current, opts, {
			resolveDb: db,
			directIngest,
			boundaryFlush,
		});
		// Assert: the current rejection cannot remove a future local recovery opportunity.
		expect(calls).toEqual(["head", "current"]);
		expect(directIngest).toHaveBeenCalledExactlyOnceWith(current, db());
		expect(result.via).toBe(success ? "direct" : "spool");
		expect(boundaryFlush).toHaveBeenCalledTimes(success ? 1 : 0);
		expect(readdirSync(dir).filter((name) => name.endsWith(".retained"))).toEqual([
			`rejected-413-payload_too_large-${head}.retained`,
		]);
		const active = readdirSync(dir).filter((name) => name.endsWith(".json"));
		expect(active).toHaveLength(success ? 0 : 1);
		if (!success) {
			const receipt = active[0];
			if (!receipt) throw new Error("expected current boundary to remain retryable");
			expect(JSON.parse(readFileSync(join(dir, receipt), "utf8"))).toEqual(current);
		}
	},
);

it.each([
	"before-floor",
	"saved-floor",
	"direct-write",
	"observer-init",
	"observer-cleanup",
	"http-skip",
] as const)("Pi keeps an unfinished boundary retryable after %s", async (failure) => {
	// Arrange: observer stages are injected callback failures, never actual model calls.
	const bytes = seed(pi("head", true));
	const calls = transport(() =>
		failure === "http-skip"
			? Response.json({ inserted: 0, skipped: 1 })
			: Response.json({ error: "payload too large", max_bytes: 1 }, { status: 413 }),
	);
	const local: string[] = [];
	const directIngest = vi.fn(() => {
		local.push("direct");
		if (failure === "direct-write") throw new Error("temporary local write failure");
		return { inserted: 1, skipped: 0 };
	});
	const boundaryFlush = vi.fn((payload: Record<string, unknown>, _db: string, receipt?: string) => {
		local.push("boundary");
		if (failure === "observer-init" || failure === "observer-cleanup") throw new Error(failure);
		if (failure === "saved-floor") {
			if (!receipt) throw new Error("expected boundary receipt");
			writeFileSync(join(dir, receipt), JSON.stringify({ ...payload, [floor]: 7 }));
			expect(Object.hasOwn(payload, floor)).toBe(false);
		}
		return false;
	});
	// Act.
	const result = await ingestPiHookPayload(pi("healthy"), opts, {
		resolveDb: db,
		directIngest,
		boundaryFlush,
	});
	// Assert: direct acceptance or HTTP 200 skips cannot authorize unfinished-boundary cleanup.
	expect(result.via).toBe("spool");
	expect(calls).toEqual(["head"]);
	expect(local).toEqual(failure === "direct-write" ? ["direct"] : ["direct", "boundary"]);
	expect(readdirSync(dir).filter((name) => name.endsWith(".retained"))).toEqual([]);
	expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
	if (failure === "saved-floor")
		expect(JSON.parse(readFileSync(join(dir, head), "utf8"))[floor]).toBe(7);
	else expect(readFileSync(join(dir, head), "utf8")).toBe(bytes);
});

it.each(["queued", "local"] as const)(
	"Pi completes the boundary through %s before healthy progress",
	async (mode) => {
		// Arrange.
		seed(pi("head", true));
		const calls = transport(() =>
			mode === "queued"
				? Response.json({ accepted: 1, queued: 1 }, { status: 202 })
				: Response.json({ error: "payload too large", max_bytes: 1 }, { status: 413 }),
		);
		const directIngest = vi.fn(() => ({ inserted: 1, skipped: 0 }));
		const boundaryFlush = vi.fn(() => true);
		// Act.
		const result = await ingestPiHookPayload(pi("healthy"), opts, {
			resolveDb: db,
			directIngest,
			boundaryFlush,
		});
		// Assert.
		expect(result.via).toBe("http");
		expect(calls).toEqual(["head", "healthy"]);
		expect(readdirSync(dir)).toEqual([]);
		expect(directIngest).toHaveBeenCalledTimes(mode === "local" ? 1 : 0);
		expect(boundaryFlush).toHaveBeenCalledTimes(mode === "local" ? 1 : 0);
	},
);

it("Pi preserves the next boundary when the invocation's local extraction allowance is spent", async () => {
	// Arrange.
	seed(pi("first", true));
	const bytes = seed(pi("second", true), second);
	const calls = transport(() =>
		Response.json({ error: "payload too large", max_bytes: 1 }, { status: 413 }),
	);
	const directIngest = vi.fn(() => ({ inserted: 1, skipped: 0 }));
	const boundaryFlush = vi.fn(() => true);
	// Act.
	const result = await ingestPiHookPayload(pi("healthy"), opts, {
		resolveDb: db,
		directIngest,
		boundaryFlush,
	});
	// Assert: a second terminal HTTP reply cannot remove work deferred by the per-invocation allowance.
	expect(result.via).toBe("spool");
	expect(calls).toEqual(["first", "second"]);
	expect(directIngest).toHaveBeenCalledTimes(1);
	expect(boundaryFlush).toHaveBeenCalledTimes(1);
	expect(readFileSync(join(dir, second), "utf8")).toBe(bytes);
	expect(readdirSync(dir).filter((name) => name.endsWith(".retained"))).toEqual([]);
});

it.each([7, null, undefined])(
	"Pi preserves a replay payload with its own cutoff property: %s",
	async (cutoff) => {
		// Arrange: undefined cannot occur in JSON. Decorate only the decoded fixture to test the runtime own-property rule.
		const bytes = seed({ ...pi("head"), [floor]: cutoff });
		if (cutoff === undefined) {
			const parse = JSON.parse;
			vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
				const parsed: unknown = parse(text, reviver);
				if (parsed && typeof parsed === "object" && "tag" in parsed && parsed.tag === "head")
					Object.defineProperty(parsed, floor, { value: undefined, enumerable: true });
				return parsed;
			});
		}
		const calls = transport(() => Response.json({ error: "invalid session id" }, { status: 400 }));
		const directIngest = vi.fn(() => ({ inserted: 1, skipped: 0 }));
		// Act.
		const result = await ingestPiHookPayload(pi("healthy"), opts, { resolveDb: db, directIngest });
		// Assert: own-property presence protects pending work regardless of the property's value.
		expect(result.via).toBe("spool");
		expect(calls).toEqual(["head"]);
		expect(directIngest).not.toHaveBeenCalled();
		expect(readFileSync(join(dir, head), "utf8")).toBe(bytes);
		expect(readdirSync(dir).filter((name) => name.endsWith(".retained"))).toEqual([]);
	},
);
