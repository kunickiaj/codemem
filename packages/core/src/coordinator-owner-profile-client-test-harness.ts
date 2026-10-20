import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { afterEach, beforeEach, expect, vi } from "vitest";
import * as enrollmentReceiver from "./coordinator-account-link-receiver.js";
import {
	enrollOwnerProfile,
	type OwnerProfileClientOptions,
} from "./coordinator-owner-profile-client.js";
import {
	recordForeignMemoryRevision,
	recordLocalCreationSnapshot,
} from "./memory-creation-provenance.js";
import {
	allocateLocalCaptureMemorySource,
	allocateLocalMemorySource,
} from "./memory-source-identity.js";
import { fingerprintPublicKey, generateKeypair, loadPublicKey } from "./sync-identity.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

let signing: { corrupt: boolean };
let databaseOpens: Array<{ readonly?: boolean }>;
let assertOffline: (() => void) | undefined;

// Each test file owns hoisted mocks; the isolated fixture only receives their per-file state.
export function registerOwnerProfileClientMockState(state: {
	signing: { corrupt: boolean };
	databaseOpens: Array<{ readonly?: boolean }>;
	assertOffline?: () => void;
}): void {
	signing = state.signing;
	databaseOpens = state.databaseOpens;
	assertOffline = state.assertOffline;
}

const pin = {
	coordinatorId: "coordinator",
	origin: "https://coordinator.example",
	issuer: "https://accounts.google.com",
	revision: "b".repeat(64),
};
const received = {
	kind: "finalized",
	bindingId: "binding",
	identityId: "identity",
	groups: ["group"],
};
const now = "2026-10-12T12:00:00Z";
let directory: string;
let db: Sqlite.Database;
let options: OwnerProfileClientOptions;
let publicKey: string;
let loopback = "";
let attemptId = "";
let failFinal = false;
let finalBodies: string[];
let calls: Array<{ path: string; authorization: string | null }>;
const read = (name: string) => JSON.parse(readFileSync(join(options.stateDir, name), "utf8"));
const facts = () => ({
	memories: db.prepare("SELECT * FROM memory_items").all(),
	bindings: db.prepare("SELECT * FROM memory_source_bindings").all(),
	history: db.prepare("SELECT * FROM replication_ops").all(),
	captureBirth: db.prepare("SELECT * FROM memory_local_capture").all(),
	creationSnapshots: db.prepare("SELECT * FROM memory_local_creation_snapshots").all(),
	foreignRevisions: db.prepare("SELECT * FROM memory_foreign_revisions").all(),
});
function insertMemory(input: { actorId: string; entityId: string }): void {
	const sessionId = insertTestSession(db);
	db.prepare(
		"INSERT INTO memory_items(session_id, kind, title, body_text, actor_id, import_key, metadata_json, created_at, updated_at) VALUES (?, 'discovery', 'History', 'Keep this text', ?, ?, '{}', ?, ?)",
	).run(sessionId, input.actorId, input.entityId, now, now);
}
function seedOwnCapture(): void {
	db.transaction(() => {
		// Capture predates the signed device. Its identity remains immutable.
		const source = allocateLocalCaptureMemorySource(db, "local");
		if (!source) throw new Error("fixture capture unavailable");
		insertMemory({ actorId: "local:local", entityId: source.entityId });
		const memoryId = Number(
			db.prepare("SELECT id FROM memory_items WHERE import_key = ?").pluck().get(source.entityId),
		);
		recordLocalCreationSnapshot(db, memoryId);
	})();
}
function rotateKey(): void {
	const privatePath = join(options.keysDir, "replacement.key");
	const publicPath = join(options.keysDir, "replacement.key.pub");
	generateKeypair(privatePath, publicPath);
	writeFileSync(join(options.keysDir, "device.key"), readFileSync(privatePath));
	writeFileSync(join(options.keysDir, "device.key.pub"), readFileSync(publicPath));
}
async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const path = new URL(String(input)).pathname;
	calls.push({ path, authorization: new Headers(init?.headers).get("Authorization") });
	if (path === "/v1/auth/owner-config") return Response.json(pin);
	if (path === "/v1/auth/owner-attempts") {
		const start = JSON.parse(String(init?.body));
		expect(start).toEqual(read("capability-request.json").start);
		loopback = start.loopbackRedirect;
		attemptId = start.attemptId;
		return Response.json({ kind: "started", attemptId, expiresAtMs: Date.now() + 60000 });
	}
	if (path !== "/v1/auth/owner-attempts/finalize") throw new Error("unexpected request");
	const body = String(init?.body);
	expect(read("final.json").body).toBe(body);
	finalBodies.push(body);
	if (failFinal) throw new Error("ambiguous transport failure with credential text");
	return Response.json(received);
}
function browser(): Promise<void> {
	const url = new URL(loopback);
	url.search = new URLSearchParams({
		attempt_id: attemptId,
		completion: Buffer.alloc(32, 4).toString("base64url"),
		confirmation: "a".repeat(64),
	}).toString();
	return new Promise((resolve, reject) => {
		const request = get(url, (response) => {
			response.resume();
			response.once("end", () => {
				if (response.statusCode === 200) resolve();
				else reject(new Error("loopback failed"));
			});
		});
		request.once("error", reject);
	});
}
beforeEach(() => {
	signing.corrupt = false;
	directory = mkdtempSync(join(tmpdir(), "owner-profile-test-"));
	options = {
		dbPath: join(directory, "memory.sqlite"),
		configPath: join(directory, "config.json"),
		keysDir: join(directory, "keys"),
		stateDir: join(directory, "enrollment"),
		groupId: "group",
		coordinatorUrl: pin.origin,
		mode: "prepare",
		fetch: fakeFetch,
		onBrowserStart: browser,
	};
	for (const name of [
		"CODEMEM_ACTOR_ID",
		"CODEMEM_DEVICE_ID",
		"CODEMEM_ACTOR_DISPLAY_NAME",
		"CODEMEM_CONFIG",
		"CODEMEM_DB",
		"CODEMEM_KEYS_DIR",
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_SYNC_COORDINATOR_GROUPS",
		"CODEMEM_WORKSPACE_ID",
	])
		vi.stubEnv(name, undefined);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
	seedProfile();
	finalBodies = [];
	calls = [];
	failFinal = false;
});

function seedProfile(): void {
	mkdirSync(options.keysDir, { mode: 0o700 });
	generateKeypair(join(options.keysDir, "device.key"), join(options.keysDir, "device.key.pub"));
	publicKey = loadPublicKey(options.keysDir) ?? "";
	db = new Sqlite(options.dbPath);
	initTestSchema(db);
	db.prepare(
		"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES ('local:local', 'Original', 1, 'active', ?, ?)",
	).run(now, now);
	seedOwnCapture();
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('device', ?, ?, ?)",
	).run(publicKey, fingerprintPublicKey(publicKey), now);
	// Imported rows retain negative provenance but never become local adoption authority.
	db.transaction(() => {
		const source = allocateLocalMemorySource(db);
		insertMemory({ actorId: "foreign", entityId: source.entityId });
		const memoryId = Number(
			db.prepare("SELECT id FROM memory_items WHERE import_key = ?").pluck().get(source.entityId),
		);
		recordLocalCreationSnapshot(db, memoryId);
		recordForeignMemoryRevision(db, source.entityId, "replication");
	})();
	db.prepare(
		"UPDATE memory_items SET rev = 98, origin_device_id = 'foreign-writer' WHERE actor_id = 'local:local'",
	).run();
	db.prepare(
		"INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at) SELECT 'history', 'memory', import_key, 'upsert', '{\"actor_id\":\"foreign\"}', 98, ?, 'foreign-writer', 'foreign-writer', ? FROM memory_items WHERE actor_id = 'foreign'",
	).run(now, now);
	writeFileSync(
		options.configPath,
		JSON.stringify({ actor_id: "local:local", unrelated: { nested: [1, { keep: true }] } }),
		{ mode: 0o600 },
	);
}
afterEach(() => {
	if (assertOffline) assertOffline();
	else expect(globalThis.fetch).not.toHaveBeenCalled();
	db.close();
	rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
async function prepared(): Promise<string> {
	const result = await enrollOwnerProfile(options);
	if (result.kind !== "prepared") throw new Error("expected review");
	expect(result.review.localMemoryCount).toBe(1);
	expect(result.review.retainedForeignMemoryCount).toBe(1);
	options = {
		...options,
		mode: "resume",
		reviewedDigest: result.reviewDigest,
		capability: "explicit-admin-capability",
	};
	return result.reviewDigest;
}
async function interruptedPrepare() {
	// Use a fixed private loopback destination without opening a server for these prepare fixtures.
	const receiver = vi.spyOn(enrollmentReceiver, "createCoordinatorOwnerEnrollmentReceiver");
	receiver.mockResolvedValue({
		destination: "http://127.0.0.1:43127/owner/callback",
		close: vi.fn().mockResolvedValue(undefined),
		completion: Promise.resolve({ completionSecret: "unused", confirmationHash: "unused" }),
	});
	const realLink = fs.linkSync;
	const publication = vi.spyOn(fs, "linkSync").mockImplementation((temporary, canonical) => {
		if (canonical === join(options.stateDir, "capability-request.json"))
			throw Object.assign(new Error("capability request publication interrupted"), { code: "EIO" });
		realLink(temporary, canonical);
	});
	await expect(enrollOwnerProfile(options)).rejects.toThrow();
	publication.mockRestore();
	expect(existsSync(join(options.stateDir, "prepared.json"))).toBe(true);
	expect(existsSync(join(options.stateDir, "capability-request.json"))).toBe(false);
	receiver.mockClear();
	calls = [];
	databaseOpens.length = 0;
	return receiver;
}

// Vitest isolates this module for each importing test file; hooks recreate the private profile per test.
export const fixture: {
	readonly directory: string;
	readonly db: Sqlite.Database;
	options: OwnerProfileClientOptions;
	readonly publicKey: string;
	calls: Array<{ path: string; authorization: string | null }>;
	readonly finalBodies: string[];
	failFinal: boolean;
} = {
	get directory() {
		return directory;
	},
	get db() {
		return db;
	},
	get options() {
		return options;
	},
	set options(value: OwnerProfileClientOptions) {
		options = value;
	},
	get publicKey() {
		return publicKey;
	},
	get calls() {
		return calls;
	},
	set calls(value: Array<{ path: string; authorization: string | null }>) {
		calls = value;
	},
	get finalBodies() {
		return finalBodies;
	},
	get failFinal() {
		return failFinal;
	},
	set failFinal(value: boolean) {
		failFinal = value;
	},
};
export {
	browser,
	facts,
	fakeFetch,
	insertMemory,
	interruptedPrepare,
	now,
	pin,
	prepared,
	read,
	received,
	rotateKey,
};
