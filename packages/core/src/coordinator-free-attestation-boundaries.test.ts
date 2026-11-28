import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinatorImportInviteAction } from "./coordinator-actions.js";
import {
	attestCoordinatorFree,
	fileWitness,
	keychainWitness,
	markCoordinatorManaged,
	propagateCoordinatorManaged,
	readCoordinatorFreeStatus,
	type WitnessBackend,
} from "./coordinator-free-attestation.js";
import { encodeInvitePayload } from "./coordinator-invites.js";
import { readCoordinatorSyncConfig, registerCoordinatorPresence } from "./coordinator-runtime.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const WITNESS_UNAVAILABLE = "coordinator_free_witness_unavailable";

let directory: string;
let keysDir: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "coordinator-free-boundaries-"));
	keysDir = join(directory, "keys");
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, "{}");
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
});

afterEach(() => {
	if (existsSync(keysDir)) chmodSync(keysDir, 0o700);
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function openStore(name = "mem") {
	const path = join(directory, `${name}.sqlite`);
	const db = new Database(path);
	initTestSchema(db);
	ensureDeviceIdentity(db, { keysDir });
	return { db, path };
}

function restore(store: { db: Database.Database; path: string }, backup: string) {
	store.db.close();
	copyFileSync(backup, store.path);
	store.db = new Database(store.path);
}

function backupOf(store: { path: string }) {
	const backup = join(directory, "backup.sqlite");
	copyFileSync(store.path, backup);
	return backup;
}

/** A keychain that keeps records in memory and never replaces one. */
function memoryKeychain(onCreate?: () => void): WitnessBackend & { read: WitnessBackend["read"] } {
	const entries = new Map<string, string>();
	return {
		kind: "keychain",
		read: (name) => entries.get(name) ?? null,
		create: (name, value) => {
			onCreate?.();
			if (entries.has(name)) return "exists";
			entries.set(name, value);
			return "created";
		},
		// The reviewed version wrote records in place.
		...({ write: (name: string, value: string) => entries.set(name, value) && true } as object),
	};
}

function fingerprintOf(db: Database.Database) {
	return String(db.prepare("SELECT fingerprint FROM sync_device").pluck().get());
}

/** The name of a key's witness binding record, as the attestation module derives it. */
function bindingName(db: Database.Database) {
	const fingerprint = fingerprintOf(db);
	return `attestation-backend-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

function addCoordinatorHistory(db: Database.Database) {
	db.prepare(
		`INSERT INTO scope_membership_cache_state(coordinator_id, group_id, last_refresh_at, updated_at)
		 VALUES ('https://coord.example.test', 'team-a', 'now', 'now')`,
	).run();
}

describe("a witness that can't take the managed mark refuses the trust step", () => {
	it("refuses while the witness fails, retries until it holds, and then catches a rollback", () => {
		const store = openStore();
		attestCoordinatorFree(store.db, { keysDir });
		const backup = backupOf(store);
		addCoordinatorHistory(store.db);
		chmodSync(keysDir, 0o500);

		expect(() => propagateCoordinatorManaged(store.db, { keysDir })).toThrow(WITNESS_UNAVAILABLE);
		chmodSync(keysDir, 0o700);
		propagateCoordinatorManaged(store.db, { keysDir });
		restore(store, backup);

		expect(readCoordinatorFreeStatus(store.db, { keysDir })).toBe("managed");
		store.db.close();
	});

	it("marks the witness before a scope refresh outside the daemon saves anything", async () => {
		const store = openStore();
		attestCoordinatorFree(store.db, { keysDir });
		const backup = backupOf(store);
		const refresh = () =>
			refreshScopeMembershipCache(store.db, {
				coordinatorId: "https://coord.example.test",
				groupIds: ["team-a"],
				fetchers: {
					listScopes: async () => ({ version: 1, items: [] }),
					getScopeSnapshot: async () => {
						throw new Error("no scopes");
					},
				},
			});

		chmodSync(keysDir, 0o500);
		await expect(refresh()).rejects.toThrow(WITNESS_UNAVAILABLE);
		expect(
			store.db.prepare("SELECT COUNT(*) FROM scope_membership_cache_state").pluck().get(),
		).toBe(0);
		chmodSync(keysDir, 0o700);
		await refresh();
		restore(store, backup);

		expect(readCoordinatorFreeStatus(store.db, { keysDir })).toBe("managed");
		store.db.close();
	});
});

describe("managed records are created once and never replaced", () => {
	it.each(["INSERT OR REPLACE INTO", "REPLACE INTO"])(
		"refuses %s over a managed row",
		(statement) => {
			const { db } = openStore();
			markCoordinatorManaged(db, { keysDir });

			expect(() =>
				db
					.prepare(
						`${statement} coordinator_free_attestation(id, store_id, key_fingerprint, state, token,
					 counter, updated_at) VALUES (1, 's', 'k', 'standalone', 't', 1, 'now')`,
					)
					.run(),
			).toThrow("coordinator_free_attestation_managed");
			expect(db.prepare("SELECT state FROM coordinator_free_attestation").pluck().get()).toBe(
				"managed",
			);
			db.close();
		},
	);

	it("keeps the attestation record unchanged and adds a separate managed record", () => {
		const { db } = openStore();
		attestCoordinatorFree(db, { keysDir });
		const attested = readdirSync(keysDir).find((name) => /^attestation-store-[^-]/u.test(name));
		const before = readFileSync(join(keysDir, String(attested)), "utf8");

		markCoordinatorManaged(db, { keysDir });

		expect(readFileSync(join(keysDir, String(attested)), "utf8")).toBe(before);
		expect(readdirSync(keysDir).some((name) => name.endsWith("-managed.json"))).toBe(true);
		db.close();
	});
});

describe("witness records are created once", () => {
	it("never overwrites a file witness record", () => {
		const witness = fileWitness(join(directory, "witness"));

		expect(witness.create("record", "first")).toBe("created");
		expect(witness.create("record", "second")).toBe("exists");
		expect(witness.read("record")).toBe("first");
	});

	it("marks a new witness location even when the database already says managed", () => {
		const { db } = openStore();
		markCoordinatorManaged(db, { keysDir });
		const otherKeys = join(directory, "other-keys");

		propagateCoordinatorManaged(db, { keysDir: otherKeys });

		expect(readdirSync(otherKeys).filter((name) => name.endsWith("-managed.json"))).toHaveLength(1);
		db.close();
	});
});

describe("attestation is serialized and bound to one witness kind", () => {
	it("serializes simultaneous attestation of one store", () => {
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
		const store = openStore();
		const other = new Database(store.path, { timeout: 20 });
		let inner: unknown = null;
		const keychain = memoryKeychain(() => {
			if (inner !== null) return;
			// Another process attests while this one writes its witness.
			try {
				inner = attestCoordinatorFree(other, { keysDir, keychain });
			} catch (error) {
				inner = error instanceof Error ? error.message : String(error);
			}
		});

		expect(attestCoordinatorFree(store.db, { keysDir, keychain })).toBe("standalone");
		expect(inner).toMatch(/locked|busy/iu);
		expect(attestCoordinatorFree(other, { keysDir, keychain })).toBe("standalone");
		expect(
			store.db.prepare("SELECT COUNT(*) FROM coordinator_free_attestation").pluck().get(),
		).toBe(1);
		other.close();
		store.db.close();
	});

	it("refuses to attest when another witness mode binds the key during the attempt", () => {
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
		const store = openStore();
		const keychain = memoryKeychain();
		const read = keychain.read;
		keychain.read = (name) => {
			// Another process, using file witnesses, binds the key after this one checked.
			if (name.startsWith("attestation-store-") && !name.endsWith("-managed"))
				fileWitness(keysDir).create(
					bindingName(store.db),
					JSON.stringify({ v: 1, key_fingerprint: fingerprintOf(store.db), backend: "file" }),
				);
			return read(name);
		};

		expect(attestCoordinatorFree(store.db, { keysDir, keychain })).toBe("witness_mode_mismatch");
		expect(
			store.db.prepare("SELECT COUNT(*) FROM coordinator_free_attestation").pluck().get(),
		).toBe(0);
		store.db.close();
	});

	it("closes a store read in a different witness mode and refuses to attest the key there", () => {
		const first = openStore("first");
		expect(attestCoordinatorFree(first.db, { keysDir })).toBe("standalone");
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
		const keychain = memoryKeychain();
		const second = openStore("second");

		expect(readCoordinatorFreeStatus(first.db, { keysDir, keychain })).toBe(
			"witness_mode_mismatch",
		);
		expect(attestCoordinatorFree(second.db, { keysDir, keychain })).toBe("witness_mode_mismatch");
		first.db.close();
		second.db.close();
	});
});

describe("joining a coordinator needs confirmation", () => {
	function invite() {
		return encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: "join-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
		});
	}

	it("refuses an unconfirmed join before any request or mark, unless the store is already managed", async () => {
		const path = join(directory, "invite.sqlite");
		const fetchMock = vi.fn(async () => Response.json({ ok: true, status: "enrolled" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			coordinatorImportInviteAction({ inviteValue: invite(), dbPath: path, keysDir }),
		).rejects.toThrow("coordinator_join_confirmation_required");

		expect(fetchMock).not.toHaveBeenCalled();
		const db = new Database(path);
		expect(db.prepare("SELECT COUNT(*) FROM coordinator_history").pluck().get()).toBe(0);
		expect(readdirSync(keysDir).filter((name) => name.startsWith("attestation-"))).toEqual([]);
		// A store that is already managed loses nothing more, so it isn't asked again.
		markCoordinatorManaged(db, { keysDir });
		db.close();
		await coordinatorImportInviteAction({ inviteValue: invite(), dbPath: path, keysDir });
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});

describe("the managed mark follows the key's bound witness", () => {
	it.each(["present", "missing", "malformed"] as const)(
		"keeps a keychain-bound store closed after trust in file mode and a rollback, binding %s",
		(binding) => {
			vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
			const keychain = memoryKeychain();
			const store = openStore();
			expect(attestCoordinatorFree(store.db, { keysDir, keychain })).toBe("standalone");
			const backup = backupOf(store);
			const keysBackup = join(directory, "keys-backup");
			cpSync(keysDir, keysBackup, { recursive: true });
			// The key folder loses or damages its binding record before the mode switch.
			const bindingPath = join(keysDir, `${bindingName(store.db)}.json`);
			if (binding === "missing") rmSync(bindingPath);
			if (binding === "malformed") writeFileSync(bindingPath, "{not json");
			// Coordinator trust is attempted by a process configured for file key storage.
			vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
			const mark = () => markCoordinatorManaged(store.db, { keysDir, keychain });
			if (binding === "present") mark();
			else expect(mark).toThrow("coordinator_free_binding_unverified");

			restore(store, backup);
			rmSync(keysDir, { recursive: true, force: true });
			cpSync(keysBackup, keysDir, { recursive: true });
			vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");

			// Either the mark reached the keychain, or no trust was taken.
			const expected = binding === "present" ? "managed" : "standalone";
			expect(readCoordinatorFreeStatus(store.db, { keysDir, keychain })).toBe(expected);
			store.db.close();
		},
	);

	it("refuses coordinator trust for an attested store whose device key can't be read", () => {
		const store = openStore();
		expect(attestCoordinatorFree(store.db, { keysDir })).toBe("standalone");
		const fingerprint = fingerprintOf(store.db);
		// The device record loses its fingerprint, so the key's binding can't be looked up.
		store.db.prepare("UPDATE sync_device SET fingerprint = ''").run();

		expect(() => markCoordinatorManaged(store.db, { keysDir })).toThrow(
			"coordinator_free_binding_unverified",
		);

		store.db.prepare("UPDATE sync_device SET fingerprint = ?").run(fingerprint);
		expect(readCoordinatorFreeStatus(store.db, { keysDir })).toBe("standalone");
		store.db.close();
	});

	it("refuses the trust step when the bound keychain can't take the mark", () => {
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
		const keychain = memoryKeychain();
		const store = openStore();
		attestCoordinatorFree(store.db, { keysDir, keychain });
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
		const locked: WitnessBackend = {
			kind: "keychain",
			read: keychain.read,
			create: () => "failed",
		};

		expect(() => markCoordinatorManaged(store.db, { keysDir, keychain: locked })).toThrow(
			WITNESS_UNAVAILABLE,
		);
		store.db.close();
	});
});

describe("presence makes the managed mark durable first", () => {
	it("doesn't announce this device when the witness can't take the mark", async () => {
		const store = openStore();
		const fetchMock = vi.fn(async () => Response.json({ ok: true, addresses: [] }));
		vi.stubGlobal("fetch", fetchMock);
		chmodSync(keysDir, 0o500);

		await expect(
			registerCoordinatorPresence(
				{ db: store.db, dbPath: store.path },
				readCoordinatorSyncConfig({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_groups: ["team-a"],
				}),
				{ keysDir },
			),
		).rejects.toThrow(WITNESS_UNAVAILABLE);
		expect(fetchMock).not.toHaveBeenCalled();
		store.db.close();
	});
});

describe("the macOS keychain witness", () => {
	/** `security` as it behaves: `-w` prints the password and then a newline. */
	function securityTool() {
		const items = new Map<string, string>();
		const run = (_command: string, args: string[]) => {
			const account = args[args.indexOf("-a") + 1] ?? "";
			if (args[0] === "find-generic-password") {
				const value = items.get(account);
				if (value === undefined) throw new Error("not found");
				return `${value}\n`;
			}
			if (items.has(account)) throw new Error("already exists");
			items.set(account, args[args.indexOf("-w") + 1] ?? "");
			return "";
		};
		return { items, run };
	}

	it("verifies and reads back a record it created", () => {
		const tool = securityTool();
		const witness = keychainWitness({
			directory: join(directory, "lock"),
			platform: "darwin",
			run: tool.run,
		});

		expect(witness.create("item", '{"v":1}')).toBe("created");
		expect(witness.read("item")).toBe('{"v":1}');
		expect(witness.create("item", '{"v":1}')).toBe("exists");
	});

	it("lets a store with a macOS keychain witness be attested and stay standalone", () => {
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
		const tool = securityTool();
		const keychain = keychainWitness({
			directory: join(directory, "lock"),
			platform: "darwin",
			run: tool.run,
		});
		const store = openStore();

		expect(attestCoordinatorFree(store.db, { keysDir, keychain })).toBe("standalone");
		expect(readCoordinatorFreeStatus(store.db, { keysDir, keychain })).toBe("standalone");
		store.db.close();
	});
});

describe("join confirmation depends on the key's durable mark", () => {
	it("asks before a join from a store with history only, whose key another store attested", async () => {
		const attested = openStore("attested");
		expect(attestCoordinatorFree(attested.db, { keysDir })).toBe("standalone");
		const historyOnly = openStore("history-only");
		addCoordinatorHistory(historyOnly.db);
		historyOnly.db.close();
		const fetchMock = vi.fn(async () => Response.json({ ok: true, status: "enrolled" }));
		vi.stubGlobal("fetch", fetchMock);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: "join-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
		});

		await expect(
			coordinatorImportInviteAction({ inviteValue: invite, dbPath: historyOnly.path, keysDir }),
		).rejects.toThrow("coordinator_join_confirmation_required");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readCoordinatorFreeStatus(attested.db, { keysDir })).toBe("standalone");
		attested.db.close();
	});
});

describe("keychain writers are serialized on this device", () => {
	/** `secret-tool` as it behaves: `store` replaces an existing item. */
	function secretTool(onStore?: () => void) {
		const items = new Map<string, string>();
		const run = (_command: string, args: string[], input?: string) => {
			const account = args[args.indexOf("account") + 1] ?? "";
			if (args[0] === "lookup") {
				const value = items.get(account);
				if (value === undefined) throw new Error("not found");
				return value;
			}
			onStore?.();
			items.set(account, input ?? "");
			return "";
		};
		return { items, run };
	}

	it("lets only one of two competing writers create an item", () => {
		let competitor: string | null = null;
		const lockDirectory = join(directory, "lock");
		const tool = secretTool(() => {
			if (competitor !== null) return;
			// Another process on this device writes the same item at the same moment.
			const other = keychainWitness({
				directory: lockDirectory,
				platform: "linux",
				run: tool.run,
				lockTimeoutMs: 20,
			});
			competitor = other.create("item", "second");
		});
		const first = keychainWitness({ directory: lockDirectory, platform: "linux", run: tool.run });

		expect(first.create("item", "first")).toBe("created");
		expect(competitor).toBe("failed");
		expect(first.create("item", "third")).toBe("exists");
		expect(tool.items.get("item")).toBe("first");
	});
});
