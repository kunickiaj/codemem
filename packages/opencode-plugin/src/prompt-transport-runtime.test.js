import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ appendFile: vi.fn(), mkdir: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal()),
	appendFile: io.appendFile,
	mkdir: io.mkdir,
}));
vi.mock("node:child_process", () => ({
	spawn: io.spawn,
	execSync: vi.fn(() => {
		throw new Error("No real commands in transport tests");
	}),
}));

import { __testUtils, createCodememRuntime } from "../.opencode/lib/runtime.js";

const dbPath = "/fixture/db-sentinel.sqlite";
const actorID = "actor-sentinel";
const query = "query-sentinel";
const pack = { pack_text: "", metrics: { total_items: 0 } };
const runners = [];
let clock;
let signals;

function response(body, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) };
}

function compatibleProfile() {
	return {
		service: "codemem-viewer",
		protocol_version: 1,
		db_path: dbPath,
		identity_target: __testUtils.buildViewerIdentityTarget(process.env, "/fixture"),
	};
}

function entries() {
	return io.appendFile.mock.calls
		.map(([, line]) => {
			const marker = line.indexOf("inject.transport ");
			return marker < 0 ? null : JSON.parse(line.slice(marker + "inject.transport ".length));
		})
		.filter(Boolean);
}

async function drain() {
	// Runtime ledger writes are deliberately fire-and-forget; drain mocked I/O only.
	for (let index = 0; index < 30; index++) await Promise.resolve();
}

async function fixture({ viewer = "1", runner = "node" } = {}) {
	vi.stubEnv("CODEMEM_VIEWER", viewer);
	vi.stubEnv("CODEMEM_RUNNER", runner);
	const runtime = await createCodememRuntime({
		location: { directory: "/fixture", worktree: "/fixture", project: { name: "fixture" } },
		host: { log: vi.fn(), notify: null },
	});
	runners.push(runtime);
	return runtime;
}

async function transform(runtime, sessionID = "session-sentinel") {
	const output = {};
	await runtime.transformSystem({ sessionID }, output);
	await drain();
	return output;
}

async function transformMessage(runtime) {
	const output = {
		messages: [
			{
				info: { id: "message-sentinel", role: "user", sessionID: "session-sentinel" },
				parts: [{ type: "text", text: query }],
			},
		],
	};
	await runtime.transformMessages({ sessionID: "session-sentinel" }, output);
	await drain();
	return output;
}

function commands(name) {
	return io.spawn.mock.calls.filter(([, args]) => args.includes(name));
}

beforeEach(() => {
	clock = 0;
	signals = [];
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	vi.spyOn(performance, "now").mockImplementation(() => clock + 100);
	vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
		const controller = new AbortController();
		signals.push(controller);
		return controller.signal;
	});
	for (const [key, value] of Object.entries({
		HOME: "/fixture",
		CODEMEM_DB: dbPath,
		CODEMEM_ACTOR_ID: actorID,
		CODEMEM_PLUGIN_IGNORE: "0",
		CODEMEM_PLUGIN_DEBUG: "0",
		CODEMEM_PLUGIN_LOG: "0",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_RAW_EVENTS: "0",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_INJECT_CONTEXT: "1",
		CODEMEM_INJECT_SURFACE: "system",
		CODEMEM_INJECT_TOKEN_BUDGET: "800",
		CODEMEM_RUNNER_FROM: "/fixture/cli.js",
		CODEMEM_PROJECT: "",
		CODEMEM_PLUGIN_CMD_TIMEOUT: "0",
	}))
		vi.stubEnv(key, value);
	io.appendFile.mockReset().mockResolvedValue();
	io.mkdir.mockReset().mockResolvedValue();
	io.spawn.mockReset().mockImplementation(() => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = new EventEmitter();
		child.stdin.write = vi.fn();
		child.stdin.end = () =>
			queueMicrotask(() => {
				child.stdout.emit("data", JSON.stringify(pack));
				child.emit("exit", 0);
			});
		child.kill = vi.fn();
		return child;
	});
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unconfigured mocked fetch")));
});

afterEach(async () => {
	for (const runtime of runners.splice(0)) await runtime.dispose();
	await drain();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("counts successful viewer packs silently and does not invoke CLI fallback", async () => {
	// Arrange
	const runtime = await fixture();
	fetch.mockResolvedValueOnce(response(compatibleProfile())).mockResolvedValueOnce(response(pack));
	// Act
	await transform(runtime);
	const successLogs = entries();
	fetch.mockRejectedValueOnce(new Error("connection failure"));
	clock = 30_000;
	await transform(runtime);
	// Assert
	expect(successLogs).toEqual([]);
	expect(entries()[0]).toMatchObject({
		reason: "connection_failure",
		counters: { pack: { success: 1, connection_failure: 1 } },
	});
	expect(commands("pack")).toHaveLength(1);
	expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST", redirect: "manual" });
});

it("records disabled transport without network I/O and preserves the custom fallback command", async () => {
	// Arrange
	const runtime = await fixture({ viewer: "0", runner: "/fixture/custom-runner" });
	// Act
	await transform(runtime);
	// Assert
	expect(fetch).not.toHaveBeenCalled();
	expect(entries()[0]).toMatchObject({
		operation: "pack",
		reason: "disabled",
		stage: "skipped",
		runner: "custom",
		disposition: "fallback",
		status_class: "none",
		elapsed_ms: 0,
	});
	expect(commands("pack")[0].slice(0, 2)).toEqual([
		"/fixture/custom-runner",
		["/fixture/cli.js", "pack", "fixture", "--json", "--internal-ledger", "--token-budget", "795"],
	]);
	expect(commands("pack")).toHaveLength(1);
});

it("records backoff separately, skips network during backoff, and retries after expiry", async () => {
	// Arrange
	const runtime = await fixture();
	fetch.mockResolvedValue(response({}, 503));
	// Act
	await transform(runtime);
	const initialFetches = fetch.mock.calls.length;
	await transform(runtime);
	const backoffFetches = fetch.mock.calls.length;
	clock = 1_000_000;
	await transform(runtime);
	// Assert
	expect(initialFetches).toBe(1);
	expect(backoffFetches).toBe(1);
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(commands("pack")).toHaveLength(3);
	expect(entries()[1]).toMatchObject({
		counters: { pack: { backoff: 1, server_failure: 2 } },
		suppressed: 1,
	});
});

it.each([
	["malformed service", { service: "other" }, "profile_malformed", "fallback"],
	["malformed protocol", { protocol_version: "1" }, "profile_malformed", "fallback"],
	["protocol mismatch", { protocol_version: 2 }, "protocol_mismatch", "fallback"],
	[
		"database mismatch",
		{ db_path: "/fixture/other.sqlite" },
		"database_mismatch",
		"local_fallback",
	],
	[
		"identity mismatch",
		{ identity_target: { actor_id: "different-actor" } },
		"identity_mismatch",
		"local_fallback",
	],
])(
	"records %s before POST without changing local fallback",
	async (_label, override, reason, disposition) => {
		// Arrange
		const runtime = await fixture();
		fetch.mockResolvedValueOnce(response({ ...compatibleProfile(), ...override }));
		// Act
		await transform(runtime);
		// Assert
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][1].method).toBe("GET");
		expect(entries()[0]).toMatchObject({
			reason,
			disposition,
			stage: "profile",
			status_class: "2xx",
			runner: "node",
		});
		expect(commands("pack")).toHaveLength(1);
	},
);

it.each([
	[200, { ok: true }, null, false],
	[200, { ok: false }, "malformed_response", true],
	[503, {}, "server_failure", true],
	[
		401,
		{ ok: false, errorCode: "retrieval_ledger_write_failed", reason: "private-ledger-reason" },
		"request_rejected",
		false,
	],
	[
		403,
		{ ok: false, errorCode: "retrieval_ledger_write_failed", reason: "private-ledger-reason" },
		"request_rejected",
		false,
	],
	[
		409,
		{ ok: false, errorCode: "retrieval_ledger_write_failed", reason: "private-ledger-reason" },
		"request_rejected",
		false,
	],
])(
	"records ledger status %s without changing delivery or CLI fallback",
	async (status, body, reason, fallback) => {
		// Arrange
		const runtime = await fixture();
		fetch.mockImplementation(async (_url, init) => {
			if (init.method === "GET") return response(compatibleProfile());
			if (JSON.parse(init.body).action) return response(body, status);
			return response({ pack_text: "retrieved context", metrics: { total_items: 1 } });
		});
		// Act
		const output = await transform(runtime);
		// Assert
		expect(output.system).toEqual(["[codemem context]\nretrieved context"]);
		expect(commands("pack")).toHaveLength(0);
		expect(commands("prompt-pack-ledger")).toHaveLength(fallback ? 1 : 0);
		if (reason)
			expect(entries()[0]).toMatchObject({
				operation: "prompt-pack-ledger",
				reason,
				stage: "request",
				runner: fallback ? "node" : "none",
				counters: { pack: { success: 1 } },
			});
		else expect(entries()).toEqual([]);
		expect(JSON.stringify(entries())).not.toContain("private-ledger-reason");
	},
);

it("treats a ledger-shaped 409 profile response as unexpected and keeps CLI fallback retryable", async () => {
	// Arrange
	const runtime = await fixture();
	let profileRequests = 0;
	fetch.mockImplementation(async (_url, init) => {
		if (init.method === "GET") {
			profileRequests++;
			if (profileRequests === 1) return response(compatibleProfile());
			return response(
				{ ok: false, errorCode: "retrieval_ledger_write_failed", reason: "private-profile-reason" },
				409,
			);
		}
		return response({ pack_text: "retrieved context", metrics: { total_items: 1 } });
	});
	// Act
	const output = await transform(runtime);
	// Assert
	expect(output.system).toEqual(["[codemem context]\nretrieved context"]);
	expect(entries()[0]).toMatchObject({
		operation: "prompt-pack-ledger",
		reason: "unexpected_status",
		stage: "profile",
		disposition: "fallback",
		runner: "node",
		status_class: "4xx",
	});
	expect(commands("prompt-pack-ledger")).toHaveLength(1);
	expect(commands("pack")).toHaveLength(0);
	expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
	expect(JSON.stringify(entries())).not.toContain("private-profile-reason");
});

it("keeps the contract-repair ledger request viewer-only and records none instead of spawning a runner", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_INJECT_SURFACE", "message");
	const runtime = await fixture();
	const repairLogged = Promise.withResolvers();
	io.appendFile.mockImplementation(async (_path, line) => {
		if (line.includes('"reason":"connection_failure"')) repairLogged.resolve();
	});
	let ledgerPosts = 0;
	fetch.mockImplementation(async (_url, init) => {
		if (init.method === "GET") return response(compatibleProfile());
		const body = JSON.parse(init.body);
		if (!body.action)
			return response({ pack_text: "retrieved context", metrics: { total_items: 1 } });
		ledgerPosts++;
		if (ledgerPosts === 1) return response({ error: { code: "viewer_contract_unsupported" } }, 409);
		await drain();
		clock = 30_000;
		throw new Error("cause-sentinel");
	});
	// Act
	const output = await transformMessage(runtime);
	await repairLogged.promise;
	// Assert
	expect(output.messages[0].parts.at(-1).text).toContain("retrieved context");
	expect(ledgerPosts).toBe(2);
	expect(io.spawn).not.toHaveBeenCalled();
	const packRequest = JSON.parse(
		fetch.mock.calls.find(([, init]) => init.method === "POST")[1].body,
	);
	expect(packRequest).toMatchObject({
		context: expect.stringContaining(query),
		db_path: dbPath,
		identity_target: { actor_id: actorID },
	});
	expect(entries()).toEqual([
		expect.objectContaining({
			operation: "prompt-pack-ledger",
			reason: "contract_unsupported",
			runner: "none",
			disposition: "terminal",
		}),
		expect.objectContaining({
			operation: "prompt-pack-ledger",
			reason: "connection_failure",
			runner: "none",
			disposition: "fallback",
		}),
	]);
	for (const sentinel of [
		query,
		dbPath,
		actorID,
		"cause-sentinel",
		"session-sentinel",
		"message-sentinel",
	])
		expect(JSON.stringify(entries())).not.toContain(sentinel);
});

it.each(["profile", "request"])(
	"reports an owned deadline at the %s stage, not from error text",
	async (stage) => {
		// Arrange
		const runtime = await fixture();
		if (stage === "request") fetch.mockResolvedValueOnce(response(compatibleProfile()));
		fetch.mockImplementationOnce(async () => {
			signals.at(-1).abort(new DOMException("private deadline detail", "TimeoutError"));
			throw new Error("unrelated error message");
		});
		// Act
		await transform(runtime);
		// Assert
		expect(entries()[0]).toMatchObject({
			reason: "timeout",
			stage,
			status_class: "none",
			runner: "node",
		});
		expect(commands("pack")).toHaveLength(1);
		expect(signals).toHaveLength(stage === "profile" ? 1 : 2);
	},
);

it("does not infer an owned timeout from arbitrary exception names, codes, or causes", async () => {
	// Arrange
	const runtime = await fixture();
	const error = Object.assign(
		new Error(`TimeoutError ${query} https://example.invalid/url-sentinel Bearer token-sentinel`),
		{ code: "ETIMEDOUT", cause: { code: "cause-sentinel", db_path: dbPath, actor_id: actorID } },
	);
	fetch.mockRejectedValueOnce(error);
	// Act
	await transform(runtime);
	// Assert
	expect(entries()[0]).toMatchObject({ reason: "connection_failure", stage: "profile" });
	for (const sentinel of [
		query,
		"url-sentinel",
		"token-sentinel",
		"cause-sentinel",
		dbPath,
		actorID,
	])
		expect(JSON.stringify(entries())).not.toContain(sentinel);
	expect(commands("pack")).toHaveLength(1);
});

it.each([
	[401, {}, "authorization_failure", "terminal"],
	[403, {}, "authorization_failure", "terminal"],
	[
		401,
		{ ok: false, errorCode: "retrieval_ledger_write_failed", reason: "private-ledger-reason" },
		"authorization_failure",
		"terminal",
	],
	[
		403,
		{ ok: false, errorCode: "retrieval_ledger_write_failed", reason: "private-ledger-reason" },
		"authorization_failure",
		"terminal",
	],
	[
		409,
		{ ok: false, errorCode: "retrieval_ledger_write_failed", reason: "private-ledger-reason" },
		"unexpected_status",
		"fallback",
	],
	[409, { error: { code: "policy_denied" } }, "policy_failure", "terminal"],
	[400, { error: { code: "invalid_request" } }, "request_rejected", "terminal"],
	[409, { error: { code: "viewer_contract_unsupported" } }, "contract_unsupported", "terminal"],
	[409, { error: { code: "viewer_db_mismatch" } }, "database_mismatch", "local_fallback"],
	[409, { error: { code: "viewer_identity_mismatch" } }, "identity_mismatch", "local_fallback"],
	[404, {}, "endpoint_unavailable", "fallback"],
	[405, {}, "endpoint_unavailable", "fallback"],
	[503, {}, "server_failure", "fallback"],
	[302, {}, "unexpected_status", "fallback"],
])(
	"records POST status %s as %s/%s and preserves fallback eligibility",
	async (status, body, reason, disposition) => {
		// Arrange
		const runtime = await fixture();
		fetch
			.mockResolvedValueOnce(response(compatibleProfile()))
			.mockResolvedValue(response(body, status));
		// Act
		await transform(runtime);
		// Assert
		expect(entries()[0]).toMatchObject({
			reason,
			disposition,
			stage: "request",
			status_class: `${Math.floor(status / 100)}xx`,
			runner: disposition === "terminal" ? "none" : "node",
		});
		expect(commands("pack")).toHaveLength(disposition === "terminal" ? 0 : 1);
		expect(fetch.mock.calls[1][1].redirect).toBe("manual");
		expect(JSON.stringify(entries())).not.toContain("private-ledger-reason");
	},
);

it("measures profile plus POST time but excludes the subsequent CLI fallback", async () => {
	// Arrange
	let monotonic = 100;
	performance.now.mockImplementation(() => monotonic);
	const runtime = await fixture();
	fetch.mockImplementation(async (_url, init) => {
		if (init.method === "GET") {
			monotonic += 25;
			return response(compatibleProfile());
		}
		monotonic += 75;
		return response({}, 503);
	});
	const spawn = io.spawn.getMockImplementation();
	io.spawn.mockImplementation((...args) => {
		monotonic += 1_000;
		return spawn(...args);
	});
	// Act
	await transform(runtime);
	// Assert
	expect(entries()[0]).toMatchObject({
		reason: "server_failure",
		stage: "request",
		elapsed_ms: 100,
		runner: "node",
	});
	expect(monotonic).toBe(1_200);
	expect(commands("pack")).toHaveLength(1);
});

it.each([null, { pack_text: "private-response", metrics: { total_items: -1 } }, "invalid-json"])(
	"records malformed POST success without logging its payload: %s",
	async (body) => {
		// Arrange
		const runtime = await fixture();
		const invalid = response(body);
		if (body === "invalid-json") invalid.json.mockRejectedValue(new Error("private-response"));
		fetch.mockResolvedValueOnce(response(compatibleProfile())).mockResolvedValueOnce(invalid);
		// Act
		await transform(runtime);
		// Assert
		expect(entries()[0]).toMatchObject({
			reason: "malformed_response",
			stage: "request",
			status_class: "2xx",
			runner: "node",
		});
		expect(JSON.stringify(entries())).not.toContain("private-response");
		expect(commands("pack")).toHaveLength(1);
	},
);
