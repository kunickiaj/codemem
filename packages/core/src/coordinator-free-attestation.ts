import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "better-sqlite3";
import {
	readStoreId,
	recordListedCoordinatorPeers,
	storeHasCoordinatorHistory,
} from "./coordinator-history.js";
import { resolveKeyPaths } from "./sync-identity.js";

/*
 * Sync without a coordinator needs a positive attestation that this store and its device key
 * were never managed. The attestation lives in the database and in a witness outside it: the
 * OS keychain when the key store is the keychain, otherwise a file in the keys directory.
 * "Managed" is final for a store and for a key. A restored database whose witness says managed,
 * is missing, or does not match stays closed for good. A rollback of the database, the keys
 * directory and the keychain together can't be told apart from the device as it was.
 */

export type CoordinatorFreeStatus =
	| "standalone"
	| "unattested"
	| "managed"
	| "attestation_lost"
	| "witness_missing"
	| "witness_mismatch"
	| "key_changed"
	| "no_device_identity";

interface StoreWitness {
	v: 1;
	store_id: string;
	key_fingerprint: string;
	state: "standalone" | "managed";
	token: string;
	counter: number;
}

/** Where witness records are kept. Writes return false when the store is unavailable. */
export interface WitnessBackend {
	read(name: string): string | null;
	write(name: string, value: string): boolean;
}

export interface AttestationOptions {
	keysDir?: string;
	/** Tests replace the platform keychain. */
	keychain?: WitnessBackend;
}

const KEYCHAIN_SERVICE = "codemem-sync-attestation";

export function fileWitness(directory: string): WitnessBackend {
	const path = (name: string) => join(directory, `${name}.json`);
	return {
		read: (name) => (existsSync(path(name)) ? readFileSync(path(name), "utf8") : null),
		write: (name, value) => {
			try {
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				const temporary = `${path(name)}.${process.pid}.tmp`;
				writeFileSync(temporary, value, { mode: 0o600 });
				chmodSync(temporary, 0o600);
				renameSync(temporary, path(name));
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** The same keychain the device key uses: `security` on macOS, `secret-tool` on Linux. */
function platformKeychain(): WitnessBackend {
	const run = (command: string, args: string[], input?: string) =>
		execFileSync(command, args, { input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
	return {
		read: (name) => {
			try {
				if (process.platform === "darwin")
					return run("security", [
						"find-generic-password",
						"-a",
						name,
						"-s",
						KEYCHAIN_SERVICE,
						"-w",
					]);
				if (process.platform === "linux")
					return run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", name]);
			} catch {
				// Not found and unavailable look the same, and both leave the store closed.
			}
			return null;
		},
		write: (name, value) => {
			try {
				if (process.platform === "darwin") {
					run("security", [
						"add-generic-password",
						"-a",
						name,
						"-s",
						KEYCHAIN_SERVICE,
						"-w",
						value,
						"-U",
					]);
					return true;
				}
				if (process.platform === "linux") {
					const args = [
						"store",
						"--label",
						"codemem sync attestation",
						"service",
						KEYCHAIN_SERVICE,
					];
					run("secret-tool", [...args, "account", name], value);
					return true;
				}
			} catch {
				// Reported to the caller as a failed write.
			}
			return false;
		},
	};
}

function keysDirectory(keysDir?: string): string {
	const configured = keysDir ?? (process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	return dirname(resolveKeyPaths(configured)[0]);
}

/** The witness the attestation relies on, and every witness a managed mark goes to. */
function witnesses(options: AttestationOptions): {
	primary: WitnessBackend;
	all: WitnessBackend[];
} {
	const file = fileWitness(keysDirectory(options.keysDir));
	if (process.env.CODEMEM_SYNC_KEY_STORE?.toLowerCase() !== "keychain") {
		return { primary: file, all: [file] };
	}
	const keychain = options.keychain ?? platformKeychain();
	return { primary: keychain, all: [keychain, file] };
}

const storeRecordName = (storeId: string) => `attestation-store-${storeId}`;
const keyRecordName = (fingerprint: string) =>
	`attestation-key-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;

function parseStoreWitness(text: string | null): StoreWitness | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text) as Partial<StoreWitness>;
		if (value.v !== 1 || typeof value.token !== "string" || typeof value.store_id !== "string")
			return null;
		if (value.state !== "standalone" && value.state !== "managed") return null;
		return value as StoreWitness;
	} catch {
		return null;
	}
}

function keyIsManaged(all: WitnessBackend[], fingerprint: string): boolean {
	return all.some((backend) => backend.read(keyRecordName(fingerprint)) !== null);
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

/** Stores whose mark every witness took in this process, so each entry point writes it once. */
const markedThisProcess = new Set<string>();

/**
 * Marks this store and its device key as managed, in every witness and in the database.
 * Coordinator entry points call this before coordinator trust takes effect. The database row
 * must be written. Witness writes are best effort, because the recorded history keeps the
 * store closed without them, and a failed write is retried by the next entry point.
 */
export function markCoordinatorManaged(db: Database, options: AttestationOptions = {}): void {
	const storeId = readStoreId(db);
	const fingerprint = deviceFingerprint(db) ?? "";
	const row = attestationRow(db);
	const { all } = witnesses(options);
	const memo = [storeId, fingerprint, keysDirectory(options.keysDir), all.length].join("|");
	if (
		row?.state === "managed" &&
		row.key_fingerprint === fingerprint &&
		markedThisProcess.has(memo)
	)
		return;
	const record: StoreWitness = {
		v: 1,
		store_id: storeId,
		key_fingerprint: fingerprint,
		state: "managed",
		token: row?.token ?? randomUUID(),
		counter: (row?.counter ?? 0) + 1,
	};
	let witnessed = true;
	for (const backend of all) {
		witnessed = backend.write(storeRecordName(storeId), JSON.stringify(record)) && witnessed;
		if (fingerprint) {
			const key = JSON.stringify({ v: 1, key_fingerprint: fingerprint, state: "managed" });
			witnessed = backend.write(keyRecordName(fingerprint), key) && witnessed;
		}
	}
	db.prepare(
		`INSERT INTO coordinator_free_attestation(id, store_id, key_fingerprint, state, token, counter, updated_at)
		 VALUES (1, ?, ?, 'managed', ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET state = 'managed', key_fingerprint = excluded.key_fingerprint,
		   counter = excluded.counter, updated_at = excluded.updated_at`,
	).run(storeId, fingerprint, record.token, record.counter, new Date().toISOString());
	if (witnessed) markedThisProcess.add(memo);
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

/** Marks the store managed when its database holds coordinator history and the mark is missing. */
export function propagateCoordinatorManaged(db: Database, options: AttestationOptions = {}): void {
	const row = attestationRow(db);
	if (row?.state === "managed" && row.key_fingerprint === (deviceFingerprint(db) ?? "")) return;
	if (storeHasCoordinatorHistory(db)) markCoordinatorManaged(db, options);
}

function standaloneRowStatus(
	db: Database,
	row: AttestationRow,
	context: { storeId: string; fingerprint: string; witness: StoreWitness | null },
): CoordinatorFreeStatus {
	if (row.key_fingerprint !== context.fingerprint) return "key_changed";
	if (!context.witness) return "witness_missing";
	if (context.witness.state === "managed") return "managed";
	const matches =
		context.witness.store_id === context.storeId &&
		row.store_id === context.storeId &&
		context.witness.key_fingerprint === row.key_fingerprint &&
		context.witness.token === row.token &&
		context.witness.counter === row.counter;
	if (!matches) return "witness_mismatch";
	return storeHasCoordinatorHistory(db) ? "managed" : "standalone";
}

/** Whether this store may sync without a coordinator. Only "standalone" allows it. */
export function readCoordinatorFreeStatus(
	db: Database,
	options: AttestationOptions = {},
): CoordinatorFreeStatus {
	const storeId = readStoreId(db);
	const fingerprint = deviceFingerprint(db);
	if (!fingerprint) return "no_device_identity";
	const { primary, all } = witnesses(options);
	if (keyIsManaged(all, fingerprint)) return "managed";
	const stored = all.map((backend) => parseStoreWitness(backend.read(storeRecordName(storeId))));
	if (stored.some((witness) => witness?.state === "managed")) return "managed";
	const row = attestationRow(db);
	if (row?.state === "managed") return "managed";
	if (!row) {
		// An attested store that lost its database record can't be told from a rollback.
		if (stored.some(Boolean)) return "attestation_lost";
		return storeHasCoordinatorHistory(db) ? "managed" : "unattested";
	}
	const witness = parseStoreWitness(primary.read(storeRecordName(storeId)));
	return standaloneRowStatus(db, row, { storeId, fingerprint, witness });
}

/**
 * Attests a store that has never been attested, managed or used with a coordinator. Anything
 * else returns its current status unchanged. The witness is written first: a crash before the
 * database row leaves the store closed rather than open.
 */
export function attestCoordinatorFree(
	db: Database,
	options: AttestationOptions = {},
): CoordinatorFreeStatus {
	const status = readCoordinatorFreeStatus(db, options);
	if (status !== "unattested") return status;
	const storeId = readStoreId(db);
	const fingerprint = deviceFingerprint(db) ?? "";
	const record: StoreWitness = {
		v: 1,
		store_id: storeId,
		key_fingerprint: fingerprint,
		state: "standalone",
		token: randomUUID(),
		counter: 1,
	};
	if (!witnesses(options).primary.write(storeRecordName(storeId), JSON.stringify(record))) {
		return "witness_missing";
	}
	db.prepare(
		`INSERT INTO coordinator_free_attestation(id, store_id, key_fingerprint, state, token, counter, updated_at)
		 VALUES (1, ?, ?, 'standalone', ?, 1, ?)`,
	).run(storeId, fingerprint, record.token, new Date().toISOString());
	return readCoordinatorFreeStatus(db, options);
}
