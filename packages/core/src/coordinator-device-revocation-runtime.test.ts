import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";

const preview = "/v1/admin/devices/revoke-preview";
const commit = "/v1/admin/devices/revoke";
const input = { group_id: "group-a", device_id: "device-a" };
const secret = "test-secret";
function request(path = preview, options: RequestInit = {}) {
	return new Request(`https://coordinator.example.test${path}`, {
		method: "POST",
		body: JSON.stringify(input),
		...options,
		headers: {
			"Content-Type": "application/json",
			"X-Codemem-Coordinator-Admin": secret,
			...Object.fromEntries(new Headers(options.headers)),
		},
		duplex: "half",
	} as RequestInit);
}

let directory: string;
let dbPath: string;
let store: BetterSqliteCoordinatorStore;
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "codemem-revocation-runtime-"));
	dbPath = join(directory, "coordinator.sqlite");
	store = new BetterSqliteCoordinatorStore(dbPath);
	await store.createGroup(input.group_id);
	await store.enrollDevice(input.group_id, {
		deviceId: input.device_id,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
	});
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(async () => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	await store.close();
	rmSync(directory, { recursive: true, force: true });
});
function app(coordinatorId = "coordinator-a") {
	return createBetterSqliteCoordinatorApp({
		dbPath,
		deviceRevocation: { coordinatorId },
		runtime: { adminSecret: () => secret, now: () => "2026-10-20T00:00:00Z" },
	});
}
it("previews without writing, commits both global subjects, and closes only request stores", async () => {
	// Arrange
	const mounted = app();
	const close = vi.spyOn(BetterSqliteCoordinatorStore.prototype, "close");
	// Act
	const response = await mounted.fetch(request());
	const evidence = (await response.json()) as { expected_digest: string };
	const before = await store.listDeviceRevocations({ deviceId: input.device_id });
	const result = await mounted.fetch(
		request(commit, {
			body: JSON.stringify({ ...input, expected_digest: evidence.expected_digest }),
		}),
	);
	// Assert
	expect(response.status).toBe(200);
	expect(before).toEqual([]);
	expect(result.status).toBe(200);
	expect(await result.json()).toMatchObject({
		state: "revoked",
		coordinator_id: "coordinator-a",
		revocations: [
			{ subject_kind: "device_id", subject_value: input.device_id },
			{ subject_kind: "ed25519_key" },
		],
	});
	expect(
		await store.listDeviceRevocations({
			deviceId: input.device_id,
			publicKey: CANONICAL_PUBLIC_KEY,
		}),
	).toHaveLength(2);
	expect(close).toHaveBeenCalledTimes(2);
	expect(store.db.open).toBe(true);
});
it("does not reuse evidence across coordinator IDs or databases", async () => {
	// Arrange
	const evidence = (await (await app().fetch(request())).json()) as { expected_digest: string };
	const otherPath = join(directory, "other.sqlite");
	const other = new BetterSqliteCoordinatorStore(otherPath);
	await other.createGroup(input.group_id);
	await other.enrollDevice(input.group_id, {
		deviceId: input.device_id,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "b".repeat(64),
	});
	const otherApp = createBetterSqliteCoordinatorApp({
		dbPath: otherPath,
		deviceRevocation: { coordinatorId: "coordinator-a" },
		runtime: { adminSecret: () => secret, now: () => "2026-10-20T00:00:00Z" },
	});
	try {
		// Act
		const body = JSON.stringify({ ...input, expected_digest: evidence.expected_digest });
		const cidResponse = await app("coordinator-b").fetch(request(commit, { body }));
		const dbResponse = await otherApp.fetch(request(commit, { body }));
		const afterStale = await other.listDeviceRevocations({ deviceId: input.device_id });
		const otherEvidence = (await (await otherApp.fetch(request())).json()) as {
			expected_digest: string;
		};
		const otherCommit = await otherApp.fetch(
			request(commit, {
				body: JSON.stringify({ ...input, expected_digest: otherEvidence.expected_digest }),
			}),
		);
		// Assert
		expect(cidResponse.status).toBe(409);
		expect(dbResponse.status).toBe(409);
		expect(await store.listDeviceRevocations({ deviceId: input.device_id })).toEqual([]);
		expect(afterStale).toEqual([]);
		expect(otherCommit.status).toBe(200);
		expect(
			await other.listDeviceRevocations({
				deviceId: input.device_id,
				publicKey: CANONICAL_PUBLIC_KEY,
			}),
		).toHaveLength(2);
	} finally {
		await other.close();
	}
});
it.each(["missing", "empty", "legacy"])("never creates or repairs a %s database", async (kind) => {
	// Arrange
	const path = join(directory, `${kind}.sqlite`);
	if (kind === "empty") writeFileSync(path, "");
	if (kind === "legacy") {
		const db = new Database(path);
		db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('unchanged')");
		db.close();
	}
	const before = existsSync(path) ? readFileSync(path) : null;
	const mounted = createBetterSqliteCoordinatorApp({
		dbPath: path,
		deviceRevocation: { coordinatorId: "coordinator-a" },
		runtime: { adminSecret: () => secret, now: () => "2026-10-20T00:00:00Z" },
	});
	// Act
	const response = await mounted.fetch(request());
	// Assert
	expect(response.status).toBe(503);
	expect(existsSync(path)).toBe(before !== null);
	if (before) expect(readFileSync(path)).toEqual(before);
});
it("captures the admin secret and runtime database before reading a body", async () => {
	// Arrange
	let configuredSecret = secret;
	const options = {
		dbPath,
		deviceRevocation: { coordinatorId: "coordinator-a" },
		runtime: { adminSecret: () => configuredSecret, now: () => "2026-10-20T00:00:00Z" },
	};
	const mounted = createBetterSqliteCoordinatorApp(options);
	const stream = new TransformStream<Uint8Array, Uint8Array>();
	const writer = stream.writable.getWriter();
	const pending = mounted.fetch(request(preview, { body: stream.readable }));
	configuredSecret = "replacement-secret";
	options.dbPath = join(directory, "must-not-create.sqlite");
	options.deviceRevocation.coordinatorId = "coordinator-b";
	// Act
	await writer.write(new TextEncoder().encode(JSON.stringify(input)));
	await writer.close();
	const response = await pending;
	// Assert
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ coordinator_id: "coordinator-a" });
	expect(existsSync(options.dbPath)).toBe(false);
});

function instrumented(options: Partial<Parameters<typeof createCoordinatorApp>[0]> = {}) {
	const selected = new BetterSqliteCoordinatorStore(dbPath, { existingOnly: true });
	const open = vi.fn(() => selected);
	const read = vi.spyOn(selected, "getEnrollment");
	const close = vi.spyOn(selected, "close");
	const mounted = createCoordinatorApp({
		storeFactory: open,
		deviceRevocation: { coordinatorId: "coordinator-a" },
		runtime: { adminSecret: () => secret, now: () => "2026-10-20T00:00:00Z" },
		requestVerifier: () => false,
		...options,
	});
	return { mounted, open, read, close, selected };
}
async function validRevocationBody(path: string, target = input) {
	if (path === preview) return JSON.stringify(target);
	const evidence = (await (
		await app().fetch(request(preview, { body: JSON.stringify(target) }))
	).json()) as { expected_digest: string };
	return JSON.stringify({ ...target, expected_digest: evidence.expected_digest });
}
it.each(
	[preview, commit].flatMap((path) =>
		["zero", "short", "long"].map((length) => ({ path, length })),
	),
)("rejects $length Content-Length on $path before opening a store", async ({ path, length }) => {
	// Arrange: commit carries a genuine preview digest, so framing is its only fault.
	const body = await validRevocationBody(path);
	const bytes = new TextEncoder().encode(body).byteLength;
	const declarations = { zero: 0, short: bytes - 1, long: bytes + 1 };
	const f = instrumented();
	try {
		// Act
		const response = await f.mounted.fetch(
			request(path, {
				body,
				headers: { "Content-Length": String(declarations[length as keyof typeof declarations]) },
			}),
		);
		// Assert
		expect(response.status).toBe(400);
		expect(f.open).not.toHaveBeenCalled();
		expect(f.read).not.toHaveBeenCalled();
		expect(
			await store.listDeviceRevocations({
				deviceId: input.device_id,
				publicKey: CANONICAL_PUBLIC_KEY,
			}),
		).toEqual([]);
	} finally {
		if (f.selected.db.open) await f.selected.close();
	}
});
it.each([preview, commit])("measures UTF-8 bytes, not string length, on %s", async (path) => {
	// Arrange
	const target = { group_id: input.group_id, device_id: "device-é" };
	await store.enrollDevice(target.group_id, {
		deviceId: target.device_id,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
	});
	const body = await validRevocationBody(path, target);
	const bytes = new TextEncoder().encode(body).byteLength;
	const mounted = app();
	// Act: a character count is refused, then the identical JSON with a byte count succeeds.
	const wrong = await mounted.fetch(
		request(path, { body, headers: { "Content-Length": String(body.length) } }),
	);
	const before = await store.listDeviceRevocations({
		deviceId: target.device_id,
		publicKey: CANONICAL_PUBLIC_KEY,
	});
	const correct = await mounted.fetch(
		request(path, { body, headers: { "Content-Length": String(bytes) } }),
	);
	// Assert
	expect(bytes).toBeGreaterThan(body.length);
	expect(wrong.status).toBe(400);
	expect(before).toEqual([]);
	expect(correct.status).toBe(200);
	expect(
		await store.listDeviceRevocations({
			deviceId: target.device_id,
			publicKey: CANONICAL_PUBLIC_KEY,
		}),
	).toHaveLength(path === commit ? 2 : 0);
});
it.each([undefined, { coordinatorId: "" }, { coordinatorId: "bad\nID" }])(
	"fails closed for unavailable trusted context %j",
	async (deviceRevocation) => {
		// Arrange
		const f = instrumented({ deviceRevocation });
		try {
			// Act
			const response = await f.mounted.fetch(request());
			// Assert
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "revocation_unavailable" });
			expect(f.open).not.toHaveBeenCalled();
			expect(f.read).not.toHaveBeenCalled();
		} finally {
			await f.selected.close();
		}
	},
);
it.each(["coordinator-a", "coordinator-b"])(
	"requires matching configured auth context %s without opening browser stores",
	async (coordinatorId) => {
		// Arrange
		const browserOpen = vi.fn(() => store);
		const f = instrumented({
			authLink: {
				config: {
					enabled: true,
					coordinatorId,
					issuer: "https://accounts.google.com",
					revision: "a".repeat(64),
					redirectUri: "https://coordinator.example.test/auth/callback",
				},
				storeFactory: browserOpen,
			},
		});
		try {
			// Act
			const response = await f.mounted.fetch(request());
			// Assert
			expect(response.status).toBe(coordinatorId === "coordinator-a" ? 200 : 503);
			expect(f.open).toHaveBeenCalledTimes(coordinatorId === "coordinator-a" ? 1 : 0);
			expect(browserOpen).not.toHaveBeenCalled();
		} finally {
			if (f.selected.db.open) await f.selected.close();
		}
	},
);
it("accepts the exact 4096-byte JSON boundary and acquires one body reader", async () => {
	// Arrange
	const mounted = app();
	const body = JSON.stringify(input).padEnd(4096, " ");
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(body));
			controller.close();
		},
	});
	const getReader = vi.spyOn(stream, "getReader");
	// Act
	const response = await mounted.fetch(
		request(preview, { body: stream, headers: { "Content-Length": "4096" } }),
	);
	// Assert
	expect(response.status).toBe(200);
	expect(getReader).toHaveBeenCalledOnce();
	expect(await store.listDeviceRevocations({ deviceId: input.device_id })).toEqual([]);
});
it.each([
	["wrong admin", preview, { headers: { "X-Codemem-Coordinator-Admin": "wrong" } }, 401],
	["method", preview, { method: "PUT" }, 405],
	["query", `${preview}?coordinator_id=coordinator-a`, {}, 400],
	["media type", preview, { headers: { "Content-Type": "text/plain" } }, 415],
	["encoding", preview, { headers: { "Content-Encoding": "identity" } }, 415],
	["invalid length", preview, { headers: { "Content-Length": "-1" } }, 400],
	[
		"conflicting framing",
		preview,
		{ headers: { "Content-Length": "10", "Transfer-Encoding": "chunked" } },
		400,
	],
	["declared size", preview, { headers: { "Content-Length": "4097" } }, 413],
	["stream UTF-8 byte size", preview, { body: "é".repeat(2049) }, 413],
	["invalid JSON", preview, { body: "{" }, 400],
	["commit missing digest", commit, {}, 400],
] as const)("rejects %s without opening the selected store", async (_name, path, init, status) => {
	// Arrange
	const f = instrumented();
	try {
		// Act
		const response = await f.mounted.fetch(request(path, init));
		// Assert
		expect(response.status).toBe(status);
		expect(f.open).not.toHaveBeenCalled();
		expect(f.read).not.toHaveBeenCalled();
	} finally {
		await f.selected.close();
	}
});
it.each(["anonymous", "admin"])(
	"applies the %s rate budget before reading body",
	async (budget) => {
		// Arrange
		const f = instrumented({
			requestRateLimit: {
				unauthenticatedMutationLimit: budget === "anonymous" ? 1 : 100,
				mutationLimit: 1,
			},
		});
		const first = await f.mounted.fetch(request());
		const getReader = vi.fn();
		const next = request();
		Object.defineProperty(next, "body", { value: { getReader } });
		try {
			// Act
			const response = await f.mounted.fetch(next);
			// Assert
			expect(first.status).toBe(200);
			expect(response.status).toBe(429);
			expect(getReader).not.toHaveBeenCalled();
			expect(f.open).toHaveBeenCalledTimes(1);
		} finally {
			if (f.selected.db.open) await f.selected.close();
		}
	},
);
it.each(["request", "deadline", "oversize", "reject"])(
	"settles %s body failure even when stream cancellation never settles",
	async (failure) => {
		// Arrange: replace only the trusted timeout signal, not the public deadline policy.
		const f = instrumented();
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const read = vi.fn((): Promise<ReadableStreamReadResult<Uint8Array>> => {
			if (failure === "oversize")
				return Promise.resolve({ done: false, value: new Uint8Array(4097) });
			if (failure === "reject") return Promise.reject(new Error("body read failed"));
			return new Promise(() => {});
		});
		const releaseLock = vi.fn();
		const abort = new AbortController();
		const req = request(preview, { signal: abort.signal });
		Object.defineProperty(req, "body", {
			value: { getReader: () => ({ read, cancel, releaseLock }) },
		});
		try {
			// Act
			const pending = f.mounted.fetch(req);
			await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
			if (failure === "deadline") controller.abort();
			if (failure === "request") abort.abort();
			const response = await pending;
			// Assert
			expect(timeout).toHaveBeenCalledWith(10_000);
			expect(response.status).toBe(failure === "oversize" ? 413 : 503);
			expect(f.open).not.toHaveBeenCalled();
			expect(cancel).toHaveBeenCalledOnce();
			expect(releaseLock).toHaveBeenCalledOnce();
		} finally {
			await f.selected.close();
		}
	},
);
it.each(["read", "write", "lost receipt"])(
	"closes the selected store on %s failure without promising rollback",
	async (failure) => {
		// Arrange
		const evidence = (await (await app().fetch(request())).json()) as { expected_digest: string };
		const f = instrumented();
		if (failure === "read") f.read.mockRejectedValue(new Error("read failed"));
		else {
			const original = f.selected.createDeviceRevocation.bind(f.selected);
			vi.spyOn(f.selected, "createDeviceRevocation").mockImplementation(async (tuple) => {
				if (failure === "lost receipt") await original(tuple);
				throw new Error("backend failure");
			});
		}
		// Act
		const response = await f.mounted.fetch(
			request(commit, {
				body: JSON.stringify({ ...input, expected_digest: evidence.expected_digest }),
			}),
		);
		// Assert
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "device_revocation_incomplete" });
		expect(f.close).toHaveBeenCalledOnce();
		expect(f.selected.db.open).toBe(false);
		expect(
			await store.listDeviceRevocations({
				deviceId: input.device_id,
				publicKey: CANONICAL_PUBLIC_KEY,
			}),
		).toHaveLength(failure === "lost receipt" ? 2 : 0);
	},
);
