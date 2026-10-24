import {
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
import * as ordinaryStatus from "./coordinator-account-link-status-client.js";
import * as localEvidence from "./coordinator-device-local.js";
import { readCoordinatorResolvedAccountOwnerStatus as read } from "./coordinator-resolved-account-owner-status-client.js";
import { verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { generateKeypair, loadPublicKey } from "./sync-identity.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));
const ORIGIN = "https://coordinator.example.test";
let dir: string;
let db: Database.Database;
let publicKey: string;
let fingerprint: string;
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
let options: {
	dbPath: string;
	keysDir: string;
	groupId: string;
	coordinatorUrl: string;
	ownerIdentityId: string;
	fetch: typeof fetch;
};
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "resolved-owner-client-"));
	const keysDir = join(dir, "keys");
	mkdirSync(keysDir);
	generateKeypair(join(keysDir, "device.key"), join(keysDir, "device.key.pub"));
	publicKey = loadPublicKey(keysDir) ?? "";
	fingerprint = fingerprintPublicKey(publicKey);
	db = new Database(join(dir, "local.sqlite"));
	db.exec(
		"CREATE TABLE sync_device(device_id, public_key, fingerprint); CREATE TABLE metadata(key,value); INSERT INTO metadata VALUES ('memory_actor','identity-c'); PRAGMA user_version=17;",
	);
	db.prepare("INSERT INTO sync_device VALUES (?,?,?)").run(
		"current-laptop",
		publicKey,
		fingerprint,
	);
	writeFileSync(join(dir, "config.json"), '{"sentinel":"unchanged"}');
	transport = vi.fn<typeof fetch>(async () => Response.json(status()));
	options = {
		dbPath: db.name,
		keysDir,
		groupId: "group-a",
		coordinatorUrl: ORIGIN,
		ownerIdentityId: "identity-a",
		fetch: transport,
	};
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	vi.spyOn(ordinaryStatus, "readCoordinatorAccountLinkStatus");
	vi.spyOn(ordinaryStatus, "readCoordinatorAccountChangeCapabilities");
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(ordinaryStatus.readCoordinatorAccountLinkStatus).not.toHaveBeenCalled();
		expect(ordinaryStatus.readCoordinatorAccountChangeCapabilities).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (db.open) db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
function status(patch: Record<string, unknown> = {}) {
	return {
		version: 1,
		coordinatorId: "coordinator-a",
		groupId: options?.groupId ?? "group-a",
		deviceId: "current-laptop",
		fingerprint,
		state: "owner_confirmed",
		ownerIdentity: "identity-a",
		profileState: "linked",
		profile: {
			displayName: "Synthetic Owner A",
			email: "owner-a@example.test",
			pictureUrl: "https://lh3.googleusercontent.com/synthetic-owner-a",
		},
		...patch,
	};
}
function snapshot() {
	function files(base: string): unknown[] {
		return readdirSync(base)
			.sort()
			.map((name) => {
				const path = join(base, name);
				const stat = statSync(path);
				return [
					name,
					stat.isDirectory() ? files(path) : [readFileSync(path), stat.size, stat.mtimeMs],
				];
			});
	}
	return {
		files: files(dir),
		catalog: db.prepare("SELECT * FROM sqlite_master ORDER BY name").all(),
		version: db.pragma("user_version", { simple: true }),
		device: db.prepare("SELECT * FROM sync_device").all(),
		metadata: db.prepare("SELECT * FROM metadata").all(),
	};
}

it.each([
	{},
	{ profile: {} },
	{ profileState: "account_unlinked", profile: null },
	{ profileState: "unavailable", profile: null },
	{ state: "owner_unconfirmed", ownerIdentity: null, profileState: "unavailable", profile: null },
])("accepts display-only DTO %j with existing C key and no local writes", async (patch) => {
	// Arrange: memory actor C is not remote proof for A; no A private key is required.
	const dto = status(patch);
	transport.mockResolvedValue(Response.json(dto));
	const before = snapshot();
	const readers: Database.Database[] = [];
	const original = localEvidence.readCoordinatorDeviceLocalEvidence;
	vi.spyOn(localEvidence, "readCoordinatorDeviceLocalEvidence").mockImplementation((connection) => {
		expect(connection.readonly).toBe(true);
		readers.push(connection);
		return original(connection);
	});
	// Act
	const result = await read(options);
	// Assert
	expect(result).toEqual({ kind: "owner_status", status: dto });
	expect(snapshot()).toEqual(before);
	expect(transport).toHaveBeenCalledOnce();
	expect(readers.length).toBeGreaterThan(0);
	expect(readers.every((connection) => !connection.open)).toBe(true);
});

it("signs exact selected owner/group/origin and empty GET; tampering breaks proof", async () => {
	// Arrange
	options.groupId = "0";
	options.coordinatorUrl = `${ORIGIN}/`;
	const controller = new AbortController();
	// Act
	const result = await read({ ...options, signal: controller.signal });
	// Assert: independently verify wire proof against the persisted key, not a signer mock.
	expect(result.kind).toBe("owner_status");
	const [input, init] = transport.mock.calls[0];
	const request = new Request(input, init);
	const url = new URL(request.url);
	expect(url.origin).toBe(ORIGIN);
	expect(url.pathname).toBe("/v1/auth/resolved-account-owner-status");
	expect([...url.searchParams.entries()].sort()).toEqual([
		["coordinator_origin", ORIGIN],
		["group_id", "0"],
		["owner_identity_id", "identity-a"],
	]);
	expect(request.method).toBe("GET");
	expect(await request.text()).toBe("");
	expect(init?.redirect).toBe("manual");
	expect(init?.signal).toBeInstanceOf(AbortSignal);
	expect(init?.signal).not.toBe(controller.signal);
	expect(request.headers.get("X-Opencode-Device")).toBe("current-laptop");
	const proof = {
		method: "GET",
		pathWithQuery: url.pathname + url.search,
		bodyBytes: Buffer.alloc(0),
		deviceId: "current-laptop",
		publicKey,
		timestamp: request.headers.get("X-Opencode-Timestamp") ?? "",
		nonce: request.headers.get("X-Opencode-Nonce") ?? "",
		signature: request.headers.get("X-Opencode-Signature") ?? "",
	};
	expect(verifySignature(proof)).toBe(true);
	expect(
		verifySignature({
			...proof,
			pathWithQuery: proof.pathWithQuery.replace(
				"owner_identity_id=identity-a",
				"owner_identity_id=identity-b",
			),
		}),
	).toBe(false);
	expect(
		verifySignature({
			...proof,
			pathWithQuery: proof.pathWithQuery.replace(
				encodeURIComponent(ORIGIN),
				encodeURIComponent("https://other.example.test"),
			),
		}),
	).toBe(false);
	expect(verifySignature({ ...proof, bodyBytes: Buffer.from("not-empty") })).toBe(false);
});

it.each([
	{ version: 2 },
	{ coordinatorId: "" },
	{ coordinatorId: "bad\ncoordinator" },
	{ groupId: "other-group" },
	{ deviceId: "other-device" },
	{ fingerprint: "f".repeat(64) },
	{ ownerIdentity: "identity-b" },
	{ ownerIdentity: null },
	{ state: "owner_unconfirmed", ownerIdentity: null },
	{ state: "owner_unconfirmed", ownerIdentity: null, profileState: "linked", profile: {} },
	{ profileState: "account_unlinked" },
	{ profileState: "unavailable" },
	{ state: "linked" },
	{ profile: null },
	{ authority: "controller_attestation" },
	{ canLink: true },
	{ actions: { refresh: true } },
	{ providerSubject: "private-marker" },
	{ profile: { emailVerified: true, email: "owner-a@example.test" } },
	{ profile: { subject: "private-marker" } },
	{ profile: { displayName: "x".repeat(257) } },
	{ profile: { email: "x".repeat(321) } },
	{ profile: { displayName: "bad\u200bname" } },
	{ profile: { email: null } },
	{ profile: [] },
	{ profile: { pictureUrl: "http://lh3.googleusercontent.com/a" } },
	{ profile: { pictureUrl: "https://user:pass@lh3.googleusercontent.com/a" } },
	{ profile: { pictureUrl: "https://lh3.googleusercontent.com.evil.test/a" } },
	{ profile: { pictureUrl: "https://lh3.googleusercontent.com:8443/a" } },
])("rejects subject/state/authority/private or unsafe DTO patch %j", async (patch) => {
	// Arrange
	transport.mockResolvedValue(Response.json(status(patch)));
	// Act
	const result = await read(options);
	// Assert: no old V2/management fallback can turn rejection into authority.
	expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
	expect(JSON.stringify(result)).not.toMatch(/private-marker|identity-b|owner-a@example.test/);
});

it.each([
	[404, { kind: "unsupported" }],
	[400, { kind: "unavailable", code: "coordinator_incompatible" }],
	[401, { kind: "unavailable", code: "coordinator_rejected" }],
	[403, { kind: "unavailable", code: "coordinator_rejected" }],
	[429, { kind: "unavailable", code: "rate_limited" }],
	[503, { kind: "unavailable", code: "coordinator_unavailable" }],
	[302, { kind: "unavailable", code: "invalid_response" }],
	[204, { kind: "unavailable", code: "invalid_response" }],
] as const)(
	"maps HTTP %s without inferring unlink or exposing error bodies",
	async (http, expected) => {
		// Arrange
		transport.mockResolvedValue(
			new Response(http === 204 ? null : "private upstream cause", { status: http }),
		);
		// Act
		const result = await read(options);
		// Assert
		expect(result).toEqual(expected);
		expect(JSON.stringify(result)).not.toMatch(/private|unlinked|owner_confirmed/);
		expect(transport).toHaveBeenCalledOnce();
	},
);

it("reports schema upgrade header without reading private storage errors", async () => {
	// Arrange
	transport.mockResolvedValue(
		new Response("private schema details", {
			status: 503,
			headers: { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" },
		}),
	);
	// Act
	const result = await read(options);
	// Assert
	expect(result).toEqual({ kind: "unavailable", code: "coordinator_auth_schema_upgrade_required" });
});

it.each(["not JSON", '{"version":', "null", "[]"])(
	"rejects malformed 200 content %s",
	async (body) => {
		// Arrange
		transport.mockResolvedValue(
			new Response(body, { headers: { "content-type": "application/json" } }),
		);
		// Act
		const result = await read(options);
		// Assert
		expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
	},
);

it("accepts fragmented UTF-8 and maximum-length public labels", async () => {
	// Arrange
	const dto = status({ profile: { email: "a".repeat(320), displayName: `é${"a".repeat(255)}` } });
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
			{ headers: { "content-type": "application/json" } },
		),
	);
	// Act
	const result = await read(options);
	// Assert
	expect(result).toEqual({ kind: "owner_status", status: dto });
});

it.each(["oversize-stream", "invalid-utf8"])(
	"rejects %s without trusting Content-Length",
	async (mode) => {
		// Arrange
		const cancel = vi.fn();
		let bytes = Buffer.alloc(16 * 1024 + 1);
		if (mode === "invalid-utf8") {
			bytes = Buffer.from(JSON.stringify(status({ profile: { displayName: "x" } })));
			bytes[bytes.indexOf('"x"') + 1] = 0xff;
		}
		transport.mockResolvedValue(
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(bytes);
						if (mode === "invalid-utf8") c.close();
					},
					cancel,
				}),
				{ headers: { "content-type": "application/json", "content-length": "1" } },
			),
		);
		// Act
		const result = await read(options);
		// Assert
		expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
		if (mode === "oversize-stream") expect(cancel).toHaveBeenCalledOnce();
	},
);

it.each(["header-timeout", "body-timeout", "user-abort", "already-aborted"])(
	"settles %s at 10 seconds or caller abort",
	async (mode) => {
		// Arrange: neither injected transport nor body implements its own abort handling.
		vi.useFakeTimers();
		const controller = new AbortController();
		const cancel = vi.fn();
		if (mode === "body-timeout")
			transport.mockResolvedValue(new Response(new ReadableStream({ cancel })));
		else transport.mockImplementation(() => new Promise(() => {}));
		if (mode === "already-aborted") controller.abort();
		// Act
		const pending = read({ ...options, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		if (mode === "user-abort") controller.abort();
		else if (mode !== "already-aborted") {
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(9999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
		}
		const result = await pending;
		// Assert
		expect(result).toEqual({ kind: "unavailable", code: "coordinator_unreachable" });
		if (mode === "body-timeout") expect(cancel).toHaveBeenCalledOnce();
		if (mode === "already-aborted") expect(transport).not.toHaveBeenCalled();
		if (mode === "header-timeout") expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
	},
);

it("redacts network failure without retrying ordinary account status", async () => {
	// Arrange
	transport.mockRejectedValue(new Error("private transport cause"));
	const before = snapshot();
	// Act
	const result = await read(options);
	// Assert
	expect(result).toEqual({ kind: "unavailable", code: "coordinator_unreachable" });
	expect(snapshot()).toEqual(before);
	expect(transport).toHaveBeenCalledOnce();
});

it.each(["missing-database", "empty-device", "wrong-fingerprint", "wrong-key"])(
	"does not create/repair credentials for %s",
	async (mode) => {
		// Arrange
		if (mode === "missing-database") options.dbPath = join(dir, "absent.sqlite");
		if (mode === "empty-device") db.exec("DELETE FROM sync_device");
		if (mode === "wrong-fingerprint") db.exec("UPDATE sync_device SET fingerprint='bad'");
		if (mode === "wrong-key") {
			generateKeypair(join(dir, "other.key"), join(dir, "other.key.pub"));
			writeFileSync(join(options.keysDir, "device.key"), readFileSync(join(dir, "other.key")));
		}
		const before = snapshot();
		// Act
		const result = await read(options);
		// Assert
		expect(result).toEqual({ kind: "unavailable", code: "device_unavailable" });
		expect(transport).not.toHaveBeenCalled();
		expect(snapshot()).toEqual(before);
	},
);

it.each(["missing-owner", "invalid-owner", "non-origin"])(
	"rejects %s before local device IO",
	async (mode) => {
		// Arrange
		const input = { ...options };
		if (mode === "missing-owner") Object.assign(input, { ownerIdentityId: undefined });
		if (mode === "invalid-owner") input.ownerIdentityId = "bad\nowner";
		if (mode === "non-origin") input.coordinatorUrl = `${ORIGIN}/other`;
		const access = vi.fn(() => {
			throw new Error("private local path");
		});
		Object.defineProperty(input, "dbPath", { get: access });
		// Act
		const result = await read(input);
		// Assert
		expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
		expect(access).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	},
);
