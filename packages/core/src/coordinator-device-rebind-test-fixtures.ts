import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { hashCoordinatorAuthProofBytes32 } from "./coordinator-auth-proof.js";
import { type Backend, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	type DeviceRebindAttempt,
	deviceRebindConfirmationHash,
	deviceRebindFinalMessage,
} from "./coordinator-device-rebind-proof.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";
import { createD1AuthLinkBackend } from "./d1-coordinator-store.js";

export const NOW = 1_791_028_800_000;
export const COORDINATOR = "coordinator-a";
export const CURRENT = "local:device-work";
export const TARGET = "identity-target";
export const REVISION = "a".repeat(64);
export const GROUPS = ["group-a", "group-b"] as const;

/** Every table a rebind may touch, for all-or-nothing assertions. */
export const EFFECT_TABLES = [
	"coordinator_device_rebind_attempts",
	"coordinator_device_ownership_bindings",
	"enrolled_devices",
	"coordinator_device_rebind_audit_log",
	"coordinator_identity_group_grants",
	"coordinator_auth_account_links",
] as const;

export interface RebindFixture {
	db: Database.Database;
	store: CoordinatorStore;
	backend: AuthLinkBackend;
	attempt: DeviceRebindAttempt;
	secret: string;
	sign(message: string): string;
	input(patch?: { now?: number; completionSecret?: string; signature?: string }): {
		backend: AuthLinkBackend;
		coordinatorId: string;
		attemptId: string;
		revision: string;
		now: number;
		completionSecret: string;
		signature: string;
	};
	effects(): unknown[][];
	close(): Promise<void>;
}

function exec(db: Database.Database, sql: string, ...values: unknown[]) {
	db.prepare(sql).run(...values);
}

function seedCoordinator(
	db: Database.Database,
	device: Pick<DeviceRebindAttempt, "public_key" | "fingerprint">,
) {
	const created = new Date(NOW).toISOString();
	for (const group of GROUPS) {
		exec(db, "INSERT INTO groups (group_id, created_at) VALUES (?, ?)", group, created);
		// The migrated device: one group recorded no Identity, the other the old one.
		exec(
			db,
			`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
			 VALUES (?, 'device-work', ?, ?, ?, 1, ?)`,
			group,
			device.public_key,
			device.fingerprint,
			group === "group-a" ? null : CURRENT,
			created,
		);
	}
	// The target Identity's Google link, made on another device.
	exec(
		db,
		`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
		 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
		 VALUES (?, 'link-target', 'https://accounts.example.test', 'subject-target', ?, 'link-attempt', ?, ?,
		 'device_claim', 'claim-target')`,
		COORDINATOR,
		TARGET,
		REVISION,
		NOW - 1000,
	);
}

async function confirmedAttempt(publicKey: string, secret: string): Promise<DeviceRebindAttempt> {
	const attempt: DeviceRebindAttempt = {
		coordinator_id: COORDINATOR,
		attempt_id: "rebind-attempt-a",
		origin: "https://coordinator.example.test",
		device_id: "device-work",
		public_key: publicKey,
		key_id: (await ed25519KeyId(publicKey)) as string,
		fingerprint: createHash("sha256").update(publicKey).digest("hex"),
		current_identity_id: CURRENT,
		issuer: "https://accounts.example.test",
		auth_config_revision: REVISION,
		loopback_redirect: "http://127.0.0.1:4567/rebind",
		browser_start_hash: "b".repeat(64),
		browser_transaction_hash: "c".repeat(64),
		browser_binder_hash: "d".repeat(64),
		account_subject: "subject-target",
		target_identity_id: TARGET,
		link_id: "link-target",
		link_authority_kind: "device_claim",
		review_digest: "e".repeat(64),
		team_effects_json: JSON.stringify({ requests: [] }),
		enrollment_count: GROUPS.length,
		confirmation_hash: null,
		completion_secret_hash: await hashCoordinatorAuthProofBytes32(Buffer.from(secret, "base64url")),
		final_key_proof_hash: null,
		state: "confirmed",
		created_at_ms: NOW - 60_000,
		expires_at_ms: NOW - 60_000 + 600_000,
		finalized_at_ms: null,
		binding_id: null,
		audit_event_id: null,
		final_outcome_json: null,
	};
	attempt.confirmation_hash = await deviceRebindConfirmationHash(attempt);
	return attempt;
}

function insertAttempt(db: Database.Database, attempt: DeviceRebindAttempt) {
	const entries = Object.entries(attempt);
	exec(
		db,
		`INSERT INTO coordinator_device_rebind_attempts (${entries.map(([key]) => key).join(", ")})
		 VALUES (${entries.map(() => "?").join(", ")})`,
		...entries.map(([, value]) => value),
	);
}

/** A migrated device enrolled in two groups, confirmed to rebind to TARGET. */
export async function rebindFixture(kind: Backend): Promise<RebindFixture> {
	const store = setupStore(kind);
	const { db } = store;
	const backend = kind === "SQLite" ? nativeBackend(db) : createD1AuthLinkBackend(sqliteD1(db));
	const key = commitPendingKey();
	const secret = Buffer.alloc(32, 7).toString("base64url");
	const attempt = await confirmedAttempt(key.publicKey, secret);
	seedCoordinator(db, attempt);
	insertAttempt(db, attempt);
	const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
	return {
		db,
		store: store.store,
		backend,
		attempt,
		secret,
		sign: key.sign,
		input: (patch = {}) => {
			const completionSecret = patch.completionSecret ?? secret;
			return {
				backend,
				coordinatorId: attempt.coordinator_id,
				attemptId: attempt.attempt_id,
				revision: REVISION,
				now: patch.now ?? NOW,
				completionSecret,
				signature: patch.signature ?? key.sign(deviceRebindFinalMessage(attempt, completionSecret)),
			};
		},
		effects: () => EFFECT_TABLES.map(rows),
		close: async () => {
			await store.store.close();
			if (db.open) db.close();
		},
	};
}

/** Gives the enrolled device its own claim for `identityId`, so it has proof and can't self-bind. */
export async function insertOwnDeviceClaim(
	db: Database.Database,
	input: {
		coordinatorId: string;
		issuer: string;
		revision: string;
		identityId: string;
		deviceId: string;
	},
): Promise<void> {
	const device = db
		.prepare("SELECT public_key, fingerprint FROM enrolled_devices WHERE device_id = ? LIMIT 1")
		.get(input.deviceId) as { public_key: string; fingerprint: string };
	db.prepare(
		`INSERT INTO coordinator_auth_device_claims (claim_id, coordinator_id, identity_id, group_id,
		 device_id, public_key, fingerprint, key_id, attempt_id, issuer, auth_config_revision, created_at_ms)
		 VALUES ('claim-own', ?, ?, 'group-a', ?, ?, ?, ?, 'attempt-own', ?, ?, 1)`,
	).run(
		input.coordinatorId,
		input.identityId,
		input.deviceId,
		device.public_key,
		device.fingerprint,
		await ed25519KeyId(device.public_key),
		input.issuer,
		input.revision,
	);
}
