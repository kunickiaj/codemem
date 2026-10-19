import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readAccountLinkDevice } from "./coordinator-account-link-signer.js";
import type { CoordinatorAccountLinkStatus } from "./coordinator-account-link-status.js";
import {
	readCoordinatorAccountLinkStatus as read,
	readCoordinatorAccountChangeCapabilities as readCapabilities,
} from "./coordinator-account-link-status-client.js";
import * as localEvidence from "./coordinator-device-local.js";
import { verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { generateKeypair, loadPublicKey } from "./sync-identity.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));

const origin = "https://coordinator.example.test";
let dir: string;
let db: Database.Database;
let publicKey: string;
let fingerprint: string;
let options: {
	dbPath: string;
	keysDir: string;
	groupId: string;
	identityId: string;
	coordinatorUrl: string;
	fetch: typeof fetch;
};
let transport: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "account-status-client-"));
	const keysDir = join(dir, "keys");
	mkdirSync(keysDir);
	generateKeypair(join(keysDir, "device.key"), join(keysDir, "device.key.pub"));
	publicKey = loadPublicKey(keysDir) ?? "";
	fingerprint = fingerprintPublicKey(publicKey);
	db = new Database(join(dir, "local.sqlite"));
	db.exec(
		"CREATE TABLE sync_device(device_id, public_key, fingerprint); CREATE TABLE metadata(key, value); INSERT INTO metadata VALUES ('sentinel', 'unchanged'); PRAGMA user_version=17;",
	);
	db.prepare("INSERT INTO sync_device VALUES (?, ?, ?)").run("device-a", publicKey, fingerprint);
	writeFileSync(join(dir, "config.json"), '{"sentinel":"unchanged"}');
	transport = vi.fn<typeof fetch>(async () => Response.json(status()));
	options = {
		dbPath: db.name,
		keysDir,
		groupId: "group-a",
		identityId: "identity-a",
		coordinatorUrl: origin,
		fetch: transport,
	};
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("real network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (db.open) db.close();
	rmSync(dir, { recursive: true, force: true });
});

function status(
	overrides: Partial<CoordinatorAccountLinkStatus> = {},
): CoordinatorAccountLinkStatus {
	return {
		version: 2,
		coordinatorId: "coordinator-a",
		groupId: options?.groupId ?? "group-a",
		deviceId: "device-a",
		fingerprint,
		identityId: "identity-a",
		authority: "controller_attestation",
		state: "linked",
		account: {},
		...overrides,
	} as CoordinatorAccountLinkStatus;
}
function snapshot() {
	const files = (base: string): unknown[] =>
		readdirSync(base)
			.sort()
			.map((name) => {
				const path = join(base, name);
				const stat = statSync(path);
				return [
					name,
					stat.isDirectory() ? files(path) : [readFileSync(path), stat.size, stat.mtimeMs],
				];
			});
	return {
		files: files(dir),
		...logicalSnapshot(db),
	};
}

it.each([
	{ displayName: "Test Person" },
	{ displayName: "Test Person", pictureUrl: "https://lh3.googleusercontent.com/a/photo" },
])("accepts optional trusted profile photo %j", async (account) => {
	// Arrange: older coordinators may omit the photo field entirely.
	const dto = status({ account });
	transport.mockResolvedValue(Response.json(dto));
	// Act
	const result = await read(options);
	// Assert
	expect(result).toEqual({ kind: "status", status: dto });
});

it.each([
	{ pictureUrl: "http://lh3.googleusercontent.com/a/photo" },
	{ pictureUrl: "data:image/png;base64,AA==" },
	{ pictureUrl: "https://user:pass@lh3.googleusercontent.com/a/photo" },
	{ pictureUrl: "https://lh3.googleusercontent.com:8443/a/photo" },
	{ pictureUrl: "https://lh3.googleusercontent.com.evil.test/a/photo" },
	{ pictureUrl: "https://images.example.test/a/photo" },
	{ pictureUrl: "https://lh3.googleusercontent.com/a/photo", subject: "unexpected" },
])("rejects unsafe photos and unknown account keys %j", async (account) => {
	// Arrange: adding an optional field must not relax the strict account contract.
	transport.mockResolvedValue(Response.json(status({ account })));
	// Act
	const result = await read(options);
	// Assert
	expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
});

function logicalSnapshot(connection: Database.Database) {
	return {
		schema: connection.prepare("SELECT * FROM sqlite_master ORDER BY name").all(),
		version: connection.pragma("user_version", { simple: true }),
		rows: connection.prepare("SELECT * FROM sync_device").all(),
		metadata: connection.prepare("SELECT * FROM metadata").all(),
	};
}
const capabilities = () => ({
	coordinator_id: "coordinator-a",
	identity_id: "identity-a",
	actions: { refresh: true, disconnect: false },
});
it("reads capabilities with the existing signer, exact public query and no local writes", async () => {
	const before = snapshot();
	transport.mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		expect(url.origin).toBe(origin);
		expect(url.pathname).toBe("/v1/auth/account-changes");
		expect([...url.searchParams.entries()]).toEqual([
			["group_id", "group-a"],
			["identity_id", "identity-a"],
		]);
		const headers = new Headers(init?.headers);
		expect(
			await verifySignature({
				method: "GET",
				pathWithQuery: url.pathname + url.search,
				bodyBytes: Buffer.alloc(0),
				timestamp: headers.get("X-Opencode-Timestamp") ?? "",
				nonce: headers.get("X-Opencode-Nonce") ?? "",
				signature: headers.get("X-Opencode-Signature") ?? "",
				publicKey,
				deviceId: "device-a",
			}),
		).toBe(true);
		return Response.json(capabilities());
	});
	expect(await readCapabilities(options)).toEqual({
		kind: "capabilities",
		coordinatorId: "coordinator-a",
		actions: { refresh: true, disconnect: false },
	});
	expect(snapshot()).toEqual(before);
});
it.each([
	{ ...capabilities(), identity_id: "other" },
	{ ...capabilities(), coordinator_id: "" },
	{ ...capabilities(), profile: {} },
	{ ...capabilities(), actions: { refresh: "true", disconnect: true } },
	{ ...capabilities(), actions: { refresh: true } },
	{ ...capabilities(), actions: { refresh: true, disconnect: true, role: "owner" } },
])("strictly rejects malformed capabilities %j", async (body) => {
	transport.mockResolvedValue(Response.json(body));
	expect(await readCapabilities(options)).toEqual({
		kind: "unavailable",
		code: "invalid_response",
	});
});
it.each([
	[404, { kind: "unsupported" }],
	[403, { kind: "unavailable", code: "coordinator_rejected" }],
	[503, { kind: "unavailable", code: "coordinator_unavailable" }],
	[429, { kind: "unavailable", code: "rate_limited" }],
])("maps capability HTTP %s without granting actions", async (status, result) => {
	transport.mockResolvedValue(new Response(null, { status: Number(status) }));
	expect(await readCapabilities(options)).toEqual(result);
});
it("caps capability response size and preserves the shared deadline", async () => {
	transport.mockResolvedValue(new Response(" ".repeat(16385)));
	expect(await readCapabilities(options)).toEqual({
		kind: "unavailable",
		code: "invalid_response",
	});
	vi.useFakeTimers();
	transport.mockImplementation(() => new Promise(() => {}));
	const pending = readCapabilities(options);
	await vi.advanceTimersByTimeAsync(10001);
	expect(await pending).toEqual({ kind: "unavailable", code: "coordinator_unreachable" });
});

it.each([
	["review_required", null, null],
	["conflict", null, null],
	["unlinked", "identity-a", null],
	["revoked", "identity-a", null],
	["linked", "identity-a", {}],
	["linked", "identity-a", { email: "person@example.test" }],
	["linked", "identity-a", { displayName: "Test Person" }],
] as const)(
	"reads %s in rollback-journal mode without changing any local file, row, or schema",
	async (state, identityId, account) => {
		// Arrange: a minimal persisted device, not an initialized MemoryStore.
		const authority = identityId === null ? null : "controller_attestation";
		const dto = status({ state, identityId, authority, account });
		transport.mockResolvedValue(Response.json(dto));
		const before = snapshot();
		const readers: Database.Database[] = [];
		const original = localEvidence.readCoordinatorDeviceLocalEvidence;
		vi.spyOn(localEvidence, "readCoordinatorDeviceLocalEvidence").mockImplementation(
			(connection) => {
				expect(connection.readonly).toBe(true);
				readers.push(connection);
				return original(connection);
			},
		);
		// Act
		const result = await read(options);
		// Assert
		expect(result).toEqual({ kind: "status", status: dto });
		expect(snapshot()).toEqual(before);
		expect(transport).toHaveBeenCalledTimes(1);
		expect(readers.length).toBeGreaterThan(0);
		expect(readers.every((connection) => !connection.open)).toBe(true);
	},
);

it.each(["device_claim", "controller_attestation"] as const)(
	"accepts %s eligibility and a different linked Identity only with masked metadata",
	async (authority) => {
		// Arrange: eligibility belongs to the requested Identity; a prior link need not.
		const eligible = status({ state: "unlinked", authority, account: null });
		const linked = status({ identityId: "other-identity", authority, account: null });
		transport
			.mockResolvedValueOnce(Response.json(eligible))
			.mockResolvedValueOnce(Response.json(linked));
		// Act
		const results = [await read(options), await read(options)];
		// Assert: a status read never starts or polls a browser transaction.
		expect(results).toEqual([
			{ kind: "status", status: eligible },
			{ kind: "status", status: linked },
		]);
		expect(transport).toHaveBeenCalledTimes(2);
		for (const [input, init] of transport.mock.calls) {
			const request = new Request(input, init);
			expect(request.method).toBe("GET");
			expect(new URL(request.url).pathname).toBe("/v1/auth/account-link-status");
		}
	},
);

it.each([undefined, "", "bad\nidentity"])(
	"refuses missing or invalid Identity %s before local IO",
	async (identityId) => {
		// Arrange
		const access = vi.fn(() => {
			throw new Error("private-local-access");
		});
		const input = { ...options, identityId };
		Object.defineProperty(input, "dbPath", { get: access });
		// Act: model an untyped caller omitting the required Identity.
		const result = await read(input as Parameters<typeof read>[0]);
		// Assert
		expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
		expect(access).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	},
);

it("rejects a non-origin coordinator URL without requesting or repairing local state", async () => {
	// Arrange
	const before = snapshot();
	// Act
	const result = await read({ ...options, coordinatorUrl: `${origin}/other` });
	// Assert
	expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
	expect(transport).not.toHaveBeenCalled();
	expect(snapshot()).toEqual(before);
});

it("reads and signs after a WAL writer closes, allowing SQLite coordination files only", async () => {
	// Arrange: closing the last writer removes sidecars without manual cleanup.
	expect(db.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
	const before = logicalSnapshot(db);
	db.close();
	const mainBytes = readFileSync(options.dbPath);
	const privateKey = readFileSync(join(options.keysDir, "device.key"));
	const publicKeyBytes = readFileSync(join(options.keysDir, "device.key.pub"));
	expect(existsSync(`${options.dbPath}-wal`)).toBe(false);
	expect(existsSync(`${options.dbPath}-shm`)).toBe(false);

	// Act: readonly SQLite handles may create and leave WAL/SHM coordination files.
	const result = await read(options);

	// Assert: no promise of zero filesystem writes; persisted application data is unchanged.
	expect(result).toEqual({ kind: "status", status: status() });
	expect(transport).toHaveBeenCalledOnce();
	expect(existsSync(`${options.dbPath}-wal`)).toBe(true);
	expect(existsSync(`${options.dbPath}-shm`)).toBe(true);
	expect(readFileSync(options.dbPath)).toEqual(mainBytes);
	expect(readFileSync(join(options.keysDir, "device.key"))).toEqual(privateKey);
	expect(readFileSync(join(options.keysDir, "device.key.pub"))).toEqual(publicKeyBytes);
	expect(readFileSync(join(dir, "config.json"), "utf8")).toBe('{"sentinel":"unchanged"}');
	db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
	expect(logicalSnapshot(db)).toEqual(before);
});

it.each(["fresh evidence", "captured old evidence"])(
	"uses committed device/key changes in a live WAL with %s",
	async (mode) => {
		// Arrange: checkpoint the old identity, then commit a new identity only to WAL.
		expect(db.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
		db.pragma("wal_checkpoint(TRUNCATE)");
		const captured = readAccountLinkDevice(options.dbPath);
		const mainBytes = readFileSync(options.dbPath);
		generateKeypair(join(dir, "next.key"), join(dir, "next.key.pub"));
		writeFileSync(join(options.keysDir, "device.key"), readFileSync(join(dir, "next.key")));
		writeFileSync(join(options.keysDir, "device.key.pub"), readFileSync(join(dir, "next.key.pub")));
		const nextPublicKey = loadPublicKey(options.keysDir) ?? "";
		const nextFingerprint = fingerprintPublicKey(nextPublicKey);
		expect(nextPublicKey).not.toBe(captured.publicKey);
		db.prepare("UPDATE sync_device SET device_id=?, public_key=?, fingerprint=?").run(
			"device-b",
			nextPublicKey,
			nextFingerprint,
		);
		expect(statSync(`${options.dbPath}-wal`).size).toBeGreaterThan(0);
		expect(readFileSync(options.dbPath)).toEqual(mainBytes);
		const before = logicalSnapshot(db);
		const privateKey = readFileSync(join(options.keysDir, "device.key"));
		const publicKeyBytes = readFileSync(join(options.keysDir, "device.key.pub"));
		const dto = status({ deviceId: "device-b", fingerprint: nextFingerprint });
		transport.mockResolvedValue(Response.json(dto));
		const current = readAccountLinkDevice(options.dbPath);
		if (mode === "captured old evidence") {
			// Simulate capture before the commit; the signer's second read must reject it.
			vi.spyOn(localEvidence, "readCoordinatorDeviceLocalEvidence").mockReturnValueOnce(captured);
		}

		// Act: the reader must see the committed WAL, not the checkpointed main file.
		const result = await read(options);

		// Assert: fresh evidence signs with the matching key; stale evidence cannot sign.
		expect(current).toEqual({
			deviceId: "device-b",
			publicKey: nextPublicKey,
			fingerprint: nextFingerprint,
		});
		if (mode === "fresh evidence") {
			expect(result).toEqual({ kind: "status", status: dto });
			expect(transport).toHaveBeenCalledOnce();
			const [input, init] = transport.mock.calls[0];
			const request = new Request(input, init);
			const url = new URL(request.url);
			expect(
				verifySignature({
					method: "GET",
					pathWithQuery: `${url.pathname}${url.search}`,
					bodyBytes: Buffer.alloc(0),
					deviceId: "device-b",
					publicKey: nextPublicKey,
					timestamp: request.headers.get("X-Opencode-Timestamp") ?? "",
					nonce: request.headers.get("X-Opencode-Nonce") ?? "",
					signature: request.headers.get("X-Opencode-Signature") ?? "",
				}),
			).toBe(true);
		} else {
			expect(result).toEqual({ kind: "unavailable", code: "device_unavailable" });
			expect(transport).not.toHaveBeenCalled();
		}
		expect(logicalSnapshot(db)).toEqual(before);
		expect(readFileSync(options.dbPath)).toEqual(mainBytes);
		expect(readFileSync(join(options.keysDir, "device.key"))).toEqual(privateKey);
		expect(readFileSync(join(options.keysDir, "device.key.pub"))).toEqual(publicKeyBytes);
	},
);

it("signs the exact group=0 GET with an empty body and manual redirects", async () => {
	// Arrange
	options.groupId = "0";
	options.coordinatorUrl = `${origin}/`;
	const controller = new AbortController();
	// Act
	await read({ ...options, signal: controller.signal });
	// Assert: verify against the stored public key, not the client's signer helper.
	const [input, init] = transport.mock.calls[0];
	const request = new Request(input, init);
	const url = new URL(request.url);
	expect(url.origin).toBe(origin);
	expect(`${url.pathname}${url.search}`).toBe(
		`/v1/auth/account-link-status?group_id=0&coordinator_origin=${encodeURIComponent(origin)}&identity_id=identity-a`,
	);
	expect(request.method).toBe("GET");
	expect(await request.text()).toBe("");
	expect(init?.redirect).toBe("manual");
	expect(init?.signal).toBeInstanceOf(AbortSignal);
	expect(init?.signal).not.toBe(controller.signal);
	expect(request.headers.get("X-Opencode-Device")).toBe("device-a");
	const proof = {
		method: "GET",
		pathWithQuery: `${url.pathname}${url.search}`,
		bodyBytes: Buffer.alloc(0),
		timestamp: request.headers.get("X-Opencode-Timestamp") ?? "",
		nonce: request.headers.get("X-Opencode-Nonce") ?? "",
		signature: request.headers.get("X-Opencode-Signature") ?? "",
		publicKey,
		deviceId: "device-a",
	};
	expect(verifySignature(proof)).toBe(true);
	expect(
		verifySignature({
			...proof,
			pathWithQuery: proof.pathWithQuery.replace("identity_id=identity-a", "identity_id=other"),
		}),
	).toBe(false);
	expect(
		verifySignature({
			...proof,
			pathWithQuery: proof.pathWithQuery.replace(
				encodeURIComponent(origin),
				encodeURIComponent("https://other.example.test"),
			),
		}),
	).toBe(false);
	expect(
		verifySignature({ ...proof, pathWithQuery: "/v1/auth/account-link-status?group_id=other" }),
	).toBe(false);
});

it.each([
	[404, "unsupported", undefined],
	[400, "unavailable", "coordinator_incompatible"],
	[408, "unavailable", "coordinator_unavailable"],
	[503, "unavailable", "coordinator_unavailable"],
	[429, "unavailable", "rate_limited"],
	[401, "unavailable", "coordinator_rejected"],
	[403, "unavailable", "coordinator_rejected"],
	[409, "unavailable", "coordinator_rejected"],
	[500, "unavailable", "coordinator_unavailable"],
	[502, "unavailable", "coordinator_unavailable"],
	[504, "unavailable", "coordinator_unavailable"],
	[302, "unavailable", "invalid_response"],
	[204, "unavailable", "invalid_response"],
] as const)(
	"maps HTTP %s without trusting or exposing its text body",
	async (httpStatus, kind, code) => {
		// Arrange: 404 is unsupported, never evidence of an unlinked account.
		transport.mockResolvedValue(
			new Response(httpStatus === 204 ? null : "private upstream cause", { status: httpStatus }),
		);
		// Act
		const result = await read(options);
		// Assert
		expect(result).toMatchObject(code ? { kind, code } : { kind });
		expect(JSON.stringify(result)).not.toMatch(/private upstream|unlinked|identity-a/);
	},
);

it("reports an incompatible request without leaking proof URLs or retrying a legacy request", async () => {
	// Arrange: error bodies are untrusted, including an upstream proof URL.
	transport.mockResolvedValue(
		Response.json(
			{
				error: "auth_link_invalid_input",
				proofUrl: "https://coordinator.example.test/proof?token=private-proof-marker",
			},
			{ status: 400 },
		),
	);
	const before = snapshot();
	// Act
	const result = await read(options);
	// Assert: one signed request, no V1 fallback, and no account-state claim.
	expect(result).toEqual({ kind: "unavailable", code: "coordinator_incompatible" });
	expect(JSON.stringify(result)).not.toMatch(/auth_link_invalid_input|proof|token|unlinked/);
	expect(transport).toHaveBeenCalledOnce();
	expect(snapshot()).toEqual(before);
});

it("reports the fixed schema-upgrade refusal without reading an upstream error body", async () => {
	transport.mockResolvedValue(
		new Response("private upstream cause", {
			status: 503,
			headers: { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" },
		}),
	);
	expect(await read(options)).toEqual({
		kind: "unavailable",
		code: "coordinator_auth_schema_upgrade_required",
	});
});

const invalid = [
	{ version: 1 },
	{ authority: undefined },
	{ authority: "admin" },
	{ state: "unlinked", identityId: "other-identity", account: null },
	{ identityId: "other-identity", account: { email: "private response marker" } },
	{ coordinatorId: "" },
	{ coordinatorId: "bad\ncoordinator" },
	{ deviceId: "other-device" },
	{ groupId: "other-group" },
	{ fingerprint: "a".repeat(64) },
	{ identityId: "" },
	{ identityId: 42 },
	{ state: "unknown" },
	{ state: "review_required", identityId: "identity-a", account: null },
	{ state: "conflict", identityId: null, account: {} },
	{ state: "unlinked", identityId: null, account: null },
	{ state: "revoked", account: {} },
	{ state: "review_required", identityId: null, account: null },
	{ privateKey: "private response marker" },
	{ subject: "private response marker" },
	...[
		[],
		"account",
		{ email: null },
		{ displayName: 42 },
		{ subject: "private response marker" },
		{ email: "x\ny" },
		{ displayName: "x\u200by" },
		{ email: "a".repeat(321) },
		{ displayName: "a".repeat(257) },
		{ email: "" },
		{ displayName: "   " },
	].map((account) => ({ account })),
];
it.each(invalid)("rejects malformed/private response patch %j", async (patch) => {
	// Arrange
	transport.mockResolvedValue(Response.json({ ...status(), ...patch }));
	// Act
	const result = await read(options);
	// Assert: tuple mismatches cannot expose another device's account.
	expect(result).toMatchObject({ kind: "unavailable", code: "invalid_response" });
	expect(JSON.stringify(result)).not.toMatch(/private response marker|identity-a|other-device/);
});

it.each(["null", "[]", "{}", '{"version":', "not JSON"])(
	"rejects malformed 200 body %s",
	async (body) => {
		// Arrange
		transport.mockResolvedValue(new Response(body));
		// Act
		const result = await read(options);
		// Assert
		expect(result).toMatchObject({ kind: "unavailable", code: "invalid_response" });
	},
);

it("refuses more than 16 KiB while streaming and cancels its reader", async () => {
	// Arrange: no Content-Length, so a header-only limit cannot pass.
	const cancel = vi.fn();
	transport.mockResolvedValue(
		new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(16 * 1024 + 1));
				},
				cancel,
			}),
		),
	);
	// Act
	const result = await read(options);
	// Assert
	expect(result).toMatchObject({ kind: "unavailable", code: "invalid_response" });
	expect(cancel).toHaveBeenCalledOnce();
});
it("accepts fragmented UTF-8 and maximum-length public account labels", async () => {
	// Arrange: split inside a multi-byte character, not just at JSON boundaries.
	const dto = status({ account: { email: "a".repeat(320), displayName: `é${"a".repeat(255)}` } });
	const bytes = new TextEncoder().encode(JSON.stringify(dto));
	const split = bytes.indexOf(0xc3) + 1;
	transport.mockResolvedValue(
		new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(bytes.slice(0, split));
					c.enqueue(bytes.slice(split));
					c.close();
				},
			}),
		),
	);
	// Act
	const result = await read(options);
	// Assert
	expect(result).toEqual({ kind: "status", status: dto });
});
it("rejects invalid UTF-8 even inside otherwise valid public JSON", async () => {
	// Arrange: a non-fatal decoder would silently replace this byte and accept it.
	const bytes = Buffer.from(JSON.stringify(status({ account: { displayName: "x" } })));
	bytes[bytes.indexOf('"x"') + 1] = 0xff;
	transport.mockResolvedValue(new Response(bytes));
	// Act
	const result = await read(options);
	// Assert
	expect(result).toMatchObject({ kind: "unavailable", code: "invalid_response" });
});

it.each(["network", "default fetch"])("redacts %s exceptions and never throws", async (mode) => {
	// Arrange
	const error = new Error("private transport cause");
	transport.mockRejectedValue(error);
	const { fetch: _fetch, ...withoutFetch } = options;
	if (mode === "default fetch") vi.mocked(globalThis.fetch).mockRejectedValue(error);
	// Act
	const result = await read(mode === "default fetch" ? withoutFetch : options);
	// Assert
	expect(result).toMatchObject({ kind: "unavailable", code: "coordinator_unreachable" });
	expect(JSON.stringify(result)).not.toContain("private transport cause");
	if (mode === "default fetch") {
		expect(globalThis.fetch).toHaveBeenCalledOnce();
		vi.mocked(globalThis.fetch).mockClear();
	}
});

it.each(["header timeout", "body timeout", "user abort", "already aborted"])(
	"settles on %s without hanging",
	async (mode) => {
		// Arrange: fake timers drive a fetch/body that never settles by itself.
		vi.useFakeTimers();
		const controller = new AbortController();
		const cancel = vi.fn();
		if (mode === "body timeout")
			transport.mockResolvedValue(new Response(new ReadableStream({ cancel })));
		else transport.mockImplementation(() => new Promise(() => {}));
		if (mode === "already aborted") controller.abort();
		// Act
		const pending = read({ ...options, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		if (mode === "user abort") controller.abort();
		else if (mode !== "already aborted") {
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(9_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
		}
		const result = await pending;
		// Assert
		expect(result).toMatchObject({ kind: "unavailable", code: "coordinator_unreachable" });
		if (mode === "body timeout") expect(cancel).toHaveBeenCalledOnce();
		if (mode === "already aborted") expect(transport).not.toHaveBeenCalled();
		if (mode === "header timeout") expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
	},
);

it.each([
	"missing database",
	"memory database",
	"missing table",
	"empty device",
	"bad fingerprint",
	"bad key",
	"wrong key",
	"rekey before sign",
])("returns device_unavailable for %s without a request or local repair", async (mode) => {
	// Arrange: rollback-journal fixture; mutations belong to setup, never the read under test.
	if (mode === "missing database") options.dbPath = join(dir, "absent.sqlite");
	if (mode === "memory database") options.dbPath = ":memory:";
	if (mode === "missing table") db.exec("DROP TABLE sync_device");
	if (mode === "empty device") db.exec("DELETE FROM sync_device");
	if (mode === "bad fingerprint") db.exec("UPDATE sync_device SET fingerprint='bad'");
	if (mode === "bad key") writeFileSync(join(options.keysDir, "device.key"), "invalid test key");
	if (mode === "wrong key") {
		generateKeypair(join(dir, "other.key"), join(dir, "other.key.pub"));
		writeFileSync(join(options.keysDir, "device.key"), readFileSync(join(dir, "other.key")));
	}
	if (mode === "rekey before sign") {
		const original = localEvidence.readCoordinatorDeviceLocalEvidence;
		vi.spyOn(localEvidence, "readCoordinatorDeviceLocalEvidence").mockImplementationOnce(
			(connection) => {
				const captured = original(connection);
				db.exec("UPDATE sync_device SET device_id='rekeyed-device'");
				return captured;
			},
		);
	}
	const beforeFiles = readdirSync(dir).sort();
	const beforeKeys = readFileSync(join(options.keysDir, "device.key"));
	const beforeBytes = readFileSync(db.name);
	// Act
	const result = await read(options);
	// Assert
	expect(result).toMatchObject({ kind: "unavailable", code: "device_unavailable" });
	expect(transport).not.toHaveBeenCalled();
	expect(readdirSync(dir).sort()).toEqual(beforeFiles);
	expect(readFileSync(join(options.keysDir, "device.key"))).toEqual(beforeKeys);
	if (mode !== "rekey before sign") expect(readFileSync(db.name)).toEqual(beforeBytes);
});
