import { describe, expect, it, vi } from "vitest";
import { createPromptTransportDiagnostics } from "../.opencode/lib/prompt-transport-diagnostics.js";
import { __testUtils } from "../.opencode/lib/runtime.js";

const reasons = [
	"success",
	"disabled",
	"backoff",
	"profile_malformed",
	"protocol_mismatch",
	"database_mismatch",
	"identity_mismatch",
	"contract_unsupported",
	"request_rejected",
	"authorization_failure",
	"policy_failure",
	"endpoint_unavailable",
	"server_failure",
	"unexpected_status",
	"malformed_response",
	"timeout",
	"connection_failure",
	"unknown",
];
const failure = { operation: "pack", reason: "disabled", stage: "skipped", runner: "node" };
const parseEntry = (logLine, index = 0) =>
	JSON.parse(logLine.mock.calls[index][0].slice("inject.transport ".length));
const settleLogger = async () => {
	// Drain the logger's catch/finally chain without advancing time.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};

it("keeps fixed counter categories, counts successes silently, and ignores unknown operations", () => {
	// Arrange
	const logLine = vi.fn();
	const diagnostics = createPromptTransportDiagnostics({ logLine, now: () => 0 });
	// Act
	for (const reason of reasons) diagnostics.record({ ...failure, reason });
	diagnostics.record({ operation: "prompt-pack-ledger", reason: "success" });
	diagnostics.record({ operation: "private-operation", reason: "success" });
	const snapshot = diagnostics.snapshot();
	// Assert
	expect(Object.keys(snapshot.counters)).toEqual(["pack", "prompt-pack-ledger"]);
	expect(snapshot.counters.pack).toEqual(Object.fromEntries(reasons.map((reason) => [reason, 1])));
	expect(Object.keys(snapshot.counters["prompt-pack-ledger"])).toEqual(reasons);
	expect(snapshot.counters["prompt-pack-ledger"].success).toBe(1);
	expect(logLine).toHaveBeenCalledTimes(1);
	expect(parseEntry(logLine).reason).toBe("disabled");
});

it("discards sensitive values in every field, including unknown categories and arbitrary causes", () => {
	// Arrange — synthetic sentinels must never cross the diagnostic boundary.
	const sentinels = [
		"query-sentinel",
		"https://example.invalid/url-sentinel",
		"/private/db-sentinel.sqlite",
		"actor-sentinel",
		"Bearer token-sentinel",
		"cause-sentinel",
	];
	const logLine = vi.fn();
	const diagnostics = createPromptTransportDiagnostics({ logLine, now: () => 0 });
	// Act
	diagnostics.record({
		operation: "pack",
		reason: sentinels[0],
		stage: sentinels[1],
		runner: sentinels[2],
		disposition: sentinels[3],
		status_class: sentinels[4],
		elapsed_ms: sentinels[5],
		query: sentinels[0],
		url: sentinels[1],
		db_path: sentinels[2],
		actor_id: sentinels[3],
		headers: { authorization: sentinels[4] },
		cause: new Error(sentinels[5]),
	});
	diagnostics.record({ ...failure, cause: sentinels.join(" ") });
	const entry = parseEntry(logLine);
	// Assert
	expect(Object.keys(entry).sort()).toEqual(
		[
			"operation",
			"reason",
			"stage",
			"runner",
			"disposition",
			"status_class",
			"elapsed_ms",
			"counters",
			"suppressed",
		].sort(),
	);
	expect(entry).toMatchObject({
		reason: "unknown",
		stage: "skipped",
		runner: "custom",
		disposition: "unknown",
		status_class: "none",
		elapsed_ms: 0,
	});
	for (const sentinel of sentinels) {
		expect(JSON.stringify([entry, diagnostics.snapshot()])).not.toContain(sentinel);
	}
});

it.each([
	[12.6, 13],
	[-1, 0],
	[Number.NaN, 0],
	[Infinity, 0],
	[86_400_001, 86_400_000],
])("bounds elapsed time %s to %s", (elapsed_ms, expected) => {
	// Arrange
	const logLine = vi.fn();
	const diagnostics = createPromptTransportDiagnostics({ logLine });
	// Act
	diagnostics.record({
		...failure,
		elapsed_ms,
		disposition: "local_fallback",
		status_class: "4xx",
	});
	// Assert
	expect(parseEntry(logLine)).toMatchObject({
		elapsed_ms: expected,
		disposition: "local_fallback",
		status_class: "4xx",
	});
});

it("isolates returned snapshots and emitted counters from later records and caller mutation", async () => {
	// Arrange
	const logLine = vi.fn();
	const diagnostics = createPromptTransportDiagnostics({ logLine, now: () => 0 });
	diagnostics.record(failure);
	const before = diagnostics.snapshot();
	await settleLogger();
	// Act
	before.counters.pack.disabled = 500;
	before.counters.extra = {};
	before.suppressed = 500;
	diagnostics.record(failure);
	// Assert
	expect(diagnostics.snapshot().counters.pack.disabled).toBe(2);
	expect(diagnostics.snapshot().counters).not.toHaveProperty("extra");
	expect(diagnostics.snapshot().suppressed).toBe(1);
	expect(parseEntry(logLine).counters.pack.disabled).toBe(1);
});

it("saturates reason and suppression counters at one million without growing categories", () => {
	// Arrange
	const logLine = vi.fn(() => new Promise(() => {}));
	const diagnostics = createPromptTransportDiagnostics({ logLine, now: () => 0 });
	// Act
	for (let index = 0; index < 1_000_005; index++) diagnostics.record(failure);
	const snapshot = diagnostics.snapshot();
	// Assert
	expect(snapshot.counters.pack.disabled).toBe(1_000_000);
	expect(snapshot.suppressed).toBe(1_000_000);
	expect(Object.keys(snapshot.counters.pack)).toEqual(reasons);
	expect(logLine).toHaveBeenCalledTimes(1);
});

it("suppresses across operations until exactly 30 seconds and reports then resets the suppressed count", async () => {
	// Arrange
	let clock = 0;
	const logLine = vi.fn();
	const diagnostics = createPromptTransportDiagnostics({ logLine, now: () => clock });
	diagnostics.record(failure);
	await settleLogger();
	// Act
	clock = 29_999;
	diagnostics.record({ ...failure, operation: "prompt-pack-ledger" });
	const callsBeforeBoundary = logLine.mock.calls.length;
	clock = 30_000;
	diagnostics.record(failure);
	// Assert
	expect(callsBeforeBoundary).toBe(1);
	expect(logLine).toHaveBeenCalledTimes(2);
	expect(parseEntry(logLine, 1)).toMatchObject({
		suppressed: 1,
		counters: { pack: { disabled: 2 }, "prompt-pack-ledger": { disabled: 1 } },
	});
	expect(diagnostics.snapshot().suppressed).toBe(0);
});

it("allows only one stalled write and never queues or replays suppressed writes", async () => {
	// Arrange
	let clock = 0;
	const pending = Promise.withResolvers();
	const logLine = vi.fn().mockReturnValueOnce(pending.promise);
	const diagnostics = createPromptTransportDiagnostics({ logLine, now: () => clock });
	diagnostics.record(failure);
	// Act
	clock = 90_000;
	for (let index = 0; index < 100; index++) diagnostics.record(failure);
	const stalledCalls = logLine.mock.calls.length;
	pending.resolve();
	await settleLogger();
	const releasedCalls = logLine.mock.calls.length;
	diagnostics.record(failure);
	// Assert
	expect(stalledCalls).toBe(1);
	expect(releasedCalls).toBe(1);
	expect(logLine).toHaveBeenCalledTimes(2);
	expect(parseEntry(logLine, 1).suppressed).toBe(100);
});

it("uses the default monotonic clock despite forward and backward wall-clock jumps", async () => {
	// Arrange
	let monotonic = 100;
	let wallClock = 10_000;
	const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
	const dateNow = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
	const logLine = vi.fn();
	const diagnostics = createPromptTransportDiagnostics({ logLine });
	try {
		// Act
		diagnostics.record(failure);
		await settleLogger();
		monotonic = 30_099;
		wallClock = 1_000_000;
		diagnostics.record(failure);
		const beforeBoundary = logLine.mock.calls.length;
		await settleLogger();
		monotonic = 30_100;
		wallClock = -1_000_000;
		diagnostics.record(failure);
		// Assert
		expect(beforeBoundary).toBe(1);
		expect(logLine).toHaveBeenCalledTimes(2);
		expect(parseEntry(logLine, 1).suppressed).toBe(1);
	} finally {
		performanceNow.mockRestore();
		dateNow.mockRestore();
	}
});

it.each(["reject", "throw"])(
	"recovers after a logger %s without throwing or replaying writes",
	async (mode) => {
		// Arrange
		let clock = 0;
		const logLine = vi.fn().mockImplementationOnce(() => {
			if (mode === "throw") throw new Error("logger failure");
			return Promise.reject(new Error("logger failure"));
		});
		const diagnostics = createPromptTransportDiagnostics({ logLine, now: () => clock });
		// Act
		diagnostics.record(failure);
		await settleLogger();
		diagnostics.record(failure);
		clock = 30_000;
		diagnostics.record(failure);
		// Assert
		expect(logLine).toHaveBeenCalledTimes(2);
		expect(parseEntry(logLine, 1).suppressed).toBe(1);
	},
);
describe("transport result diagnostics preserve decisions", () => {
	it.each([
		[true, false, "fallback", "node", "viewer"],
		[false, false, "fallback", "node", "node"],
		[false, false, "local_fallback", "/custom/runner", "custom"],
		[false, false, "terminal", "node", "none"],
		[false, true, "fallback", "node", "none"],
	])(
		"records runner for ok=%s viewerOnly=%s disposition=%s",
		(ok, viewerOnly, disposition, runner, expected) => {
			// Arrange
			const logLine = vi.fn();
			const diagnostics = createPromptTransportDiagnostics({ logLine });
			const record = vi.spyOn(diagnostics, "record");
			const result = {
				ok,
				classification: {
					disposition,
					retryable: disposition !== "terminal",
					cause: "private cause",
				},
			};
			const finish = __testUtils.createPromptTransportResult({
				operation: "pack",
				runner,
				diagnostics,
				viewerOnly,
				timing: { stage: "request", startedAt: performance.now() },
			});
			// Act — a success is silent; a later failure exposes its accumulated counter.
			const returned = finish(result, ok ? "success" : "connection_failure", 503);
			if (ok) diagnostics.record(failure);
			// Assert
			expect(returned).toBe(result);
			if (ok) {
				expect(diagnostics.snapshot().counters.pack.success).toBe(1);
				expect(record.mock.calls[0][0].runner).toBe("viewer");
			} else
				expect(parseEntry(logLine)).toMatchObject({
					runner: expected,
					disposition,
					status_class: "5xx",
					stage: "request",
				});
			expect(JSON.stringify(diagnostics.snapshot())).not.toContain("private cause");
		},
	);
});
