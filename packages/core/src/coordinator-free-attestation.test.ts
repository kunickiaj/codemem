import {
	copyFileSync,
	cpSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinatorImportInviteAction } from "./coordinator-actions.js";
import {
	attestCoordinatorFree,
	markCoordinatorManaged,
	readCoordinatorFreeStatus,
	type WitnessBackend,
} from "./coordinator-free-attestation.js";
import { encodeInvitePayload } from "./coordinator-invites.js";
import { lookupCoordinatorPeers, readCoordinatorSyncConfig } from "./coordinator-runtime.js";
import { refreshCoordinatorForDaemon } from "./sync-daemon.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

let directory: string;
let keysDir: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "coordinator-free-attestation-"));
	keysDir = join(directory, "keys");
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, "{}");
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	for (const name of ["URL", "GROUP", "GROUPS", "ADMIN_SECRET"]) {
		vi.stubEnv(`CODEMEM_SYNC_COORDINATOR_${name}`, undefined);
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function openStore(name = "mem", keys = keysDir) {
	const path = join(directory, `${name}.sqlite`);
	const db = new Database(path);
	initTestSchema(db);
	ensureDeviceIdentity(db, { keysDir: keys });
	return { db, path };
}

/** A keychain that keeps records in memory and, like the real one, never replaces a record. */
function memoryKeychain(): WitnessBackend & { entries: Map<string, string> } {
	const entries = new Map<string, string>();
	return {
		kind: "keychain",
		entries,
		read: (name) => entries.get(name) ?? null,
		create: (name, value) => {
			if (entries.has(name)) return "exists";
			entries.set(name, value);
			return "created";
		},
	};
}

/** Replaces the database with an earlier copy, as restoring a backup does. */
function restore(store: { db: Database.Database; path: string }, backup: string) {
	store.db.close();
	copyFileSync(backup, store.path);
	store.db = new Database(store.path);
}

function witnessFiles(dir = keysDir) {
	return readdirSync(dir).filter((name) => name.startsWith("attestation-"));
}

/** Which managed records the file witness holds. */
function managedRecords() {
	return witnessFiles()
		.flatMap((name) => {
			if (name.startsWith("attestation-key-")) return ["key"];
			return name.endsWith("-managed.json") ? ["store"] : [];
		})
		.sort();
}

describe("attesting a store that never used a coordinator", () => {
	it("attests once, keeps the witness private, and reads back as standalone", () => {
		const { db } = openStore();

		expect(readCoordinatorFreeStatus(db, { keysDir })).toBe("unattested");
		expect(attestCoordinatorFree(db, { keysDir })).toBe("standalone");
		expect(attestCoordinatorFree(db, { keysDir })).toBe("standalone");

		expect(witnessFiles()).toHaveLength(2);
		for (const witness of witnessFiles())
			expect(statSync(join(keysDir, witness)).mode & 0o777).toBe(0o600);
		db.close();
	});

	it("refuses a store with coordinator history", () => {
		const { db } = openStore();
		db.prepare(
			`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
			 membership_epoch, status, created_at, updated_at)
			 VALUES ('team', 'team', 'team', 'coordinator', 'https://coord.example.test', 1, 'active', 'now', 'now')`,
		).run();

		expect(attestCoordinatorFree(db, { keysDir })).toBe("managed");
		expect(witnessFiles()).toEqual([]);
		db.close();
	});

	it("closes an attested store as soon as coordinator history appears", () => {
		const { db } = openStore();
		attestCoordinatorFree(db, { keysDir });
		db.prepare(
			`INSERT INTO scope_membership_cache_state(coordinator_id, group_id, last_refresh_at, updated_at)
			 VALUES ('https://coord.example.test', 'team-a', 'now', 'now')`,
		).run();

		expect(readCoordinatorFreeStatus(db, { keysDir })).toBe("managed");
		db.close();
	});

	it("keeps managed final in the database", () => {
		const { db } = openStore();
		attestCoordinatorFree(db, { keysDir });
		markCoordinatorManaged(db, { keysDir });

		expect(() =>
			db.prepare("UPDATE coordinator_free_attestation SET state = 'standalone'").run(),
		).toThrow("coordinator_free_attestation_managed");
		expect(() => db.prepare("DELETE FROM coordinator_free_attestation").run()).toThrow(
			"coordinator_free_attestation_kept",
		);
		expect(attestCoordinatorFree(db, { keysDir })).toBe("managed");
		db.close();
	});

	it("closes a store whose device key changed after attestation", () => {
		const { db } = openStore();
		attestCoordinatorFree(db, { keysDir });
		db.prepare("UPDATE sync_device SET fingerprint = 'other-key'").run();

		expect(readCoordinatorFreeStatus(db, { keysDir })).toBe("key_changed");
		db.close();
	});
});

describe("a managed key closes every store that uses it", () => {
	it("closes a second store sharing the keys directory once the first is managed", () => {
		const first = openStore("first");
		const second = openStore("second");
		expect(attestCoordinatorFree(first.db, { keysDir })).toBe("standalone");
		expect(attestCoordinatorFree(second.db, { keysDir })).toBe("standalone");

		markCoordinatorManaged(first.db, { keysDir });

		expect(readCoordinatorFreeStatus(second.db, { keysDir })).toBe("managed");
		expect(attestCoordinatorFree(openStore("third").db, { keysDir })).toBe("managed");
		first.db.close();
		second.db.close();
	});

	it("keeps a key managed in the keychain after its key files are lost", () => {
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
		const keychain = memoryKeychain();
		const first = openStore("first");
		markCoordinatorManaged(first.db, { keysDir, keychain });
		const fingerprint = first.db.prepare("SELECT fingerprint FROM sync_device").pluck().get();
		rmSync(keysDir, { recursive: true, force: true });

		// A new store recovering the same key from the keychain.
		const second = new Database(join(directory, "second.sqlite"));
		initTestSchema(second);
		second
			.prepare(
				"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('d', 'k', ?, 'now')",
			)
			.run(fingerprint);

		expect(readCoordinatorFreeStatus(second, { keysDir, keychain })).toBe("managed");
		first.db.close();
		second.close();
	});
});

describe("lost markers and rollbacks keep the store closed", () => {
	it("refuses to attest again when the database loses its record", () => {
		const store = openStore();
		const backup = join(directory, "before-attestation.sqlite");
		copyFileSync(store.path, backup);
		attestCoordinatorFree(store.db, { keysDir });

		restore(store, backup);

		expect(readCoordinatorFreeStatus(store.db, { keysDir })).toBe("attestation_lost");
		expect(attestCoordinatorFree(store.db, { keysDir })).toBe("attestation_lost");
		store.db.close();
	});

	it("closes a store whose witness is missing or altered", () => {
		const { db } = openStore();
		attestCoordinatorFree(db, { keysDir });
		const witness = witnessFiles().find((name) => name.startsWith("attestation-store-"));
		const path = join(keysDir, String(witness));
		const record = JSON.parse(readFileSync(path, "utf8"));

		writeFileSync(path, JSON.stringify({ ...record, token: "forged" }));
		expect(readCoordinatorFreeStatus(db, { keysDir })).toBe("witness_mismatch");
		rmSync(path);
		expect(readCoordinatorFreeStatus(db, { keysDir })).toBe("witness_missing");
		expect(attestCoordinatorFree(db, { keysDir })).toBe("witness_missing");
		db.close();
	});

	it("catches a database restored from before management", () => {
		const store = openStore();
		attestCoordinatorFree(store.db, { keysDir });
		const backup = join(directory, "attested.sqlite");
		copyFileSync(store.path, backup);
		markCoordinatorManaged(store.db, { keysDir });

		restore(store, backup);

		expect(readCoordinatorFreeStatus(store.db, { keysDir })).toBe("managed");
		store.db.close();
	});

	it("keeps a restored database closed by the store record when the key record is gone", () => {
		const store = openStore();
		attestCoordinatorFree(store.db, { keysDir });
		const backup = join(directory, "attested.sqlite");
		copyFileSync(store.path, backup);
		markCoordinatorManaged(store.db, { keysDir });
		for (const name of witnessFiles().filter((file) => file.startsWith("attestation-key-")))
			rmSync(join(keysDir, name));

		restore(store, backup);

		expect(readCoordinatorFreeStatus(store.db, { keysDir })).toBe("managed");
		store.db.close();
	});

	it("catches a rollback of the database and key files when the keychain was not rolled back", () => {
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
		const keychain = memoryKeychain();
		const store = openStore();
		attestCoordinatorFree(store.db, { keysDir, keychain });
		const backup = join(directory, "attested.sqlite");
		copyFileSync(store.path, backup);
		const keysBackup = join(directory, "keys-backup");
		cpSync(keysDir, keysBackup, { recursive: true });
		markCoordinatorManaged(store.db, { keysDir, keychain });

		restore(store, backup);
		rmSync(keysDir, { recursive: true, force: true });
		cpSync(keysBackup, keysDir, { recursive: true });

		expect(readCoordinatorFreeStatus(store.db, { keysDir, keychain })).toBe("managed");
		store.db.close();
	});

	it("can't catch a rollback of the database and a file key store together", () => {
		// The stated limit: nothing outside the restored files remembers the managed state.
		const store = openStore();
		attestCoordinatorFree(store.db, { keysDir });
		const backup = join(directory, "attested.sqlite");
		copyFileSync(store.path, backup);
		const keysBackup = join(directory, "keys-backup");
		cpSync(keysDir, keysBackup, { recursive: true });
		markCoordinatorManaged(store.db, { keysDir });

		restore(store, backup);
		rmSync(keysDir, { recursive: true, force: true });
		cpSync(keysBackup, keysDir, { recursive: true });

		expect(readCoordinatorFreeStatus(store.db, { keysDir })).toBe("standalone");
		store.db.close();
	});
});

describe("coordinator entry points mark the store managed first", () => {
	it("marks the store managed when a coordinator lists its peers", async () => {
		const { db, path } = openStore();
		attestCoordinatorFree(db, { keysDir });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ items: [] })),
		);

		await lookupCoordinatorPeers(
			{ db, dbPath: path },
			readCoordinatorSyncConfig({
				sync_coordinator_url: "https://coord.example.test",
				sync_coordinator_groups: ["team-a"],
			}),
			{ keysDir },
		);

		expect(managedRecords()).toEqual(["key", "store"]);
		expect(readCoordinatorFreeStatus(db, { keysDir })).toBe("managed");
		db.close();
	});

	it("marks the store managed when a refresh sees coordinator settings", async () => {
		const { db, path } = openStore();
		attestCoordinatorFree(db, { keysDir });
		vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", "team-a");

		await refreshCoordinatorForDaemon(db, path, keysDir);

		expect(managedRecords()).toEqual(["key", "store"]);
		expect(readCoordinatorFreeStatus(db, { keysDir })).toBe("managed");
		db.close();
	});

	it("marks the store managed before a signed invitation join, even a refused one", async () => {
		const path = join(directory, "invite.sqlite");
		const statuses: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const db = new Database(path, { readonly: true });
				statuses.push(readCoordinatorFreeStatus(db, { keysDir }));
				db.close();
				return Response.json({ error: "invite_expired" }, { status: 410 });
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: "expired-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
			operation_id: `share_${"a".repeat(40)}`,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: path,
				keysDir,
				confirmCoordinatorJoin: true,
			}),
		).rejects.toThrow("invite_expired");

		expect(statuses).toEqual(["managed"]);
	});
});
