import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "better-sqlite3";
import {
	readStoreId,
	recordListedCoordinatorPeers,
	storeHasCoordinatorHistory,
} from "./coordinator-history.js";
import { resolveKeyPaths } from "./sync-identity.js";
import { REAL_KEYCHAIN_DISABLED } from "./test-environment-keys.js";

/*
 * Sync without a coordinator needs a positive attestation that this store and its device key
 * were never managed. The attestation lives in the database and in a witness outside it: the
 * OS keychain when the key store is the keychain, otherwise a file in the keys directory. A
 * key is bound to one witness kind when its first store is attested. "Managed" is final for a
 * store and for a key, and goes to every witness before coordinator trust takes effect. Each
 * witness record is created once and never rewritten. A restored database whose witness says
 * managed, is missing, or does not match stays closed for good. A rollback of the database, the
 * keys directory and the keychain together can't be told apart from the device as it was.
 */

export type CoordinatorFreeStatus =
	| "standalone"
	| "unattested"
	| "managed"
	| "attestation_lost"
	| "witness_missing"
	| "witness_mismatch"
	| "witness_mode_mismatch"
	| "key_changed"
	| "no_device_identity";

export const COORDINATOR_FREE_WITNESS_UNAVAILABLE = "coordinator_free_witness_unavailable";
/** An attested store's key binding is missing or damaged, so no witness can be trusted. */
export const COORDINATOR_FREE_BINDING_UNVERIFIED = "coordinator_free_binding_unverified";

interface StoreWitness {
	v: 1;
	store_id: string;
	key_fingerprint: string;
	token: string;
	counter: number;
}

export type WitnessKind = "file" | "keychain";

/** "exists" means another writer created the record first. Nothing here rewrites a record. */
export type WitnessCreateResult = "created" | "exists" | "failed";

/** Where witness records are kept. A created record has reached durable storage. */
export interface WitnessBackend {
	readonly kind: WitnessKind;
	read(name: string): string | null;
	create(name: string, value: string): WitnessCreateResult;
}

export interface AttestationOptions {
	keysDir?: string;
	/** Tests replace the platform keychain. */
	keychain?: WitnessBackend;
}

const KEYCHAIN_SERVICE = "codemem-sync-attestation";

function syncDirectory(directory: string): void {
	const descriptor = openSync(directory, "r");
	try {
		fsyncSync(descriptor);
	} catch (error) {
		// Some platforms can't sync a directory; the record's own data is already synced.
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM") throw error;
	} finally {
		closeSync(descriptor);
	}
}

export function fileWitness(directory: string): WitnessBackend {
	const path = (name: string) => join(directory, `${name}.json`);
	return {
		kind: "file",
		read: (name) => (existsSync(path(name)) ? readFileSync(path(name), "utf8") : null),
		create: (name, value) => {
			try {
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				const descriptor = openSync(path(name), "wx", 0o600);
				try {
					writeSync(descriptor, value);
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				syncDirectory(directory);
				return "created";
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
			}
		},
	};
}

const unavailableKeychain: WitnessBackend = {
	kind: "keychain",
	read: () => null,
	create: () => "failed",
};

type KeychainRunner = (command: string, args: string[], input?: string) => string;

export interface KeychainWitnessOptions {
	/** Holds the lock file that serializes keychain writers on this device. */
	directory: string;
	platform?: NodeJS.Platform;
	run?: KeychainRunner;
	lockTimeoutMs?: number;
}

const KEYCHAIN_LOCK_NAME = "attestation-keychain.lock";
const STALE_KEYCHAIN_LOCK_MS = 30_000;

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `write` while holding a lock file beside the device key, or returns null when the lock
 * can't be taken in time. `secret-tool store` replaces an existing item, so a lookup and a
 * store are one step only while every writer on this device holds this lock.
 */
/** Takes the lock file, clearing one a stopped writer left behind. False when time runs out. */
function takeKeychainLock(path: string, deadline: number): boolean {
	for (;;) {
		try {
			closeSync(openSync(path, "wx", 0o600));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			const heldSince = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
			if (Date.now() - heldSince > STALE_KEYCHAIN_LOCK_MS) rmSync(path, { force: true });
			else if (Date.now() >= deadline) return false;
			else pause(10);
		}
	}
}

function withKeychainLock<T>(directory: string, timeoutMs: number, write: () => T): T | null {
	const path = join(directory, KEYCHAIN_LOCK_NAME);
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	} catch {
		return null;
	}
	if (!takeKeychainLock(path, Date.now() + timeoutMs)) return null;
	try {
		return write();
	} finally {
		rmSync(path, { force: true });
	}
}

/** The keychain the device key uses: `security` on macOS, `secret-tool` on Linux. */
export function keychainWitness(options: KeychainWitnessOptions): WitnessBackend {
	const platform = options.platform ?? process.platform;
	const run: KeychainRunner =
		options.run ??
		((command, args, input) =>
			execFileSync(command, args, { input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8"));
	const read = (name: string): string | null => {
		try {
			if (platform === "darwin")
				return run("security", ["find-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE, "-w"]);
			if (platform === "linux")
				return run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", name]);
		} catch {
			// Not found and unavailable look the same, and both leave the store closed.
		}
		return null;
	};
	const store = (name: string, value: string): void => {
		if (platform === "darwin") {
			// Without -U, the keychain refuses to replace an existing item.
			run("security", ["add-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE, "-w", value]);
			return;
		}
		if (platform !== "linux") throw new Error("keychain_unsupported");
		const label = ["--label", "codemem sync attestation"];
		run("secret-tool", ["store", ...label, "service", KEYCHAIN_SERVICE, "account", name], value);
	};
	const create = (name: string, value: string): WitnessCreateResult => {
		if (read(name) !== null) return "exists";
		try {
			store(name, value);
		} catch {
			return read(name) !== null ? "exists" : "failed";
		}
		return read(name) === value ? "created" : "failed";
	};
	return {
		kind: "keychain",
		read,
		create: (name, value) =>
			withKeychainLock(options.directory, options.lockTimeoutMs ?? 5_000, () =>
				create(name, value),
			) ?? "failed",
	};
}

function platformKeychain(directory: string): WitnessBackend {
	// The test setup turns the real keychain off, so a test can't leave records in it.
	if ((globalThis as Record<symbol, unknown>)[REAL_KEYCHAIN_DISABLED] === true)
		return unavailableKeychain;
	return keychainWitness({ directory });
}

function keysDirectory(keysDir?: string): string {
	const configured = keysDir ?? (process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	return dirname(resolveKeyPaths(configured)[0]);
}

interface Witnesses {
	/** Holds this store's attestation. */
	primary: WitnessBackend;
	/** Takes every managed mark. The file witness is always one of them. */
	all: WitnessBackend[];
	file: WitnessBackend;
}

function witnesses(options: AttestationOptions): Witnesses {
	const directory = keysDirectory(options.keysDir);
	const file = fileWitness(directory);
	if (process.env.CODEMEM_SYNC_KEY_STORE?.toLowerCase() !== "keychain") {
		return { primary: file, all: [file], file };
	}
	const keychain = options.keychain ?? platformKeychain(directory);
	return { primary: keychain, all: [keychain, file], file };
}

/**
 * Every witness a managed mark must reach: the current ones, and the kind the key was bound to
 * at attestation. A process in another mode still marks the bound witness, so switching modes
 * can't hide the mark from a store read back in the bound mode.
 */
function markWitnesses(
	options: AttestationOptions,
	fingerprint: string,
	attested = false,
): WitnessBackend[] {
	const found = witnesses(options);
	if (!fingerprint) return found.all;
	const bound = verifiedBinding(found.file, fingerprint);
	// An attested store's binding names the witness its rollback check reads. Without a
	// verified binding, a mark could miss that witness, so the trust step is refused.
	if (attested && bound === null) throw new Error(COORDINATOR_FREE_BINDING_UNVERIFIED);
	if (bound !== "keychain" || found.all.some((backend) => backend.kind === "keychain"))
		return found.all;
	return [options.keychain ?? platformKeychain(keysDirectory(options.keysDir)), ...found.all];
}

const storeRecordName = (storeId: string) => `attestation-store-${storeId}`;
const storeManagedName = (storeId: string) => `attestation-store-${storeId}-managed`;
const keyHash = (fingerprint: string) =>
	createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
const keyRecordName = (fingerprint: string) => `attestation-key-${keyHash(fingerprint)}`;
const keyBindingName = (fingerprint: string) => `attestation-backend-${keyHash(fingerprint)}`;

function parseStoreWitness(text: string | null): StoreWitness | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text) as Partial<StoreWitness>;
		if (value.v !== 1 || typeof value.token !== "string" || typeof value.store_id !== "string")
			return null;
		return value as StoreWitness;
	} catch {
		return null;
	}
}

/** The witness kind a key was bound to by its first attestation, from the keys directory. */
/** The witness kind a key's binding names, when the record is present, well formed and for this key. */
function verifiedBinding(file: WitnessBackend, fingerprint: string): WitnessKind | null {
	try {
		const value = JSON.parse(file.read(keyBindingName(fingerprint)) ?? "null") as {
			v?: unknown;
			key_fingerprint?: unknown;
			backend?: unknown;
		} | null;
		if (value?.v !== 1 || value.key_fingerprint !== fingerprint) return null;
		return value.backend === "file" || value.backend === "keychain" ? value.backend : null;
	} catch {
		return null;
	}
}

function keyBinding(file: WitnessBackend, fingerprint: string): string | null {
	const text = file.read(keyBindingName(fingerprint));
	if (text === null) return null;
	try {
		const value = JSON.parse(text) as { backend?: unknown } | null;
		return typeof value?.backend === "string" ? value.backend : "unreadable";
	} catch {
		return "unreadable";
	}
}

interface AttestationRow {
	store_id: string;
	key_fingerprint: string;
	state: "standalone" | "managed";
	token: string;
	counter: number;
}

function attestationRow(db: Database): AttestationRow | null {
	return (
		(db
			.prepare(
				"SELECT store_id, key_fingerprint, state, token, counter FROM coordinator_free_attestation WHERE id = 1",
			)
			.get() as AttestationRow | undefined) ?? null
	);
}

function deviceFingerprint(db: Database): string | null {
	const value = db.prepare("SELECT fingerprint FROM sync_device LIMIT 1").pluck().get();
	return typeof value === "string" && value ? value : null;
}

function requireWitness(result: WitnessCreateResult): void {
	if (result === "failed") throw new Error(COORDINATOR_FREE_WITNESS_UNAVAILABLE);
}

/** Stores whose managed records every witness holds, checked in this process. */
const markedThisProcess = new Set<string>();

/**
 * Marks this store and its device key as managed in every witness, then in the database.
 * Coordinator entry points call this before coordinator trust takes effect, and it throws when
 * any witness can't take the mark durably, so the caller refuses the trust step. Runs in a
 * write transaction, so transitions on one store are serialized.
 */
export function markCoordinatorManaged(db: Database, options: AttestationOptions = {}): void {
	const storeId = readStoreId(db);
	const fingerprint = deviceFingerprint(db) ?? "";
	const all = markWitnesses(options, fingerprint, attestationRow(db)?.state === "standalone");
	const memo = [storeId, fingerprint, keysDirectory(options.keysDir), ...all.map((w) => w.kind)];
	if (markedThisProcess.has(memo.join("|")) && attestationRow(db)?.state === "managed") return;
	db.transaction(() => {
		const managed = JSON.stringify({ v: 1, store_id: storeId, state: "managed" });
		const key = JSON.stringify({ v: 1, key_fingerprint: fingerprint, state: "managed" });
		for (const backend of all) {
			requireWitness(backend.create(storeManagedName(storeId), managed));
			if (fingerprint) requireWitness(backend.create(keyRecordName(fingerprint), key));
		}
		const now = new Date().toISOString();
		const updated = db
			.prepare(`UPDATE coordinator_free_attestation SET state = 'managed', key_fingerprint = ?,
				counter = counter + 1, updated_at = ? WHERE id = 1`)
			.run(fingerprint, now);
		if (updated.changes === 0) {
			db.prepare(
				`INSERT INTO coordinator_free_attestation(id, store_id, key_fingerprint, state, token, counter, updated_at)
				 VALUES (1, ?, ?, 'managed', ?, 1, ?)`,
			).run(storeId, fingerprint, randomUUID(), now);
		}
	}).immediate();
	markedThisProcess.add(memo.join("|"));
}

/** A coordinator peer listing: record its devices and mark the store managed, before any trust. */
export function recordCoordinatorListing(
	db: Database,
	peers: Record<string, unknown>[],
	options: AttestationOptions = {},
): void {
	recordListedCoordinatorPeers(db, peers);
	markCoordinatorManaged(db, options);
}

/**
 * Marks the store managed when its database holds coordinator history or a managed record.
 * The witnesses are checked every time until this process has seen them all hold the mark.
 */
export function propagateCoordinatorManaged(db: Database, options: AttestationOptions = {}): void {
	if (attestationRow(db)?.state === "managed" || storeHasCoordinatorHistory(db)) {
		markCoordinatorManaged(db, options);
	}
}

function standaloneRowStatus(
	db: Database,
	row: AttestationRow,
	context: { storeId: string; fingerprint: string; witness: StoreWitness | null },
): CoordinatorFreeStatus {
	if (row.key_fingerprint !== context.fingerprint) return "key_changed";
	if (!context.witness) return "witness_missing";
	const matches =
		context.witness.store_id === context.storeId &&
		row.store_id === context.storeId &&
		context.witness.key_fingerprint === row.key_fingerprint &&
		context.witness.token === row.token &&
		context.witness.counter === row.counter;
	if (!matches) return "witness_mismatch";
	return storeHasCoordinatorHistory(db) ? "managed" : "standalone";
}

function managedByWitness(found: Witnesses, storeId: string, fingerprint: string): boolean {
	return found.all.some(
		(backend) =>
			backend.read(keyRecordName(fingerprint)) !== null ||
			backend.read(storeManagedName(storeId)) !== null,
	);
}

/** Whether a witness, current or bound, durably holds a managed mark for this device's key. */
export function keyHasManagedMark(db: Database, options: AttestationOptions = {}): boolean {
	const fingerprint = deviceFingerprint(db);
	if (!fingerprint) return false;
	return markWitnesses(options, fingerprint).some(
		(backend) => backend.read(keyRecordName(fingerprint)) !== null,
	);
}

/** Whether this store may sync without a coordinator. Only "standalone" allows it. */
export function readCoordinatorFreeStatus(
	db: Database,
	options: AttestationOptions = {},
): CoordinatorFreeStatus {
	const storeId = readStoreId(db);
	const fingerprint = deviceFingerprint(db);
	if (!fingerprint) return "no_device_identity";
	const found = witnesses(options);
	if (managedByWitness(found, storeId, fingerprint)) return "managed";
	const row = attestationRow(db);
	if (row?.state === "managed") return "managed";
	if (row && row.key_fingerprint !== fingerprint) return "key_changed";
	const binding = keyBinding(found.file, fingerprint);
	if (binding !== null && binding !== found.primary.kind) return "witness_mode_mismatch";
	if (!row) {
		// An attested store that lost its database record can't be told from a rollback.
		if (found.all.some((backend) => backend.read(storeRecordName(storeId)) !== null))
			return "attestation_lost";
		return storeHasCoordinatorHistory(db) ? "managed" : "unattested";
	}
	if (binding === null) return "witness_missing";
	const witness = parseStoreWitness(found.primary.read(storeRecordName(storeId)));
	return standaloneRowStatus(db, row, { storeId, fingerprint, witness });
}

/**
 * Attests a store that has never been attested, managed or used with a coordinator. Anything
 * else returns its current status unchanged. Runs in a write transaction, so simultaneous
 * attempts on one store are serialized. The key's witness binding and the store's witness
 * record are created before the database row: a crash in between leaves the store closed.
 */
export function attestCoordinatorFree(
	db: Database,
	options: AttestationOptions = {},
): CoordinatorFreeStatus {
	return db
		.transaction((): CoordinatorFreeStatus => {
			const status = readCoordinatorFreeStatus(db, options);
			if (status !== "unattested") return status;
			const storeId = readStoreId(db);
			const fingerprint = deviceFingerprint(db) ?? "";
			const { primary, file } = witnesses(options);
			const binding = JSON.stringify({ v: 1, key_fingerprint: fingerprint, backend: primary.kind });
			if (file.create(keyBindingName(fingerprint), binding) === "failed") return "witness_missing";
			if (keyBinding(file, fingerprint) !== primary.kind) return "witness_mode_mismatch";
			const record: StoreWitness = {
				v: 1,
				store_id: storeId,
				key_fingerprint: fingerprint,
				token: randomUUID(),
				counter: 1,
			};
			const created = primary.create(storeRecordName(storeId), JSON.stringify(record));
			if (created === "exists") return "attestation_lost";
			if (created === "failed") return "witness_missing";
			db.prepare(
				`INSERT INTO coordinator_free_attestation(id, store_id, key_fingerprint, state, token, counter, updated_at)
				 VALUES (1, ?, ?, 'standalone', ?, 1, ?)`,
			).run(storeId, fingerprint, record.token, new Date().toISOString());
			return readCoordinatorFreeStatus(db, options);
		})
		.immediate();
}
