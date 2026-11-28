import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
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

/** The same keychain the device key uses: `security` on macOS, `secret-tool` on Linux. */
function platformKeychain(): WitnessBackend {
	// The test setup turns the real keychain off, so a test can't leave records in it.
	if ((globalThis as Record<symbol, unknown>)[REAL_KEYCHAIN_DISABLED] === true)
		return unavailableKeychain;
	const run = (command: string, args: string[], input?: string) =>
		execFileSync(command, args, { input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
	const read = (name: string): string | null => {
		try {
			if (process.platform === "darwin")
				return run("security", ["find-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE, "-w"]);
			if (process.platform === "linux")
				return run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", name]);
		} catch {
			// Not found and unavailable look the same, and both leave the store closed.
		}
		return null;
	};
	return {
		kind: "keychain",
		read,
		create: (name, value) => {
			if (read(name) !== null) return "exists";
			try {
				if (process.platform === "darwin") {
					// Without -U, the keychain refuses to replace an existing item.
					run("security", [
						"add-generic-password",
						"-a",
						name,
						"-s",
						KEYCHAIN_SERVICE,
						"-w",
						value,
					]);
				} else if (process.platform === "linux") {
					const label = ["--label", "codemem sync attestation"];
					run(
						"secret-tool",
						["store", ...label, "service", KEYCHAIN_SERVICE, "account", name],
						value,
					);
				} else return "failed";
			} catch {
				return read(name) !== null ? "exists" : "failed";
			}
			return read(name) === value ? "created" : "failed";
		},
	};
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
	const file = fileWitness(keysDirectory(options.keysDir));
	if (process.env.CODEMEM_SYNC_KEY_STORE?.toLowerCase() !== "keychain") {
		return { primary: file, all: [file], file };
	}
	const keychain = options.keychain ?? platformKeychain();
	return { primary: keychain, all: [keychain, file], file };
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
	const { all } = witnesses(options);
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
