import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPromptPackTiming } from "../.opencode/lib/prompt-pack-timings.js";

const id = "12345678-1234-4234-8234-123456789abc";
const stages = [
	"profile",
	"request_headers",
	"response_body",
	"fallback_total",
	"cli_resolve",
	"cli_execute",
];
let clock;
let lines;
const create = (options = {}) =>
	createPromptPackTiming({
		enabled: true,
		now: () => clock,
		newId: () => id,
		logLine: (line) => lines.push(line),
		...options,
	});
const row = (index = 0) => {
	expect(lines[index].startsWith("prompt.pack.timing ")).toBe(true);
	return JSON.parse(lines[index].slice("prompt.pack.timing ".length));
};

beforeEach(() => {
	vi.useFakeTimers();
	clock = 0;
	lines = [];
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("emits the exact client schema with independent overlapping stages", () => {
	// Arrange: fallback intentionally includes both resolution and execution.
	const timing = create({ newId: () => id.toUpperCase() });
	const endProfile = timing.start("profile");
	clock = 1.23456;
	endProfile();
	endProfile();
	const endFallback = timing.start("fallback_total");
	timing.transition("cli_resolve");
	clock = 3.23456;
	timing.transition("cli_execute");
	clock = 7.23456;
	timing.transition(null);
	endFallback();
	timing.setHttpReason("connection_failure");
	timing.setExecution("cached_node");
	// Act
	timing.finish({ outcome: "completed", transport: "cli" });
	timing.start("profile")();
	timing.transition("response_body");
	timing.setExecution("custom");
	timing.finish({ outcome: "failed", transport: "none" });
	// Assert: fixed keys exclude caller context and duplicate completion.
	expect(lines).toHaveLength(1);
	expect(row()).toEqual({
		schema_version: 1,
		side: "client",
		operation: "pack",
		request_id: id,
		outcome: "completed",
		transport: "cli",
		http_reason: "connection_failure",
		execution: "cached_node",
		elapsed_ms: 7.235,
		event_loop_lag_ms: 0,
		timings_ms: {
			profile: 1.235,
			request_headers: 0,
			response_body: 0,
			fallback_total: 6,
			cli_resolve: 2,
			cli_execute: 4,
		},
		incomplete_stages: [],
	});
	expect(vi.getTimerCount()).toBe(0);
});

test.each([false, undefined])(
	"disabled helper has no clock, nonce, logging, or timers (%s)",
	(enabled) => {
		// Arrange
		const now = vi.fn();
		const newId = vi.fn();
		const logLine = vi.fn();
		// Act
		const result = create({ enabled, now, newId, logLine });
		// Assert
		expect(result).toBeUndefined();
		expect(now).not.toHaveBeenCalled();
		expect(newId).not.toHaveBeenCalled();
		expect(logLine).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	},
);

test.each([
	"session-private",
	"12345678-1234-1234-8234-123456789abc",
	"12345678-1234-4234-1234-123456789abc",
	"",
	null,
])("invalid UUID disables tracing (%s)", (nonce) => {
	// Arrange
	const logLine = vi.fn();
	// Act
	const timing = create({ newId: () => nonce, logLine });
	// Assert
	expect(timing).toBeUndefined();
	expect(logLine).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

test("contains failures from both nonce generation and initial clock", () => {
	// Arrange
	const fail = () => {
		throw new Error("private-error /private/path actor session query");
	};
	// Act
	const nonceFailure = create({ newId: fail });
	const clockFailure = create({ now: fail });
	// Assert
	expect(nonceFailure).toBeUndefined();
	clockFailure?.finish({ outcome: "failed", transport: "none" });
	if (clockFailure) expect(row()).toMatchObject({ elapsed_ms: 0, event_loop_lag_ms: 0 });
	expect(vi.getTimerCount()).toBe(0);
});

test("suppresses private labels and unknown fields", () => {
	// Arrange
	const secret = "private-error /private/path actor=session query=token https://private.invalid";
	const timing = create();
	// Act
	timing.start(secret)();
	timing.transition(secret);
	timing.setHttpReason(secret);
	timing.setExecution(secret);
	timing.finish({
		outcome: secret,
		transport: secret,
		error: secret,
		context: secret,
		request_id: secret,
	});
	// Assert
	for (const canary of secret.split(" ")) expect(lines.join()).not.toContain(canary);
	expect(row()).toMatchObject({
		outcome: "failed",
		transport: "none",
		execution: "none",
		http_reason: "unknown",
	});
	expect(Object.keys(row().timings_ms)).toEqual(stages);
	expect(row().incomplete_stages).toEqual([]);
	expect(Object.keys(row())).toHaveLength(12);
});

test.each([-10, Infinity, NaN, 100_000_000])(
	"bounds every duration after an abnormal clock value (%s)",
	(value) => {
		// Arrange
		const timing = create();
		timing.start("response_body");
		// Act
		clock = value;
		timing.finish({ outcome: "failed", transport: "viewer" });
		// Assert
		const result = row();
		const expected = value === 100_000_000 ? 86_400_000 : 0;
		expect(result.elapsed_ms).toBe(expected);
		expect(result.timings_ms.response_body).toBe(expected);
		for (const duration of [
			result.elapsed_ms,
			result.event_loop_lag_ms,
			...Object.values(result.timings_ms),
		]) {
			expect(Number.isFinite(duration)).toBe(true);
			expect(duration).toBeGreaterThanOrEqual(0);
			expect(duration).toBeLessThanOrEqual(86_400_000);
		}
		expect(result.incomplete_stages).toEqual(["response_body"]);
		expect(vi.getTimerCount()).toBe(0);
	},
);

test.each(["throw", "reject"])(
	"logger %s cannot change completion or leave timers",
	async (mode) => {
		// Arrange
		const logLine = vi.fn(() => {
			if (mode === "throw") throw new Error("private logger failure");
			return Promise.reject(new Error("private logger failure"));
		});
		const timing = create({ logLine });
		// Act
		expect(() => timing.finish({ outcome: "terminal", transport: "none" })).not.toThrow();
		await Promise.resolve();
		timing.finish({ outcome: "failed", transport: "none" });
		// Assert
		expect(logLine).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	},
);

test("isolates concurrent nonces, stages, and the 25ms lag watch", () => {
	// Arrange
	const newId = vi
		.fn()
		.mockReturnValueOnce(id)
		.mockReturnValueOnce("abcdefab-cdef-4abc-9abc-abcdefabcdef");
	const first = create({ newId });
	const second = create({ newId });
	first.start("profile");
	second.start("response_body");
	// Act: one delayed watch tick observes 50ms of lag.
	clock = 75;
	vi.advanceTimersByTime(25);
	first.finish({ outcome: "completed", transport: "viewer" });
	clock = 80;
	second.finish({ outcome: "failed", transport: "none" });
	// Assert
	expect(newId).toHaveBeenCalledTimes(2);
	expect(row().request_id).not.toBe(row(1).request_id);
	expect(row()).toMatchObject({
		event_loop_lag_ms: 50,
		incomplete_stages: ["profile"],
		timings_ms: { profile: 75, response_body: 0 },
	});
	expect(row(1)).toMatchObject({
		incomplete_stages: ["response_body"],
		timings_ms: { profile: 0, response_body: 80 },
	});
	expect(vi.getTimerCount()).toBe(0);
});
