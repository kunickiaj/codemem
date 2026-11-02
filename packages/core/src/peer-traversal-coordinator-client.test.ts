import { afterEach, expect, it, vi } from "vitest";
import { requestTraversalSignalDecision } from "./peer-traversal-coordinator-client.js";
import {
	clientOptions,
	common,
	decision,
	phases,
	raw,
	signalPacket,
} from "./peer-traversal-coordinator-client-test-fixtures.js";
import { decodeTraversalSignalPacket } from "./peer-traversal-signal-codec.js";

afterEach(() => vi.restoreAllMocks());
const response = (value: unknown = decision()) => ({ status: 200, bodyBytes: raw(value) });
const prior = () => ({ decision: decision(), deadlineMs: 40000 });

it.each(phases)("posts owned raw %s bytes and normal v2 headers once", async (phase) => {
	// Arrange: every phase uses its own actor and reply digest.
	const options = clientOptions(phase);
	const decoded = decodeTraversalSignalPacket(options.packet);
	const send = vi.fn().mockResolvedValue(response(decision(phase)));
	// Act
	const lease = await requestTraversalSignalDecision(options, { send, now: () => 1000 });
	// Assert: no portable wrapper reaches the HTTP port.
	expect(send).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			method: "POST",
			bodyBytes: decoded.bodyBytes,
			timestamp: options.packet.timestamp,
			nonce: options.packet.nonce,
			signature: options.packet.signature,
			deviceHeader: options.localDeviceId,
			expectedPhase: phase,
			namespace: options.namespace,
			externalPathname: options.externalPathname,
			deadlineMs: 60000,
		}),
	);
	expect(lease).toEqual({ decision: decision(phase), deadlineMs: 56000 });
	expect(send.mock.calls[0]?.[0]).not.toHaveProperty("packet");
	expect(Object.isFrozen(lease)).toBe(true);
	expect(Object.isFrozen(lease?.decision)).toBe(true);
});

const wrongFields: Record<string, unknown> = {
	v: 2,
	ok: false,
	phase: "answer",
	sessionId: "0".repeat(32),
	packetDigest: "0".repeat(64),
	requestNonce: "0".repeat(32),
	decidedAtMs: -1,
	attemptNotAfter: 156,
	remainingMs: 54999,
	policyRevision: 0,
	readyObservedAtMs: -1,
};
it.each(Object.entries(wrongFields))("rejects mismatched decision field %s", async (key, value) => {
	// Arrange
	const send = vi.fn().mockResolvedValue(response({ ...decision(), [key]: value }));
	// Act
	const result = await requestTraversalSignalDecision(clientOptions(), { send, now: () => 1000 });
	// Assert
	expect(result).toBeNull();
	expect(send).toHaveBeenCalledTimes(1);
});

it.each(Object.keys(decision()))(
	"requires decision field %s with its exact primitive type",
	async (key) => {
		// Arrange
		const missing: Record<string, unknown> = { ...decision() };
		delete missing[key];
		const wrongType = { ...decision(), [key]: null };
		// Act
		const results = await Promise.all(
			[missing, wrongType].map((body) =>
				requestTraversalSignalDecision(clientOptions(), {
					send: async () => response(body),
					now: () => 1000,
				}),
			),
		);
		// Assert
		expect(results).toEqual([null, null]);
	},
);

it.each([null, [], { ...decision(), extra: true }, { decision: decision() }, "ok"])(
	"rejects non-decision response %j",
	async (body) => {
		// Arrange
		const send = vi.fn().mockResolvedValue(response(body));
		// Act
		const result = await requestTraversalSignalDecision(clientOptions(), { send, now: () => 1000 });
		// Assert
		expect(result).toBeNull();
	},
);

it.each([1024, 1025])("checks raw response cap at %i bytes", async (size) => {
	// Arrange: legal JSON whitespace counts toward the byte cap.
	const json = JSON.stringify(decision());
	const bodyBytes = new TextEncoder().encode(json.padEnd(size));
	// Act
	const result = await requestTraversalSignalDecision(clientOptions(), {
		send: async () => ({ status: 200, bodyBytes }),
		now: () => 1000,
	});
	// Assert
	expect(result !== null).toBe(size === 1024);
});

it.each([
	{ status: 403, bodyBytes: raw(decision()) },
	{ status: 201, bodyBytes: raw(decision()) },
	{ status: 200, bodyBytes: Uint8Array.of(0xff) },
	{ status: 200, bodyBytes: new TextEncoder().encode("not JSON") },
	{ status: 200, bodyBytes: raw(decision()).buffer },
])("rejects bad transport response %#", async (reply) => {
	// Arrange
	const send = vi.fn().mockResolvedValue(reply);
	// Act
	const result = await requestTraversalSignalDecision(clientOptions(), { send, now: () => 1000 });
	// Assert
	expect(result).toBeNull();
});

const badOptions = [
	{ packet: null },
	{ packet: { ...signalPacket(), approval: decision() } },
	{ expectedPhase: "answer" },
	{ localDeviceId: "target" },
	{ namespace: { authorityId: "0".repeat(64), groupId: common.groupId } },
	{ namespace: { authorityId: common.authorityId, groupId: "other" } },
	{ deadlineMs: 1000 },
	{ deadlineMs: 61001 },
	{ deadlineMs: Number.NaN },
	{ signal: {} },
];
it.each(badOptions)("rejects invalid request before send %#", async (patch) => {
	// Arrange
	const send = vi.fn().mockResolvedValue(response());
	const options = { ...clientOptions(), ...patch };
	// Act
	const result = await requestTraversalSignalDecision(
		options as Parameters<typeof requestTraversalSignalDecision>[0],
		{ send, now: () => 1000 },
	);
	// Assert
	expect(result).toBeNull();
	expect(send).not.toHaveBeenCalled();
});

it.each([
	"/",
	"//host/v1/traversal/signal",
	"/v1/traversal/signal?q",
	"/v1/traversal/signal#f",
	"/a\\/v1/traversal/signal",
	"/\u0001/v1/traversal/signal",
	"/\u0085/v1/traversal/signal",
	"/\ud800/v1/traversal/signal",
])("rejects external path %j before send", async (externalPathname) => {
	// Arrange
	const send = vi.fn();
	// Act
	const result = await requestTraversalSignalDecision(
		{ ...clientOptions(), externalPathname },
		{ send, now: () => 1000 },
	);
	// Assert
	expect(result).toBeNull();
	expect(send).not.toHaveBeenCalled();
});

it.each([
	[95000, 60000, 95000, true],
	[94999, 60001, 95000, false],
	[129999, 25001, 129999, true],
	[130000, 25000, 130000, false],
	[100000, 55000, 110000, true],
	[100000, 55000, 110001, false],
	[100000, 55000, 50001, true],
	[100000, 55000, 50000, false],
	[100000, 55000, Number.MAX_SAFE_INTEGER, false],
	[100000.5, 54999.5, 100000, false],
])(
	"enforces UTC/readiness boundary %#",
	async (decidedAtMs, remainingMs, readyObservedAtMs, accepted) => {
		// Arrange
		const body = { ...decision(), decidedAtMs, remainingMs, readyObservedAtMs };
		// Act
		const result = await requestTraversalSignalDecision(clientOptions(), {
			send: async () => response(body),
			now: () => 1000,
		});
		// Assert
		expect(result !== null).toBe(accepted);
	},
);

it.each([20000, 40000, 60000])(
	"clamps lease to caller and captured prior deadline %i",
	async (deadlineMs) => {
		// Arrange: RTT consumes lease time instead of extending the local deadline.
		let mono = 1000;
		const send = vi.fn(async () => {
			mono = 2000;
			return response();
		});
		// Act
		const result = await requestTraversalSignalDecision(
			{ ...clientOptions(), deadlineMs, previousLease: prior() },
			{ send, now: () => mono },
		);
		// Assert
		expect(result?.deadlineMs).toBe(Math.min(deadlineMs, 40000));
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ deadlineMs: Math.min(deadlineMs, 40000) }),
		);
	},
);

it.each([
	{ deadlineMs: 1000 },
	{ deadlineMs: Number.POSITIVE_INFINITY },
	{ decision: { ...decision(), sessionId: "0".repeat(32) } },
	{ decision: { ...decision(), attemptNotAfter: 156 } },
	{ decision: { ...decision(), policyRevision: 0 } },
])("rejects invalid previous lease before send %#", async (patch) => {
	// Arrange
	const send = vi.fn();
	// Act
	const result = await requestTraversalSignalDecision(
		{ ...clientOptions(), previousLease: { ...prior(), ...patch } },
		{ send, now: () => 1000 },
	);
	// Assert
	expect(result).toBeNull();
	expect(send).not.toHaveBeenCalled();
});

it("rejects a reply from a different policy revision", async () => {
	// Arrange
	const send = vi.fn().mockResolvedValue(response({ ...decision(), policyRevision: 2 }));
	// Act
	const result = await requestTraversalSignalDecision(
		{ ...clientOptions(), previousLease: prior() },
		{ send, now: () => 1000 },
	);
	// Assert
	expect(result).toBeNull();
});

it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, 999, 60000])(
	"rejects invalid or expired clock after hashing: %s",
	async (later) => {
		// Arrange
		const now = vi.fn().mockReturnValueOnce(1000).mockReturnValue(later);
		const send = vi.fn();
		// Act
		const result = await requestTraversalSignalDecision(clientOptions(), { send, now });
		// Assert
		expect(result).toBeNull();
		expect(send).not.toHaveBeenCalled();
	},
);

it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
	"rejects invalid initial clock %s",
	async (start) => {
		// Arrange
		const send = vi.fn();
		// Act
		const result = await requestTraversalSignalDecision(clientOptions(), {
			send,
			now: () => start,
		});
		// Assert
		expect(result).toBeNull();
		expect(send).not.toHaveBeenCalled();
	},
);

it.each(["before", "hash", "send"])("honors abort %s and never retries", async (stage) => {
	// Arrange
	const controller = new AbortController();
	if (stage === "before") controller.abort();
	const now = vi.fn(() => {
		if (stage === "hash" && now.mock.calls.length > 1) controller.abort();
		return 1000;
	});
	const send = vi.fn(async () => {
		controller.abort();
		return response();
	});
	// Act
	const result = await requestTraversalSignalDecision(
		{ ...clientOptions(), signal: controller.signal },
		{ send, now },
	);
	// Assert
	expect(result).toBeNull();
	expect(send).toHaveBeenCalledTimes(stage === "send" ? 1 : 0);
});

it("returns null for port failure without retry or error payload", async () => {
	// Arrange
	const send = vi.fn().mockRejectedValue(new Error("private transport detail"));
	// Act
	const result = await requestTraversalSignalDecision(clientOptions(), { send, now: () => 1000 });
	// Assert
	expect(result).toBeNull();
	expect(send).toHaveBeenCalledTimes(1);
});

it("owns packet, namespace, previous lease, clock, and bound send before hashing", async () => {
	// Arrange: mutation happens synchronously after the helper reaches its first await.
	const options = { ...clientOptions(), previousLease: prior() };
	const original = structuredClone(options);
	const deps = {
		marker: "original",
		now: () => 1000,
		async send(
			this: { marker: string },
			request: { bodyBytes: Uint8Array; namespace: unknown; deadlineMs: number },
		) {
			expect(this.marker).toBe("original");
			expect(request.bodyBytes).toEqual(decodeTraversalSignalPacket(original.packet).bodyBytes);
			expect(request.namespace).toEqual(original.namespace);
			expect(request.deadlineMs).toBe(40000);
			return response();
		},
	};
	// Act
	const pending = requestTraversalSignalDecision(options, deps);
	options.packet.body = "invalid";
	options.namespace.groupId = "other";
	options.expectedPhase = "answer";
	options.localDeviceId = "other";
	options.externalPathname = "/other";
	options.deadlineMs = 999;
	options.previousLease.deadlineMs = 999;
	options.previousLease.decision = { ...decision(), policyRevision: 2 };
	deps.now = () => Number.NaN;
	deps.send = async () => {
		throw new Error("replaced port");
	};
	const result = await pending;
	// Assert
	expect(result).toEqual({ decision: decision(), deadlineMs: 40000 });
});

it.each([999, 56000, 60000, Number.NaN])(
	"rejects bad or expired completion clock %s",
	async (finish) => {
		// Arrange
		let mono = 1000;
		const send = vi.fn(async () => {
			mono = finish;
			return response();
		});
		// Act
		const result = await requestTraversalSignalDecision(clientOptions(), { send, now: () => mono });
		// Assert
		expect(result).toBeNull();
	},
);

it("checks expiry after JSON parsing", async () => {
	// Arrange
	let mono = 1000;
	const parse = JSON.parse;
	const send = vi.fn(async () => {
		vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
			const parsed: unknown = parse(text);
			mono = 60000;
			return parsed;
		});
		return response();
	});
	// Act
	const result = await requestTraversalSignalDecision(clientOptions(), { send, now: () => mono });
	// Assert
	expect(result).toBeNull();
});

it("owns the previous lease while send is pending and preserves the original signal", async () => {
	// Arrange
	const controller = new AbortController();
	const options = { ...clientOptions(), previousLease: prior(), signal: controller.signal };
	const send = vi.fn(async (request: { signal?: AbortSignal }) => {
		expect(request.signal).toBe(controller.signal);
		options.previousLease.deadlineMs = 999999;
		options.previousLease.decision = { ...decision(), policyRevision: 2 };
		options.packet.nonce = "0".repeat(32);
		await Promise.resolve();
		return response();
	});
	// Act
	const result = await requestTraversalSignalDecision(options, { send, now: () => 1000 });
	// Assert
	expect(result).toEqual({ decision: decision(), deadlineMs: 40000 });
});

it("returns null when hashing fails without sending", async () => {
	// Arrange
	vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("digest unavailable"));
	const send = vi.fn();
	// Act
	const result = await requestTraversalSignalDecision(clientOptions(), { send, now: () => 1000 });
	// Assert
	expect(result).toBeNull();
	expect(send).not.toHaveBeenCalled();
});

it("returns null when the monotonic clock throws", async () => {
	// Arrange
	const send = vi.fn();
	const now = () => {
		throw new Error("clock unavailable");
	};
	// Act
	const result = await requestTraversalSignalDecision(clientOptions(), { send, now });
	// Assert
	expect(result).toBeNull();
	expect(send).not.toHaveBeenCalled();
});
