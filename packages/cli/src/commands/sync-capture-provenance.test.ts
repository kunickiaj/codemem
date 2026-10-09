import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeviceIdentity, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncCommand } from "./sync.js";

let dir: string;
let store: MemoryStore;
let exitCode: typeof process.exitCode;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-cli-capture-"));
	exitCode = process.exitCode;
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(dir, "keys"));
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	vi.stubEnv("CODEMEM_ACTOR_ID", undefined);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(MemoryStore.prototype, "enqueueVectorWrite").mockImplementation(() => {});
});

it("sync enable cannot adopt pending capture with another database's identity and no matching private key", async () => {
	// Arrange: explicit copied-metadata corruption uses a genuine key from another database.
	const dbPath = join(dir, "memory.sqlite");
	store = new MemoryStore(dbPath, { keysDir: join(dir, "keys") });
	const session = store.startSession({ cwd: "/fixture/pending", project: "pending" });
	const id = store.remember(session, "discovery", "Pending original", "Preserved original body");
	const other = new MemoryStore(":memory:");
	try {
		ensureDeviceIdentity(other.db, {
			keysDir: join(dir, "unrelated-keys"),
			deviceId: "unrelated-device",
		});
		const tuple = other.db.prepare("SELECT * FROM sync_device").get() as {
			device_id: string;
			public_key: string;
			fingerprint: string;
			created_at: string;
		};
		store.db
			.prepare(
				"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(tuple.device_id, tuple.public_key, tuple.fingerprint, tuple.created_at);
	} finally {
		other.close();
	}
	const original = store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id);
	store.close();
	// Act: the CLI must validate actual private material rather than accepting the copied tuple.
	await syncCommand.parseAsync(
		["enable", "--db-path", dbPath, "--config", join(dir, "config.json"), "--json"],
		{ from: "user" },
	);
	store = new MemoryStore(dbPath, { keysDir: join(dir, "keys") });
	// Assert: failed enrollment preserves history and cannot publish an association.
	expect(console.log).toHaveBeenCalledWith(
		expect.stringContaining("device_identity_private_key_missing"),
	);
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_local_capture_adoption").pluck().get()).toBe(
		0,
	);
	expect(store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id)).toEqual(original);
});

afterEach(() => {
	store?.close();
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

it.each(["fallback", "configured"])(
	"sync enable persists pending capture adoption for %s actor without viewer startup",
	async (actor) => {
		// Arrange: ordinary writer captures history before any signing enrollment.
		const dbPath = join(dir, "memory.sqlite");
		const configPath = join(dir, "config.json");
		if (actor === "configured")
			writeFileSync(configPath, JSON.stringify({ actor_id: "configured-owner" }));
		store = new MemoryStore(dbPath, { keysDir: join(dir, "keys") });
		const session = store.startSession({ cwd: "/fixture/pending", project: "pending" });
		const now = "2026-09-21T12:00:00.000Z";
		store.db
			.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		group_id, membership_epoch, status, created_at, updated_at)
		VALUES ('pending-history', 'Pending history', 'team', 'coordinator', 'fixture-coordinator', 'fixture-group', 1, 'active', ?, ?)`)
			.run(now, now);
		store.db
			.prepare(`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, created_at, updated_at)
		VALUES ('/fixture/pending', '/fixture/pending', 'pending-history', ?, ?)`)
			.run(now, now);
		const id = store.remember(session, "discovery", "Pending CLI capture", "Original local body");
		const proof = store.db.prepare("SELECT * FROM memory_source_bindings").all();
		expect(store.get(id)?.id).toBe(id);
		store.close();
		// Act: use the actual CLI enrollment caller, which does not start a viewer.
		await syncCommand.parseAsync(
			["enable", "--db-path", dbPath, "--config", configPath, "--json"],
			{ from: "user" },
		);
		store = new MemoryStore(dbPath, { keysDir: join(dir, "keys") });
		// Assert: enrollment writes the association; reopening only consumes saved facts.
		expect(
			store.db.prepare("SELECT COUNT(*) FROM memory_local_capture_adoption").pluck().get(),
		).toBe(1);
		expect(store.db.prepare("SELECT * FROM memory_source_bindings").all()).toEqual(proof);
		expect(store.get(id)?.body_text).toBe("Original local body");
		expect(store.isScopeWritable("pending-history")).toBe(false);
		if (actor === "configured") expect(store.actorId).toBe("configured-owner");
	},
);
