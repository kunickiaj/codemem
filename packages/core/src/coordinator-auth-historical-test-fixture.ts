import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES } from "./coordinator-auth-historical-migration-test-fixture.js";
import { AUTH_LINK_AUTHORITY_CUTOVER_SQL } from "./coordinator-auth-link-authority-upgrade.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import type { CoordinatorOidcProfile } from "./coordinator-oidc.js";

export type HistoricalAccountDefect =
	| "missing_link"
	| "missing_creation_audit"
	| "link_identity"
	| "link_subject"
	| "link_issuer"
	| "link_attempt"
	| "link_controller"
	| "link_revision";
export interface HistoricalAccountOptions {
	authority: "controller_attestation" | "device_claim";
	defect?: HistoricalAccountDefect;
	session?: {
		credentialHash: string;
		revision?: string;
		profile?: CoordinatorOidcProfile;
	};
}
export interface HistoricalAccountPins {
	config: CoordinatorAuthLinkConfig;
	account: { issuer: string; subject: string };
	identityId: string;
	linkId: string;
	attemptId: string;
	controllerAttestationId: string | null;
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	keyId: string;
	bornAtMs: number;
	browserTransactionHash: string;
	session?: {
		sessionId: string;
		credentialHash: string;
		browserTransactionHash: string;
		revision: string;
		createdAtMs: number;
		expiresAtMs: number;
	};
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function pinsFor(options: HistoricalAccountOptions): HistoricalAccountPins {
	const coordinatorId = "coordinator-a";
	const attemptId = "historical-attempt";
	const bornAtMs = 1_791_028_800_000;
	const pins: HistoricalAccountPins = {
		config: {
			coordinatorId,
			issuer: "https://accounts.example.test",
			revision: "a".repeat(64),
			enabled: true,
		},
		account: {
			issuer: "https://accounts.example.test",
			subject: "fixture-subject",
		},
		identityId: "identity-a",
		linkId: "link-a",
		attemptId,
		controllerAttestationId:
			options.authority === "controller_attestation" ? "historical-controller" : null,
		groupId: "group-a",
		deviceId: "historical-device",
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: hash(CANONICAL_PUBLIC_KEY),
		keyId: EXPECTED_KEY_ID,
		bornAtMs,
		browserTransactionHash: hash(`${coordinatorId}:${attemptId}:link`),
	};
	if (options.session)
		pins.session = {
			sessionId: "historical-session",
			credentialHash: options.session.credentialHash,
			browserTransactionHash: hash(`${coordinatorId}:${attemptId}:signin`),
			revision: options.session.revision ?? pins.config.revision,
			createdAtMs: bornAtMs + 10,
			expiresAtMs: bornAtMs + 10 + 28800000,
		};
	return pins;
}
function insert(db: Database, table: string, row: Record<string, unknown>) {
	const entries = Object.entries(row);
	db.prepare(
		`INSERT INTO main.${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
	).run(...entries.map(([, value]) => value));
}
function browserRow(p: HistoricalAccountPins, purpose: "link" | "signin") {
	const session = purpose === "signin" ? p.session : undefined;
	const browserHash = session?.browserTransactionHash ?? p.browserTransactionHash;
	return {
		coordinator_id: p.config.coordinatorId,
		browser_transaction_hash: browserHash,
		purpose,
		attempt_id: purpose === "link" ? p.attemptId : null,
		state_hash: hash(`${browserHash}:state`),
		binder_hash: hash(`${browserHash}:binder`),
		issuer: p.config.issuer,
		auth_config_revision: session?.revision ?? p.config.revision,
		redirect_uri: "https://coordinator.example.test/auth/callback",
		state: "consumed",
		nonce: null,
		pkce_verifier: null,
		claim_token: hash(`${browserHash}:claim`),
		created_at_ms: p.bornAtMs - 90,
		expires_at_ms: p.bornAtMs - 90 + 600000,
		consumed_at_ms: p.bornAtMs - 80,
	};
}
function seedAttempt(db: Database, p: HistoricalAccountPins, options: HistoricalAccountOptions) {
	const common = {
		coordinator_id: p.config.coordinatorId,
		attempt_id: p.attemptId,
		identity_id: p.identityId,
		group_id: p.groupId,
		device_id: p.deviceId,
		fingerprint: p.fingerprint,
		controller_attestation_id: p.controllerAttestationId,
		auth_config_revision: p.config.revision,
		authority_kind: options.authority,
	};
	insert(db, "coordinator_auth_link_attempts", {
		...common,
		public_key: p.publicKey,
		controller_review_receipt_id: p.controllerAttestationId ? "historical-review" : null,
		controller_revision: p.controllerAttestationId ? 1 : null,
		issuer: p.config.issuer,
		runtime_verifier_hash: hash("historical-runtime"),
		loopback_redirect: "http://127.0.0.1:1234/callback",
		state: "finalized",
		browser_transaction_hash: p.browserTransactionHash,
		account_subject: p.account.subject,
		completion_secret_hash: hash("historical-completion"),
		link_id: p.linkId,
		browser_start_hash: hash("historical-start"),
		created_at_ms: p.bornAtMs - 100,
		expires_at_ms: p.bornAtMs - 100 + 600000,
		claimed_at_ms: p.bornAtMs - 85,
		oidc_verified_at_ms: p.bornAtMs - 70,
		confirmed_at_ms: p.bornAtMs - 60,
		finalized_at_ms: p.bornAtMs,
	});
	return common;
}
function seedBirth(db: Database, p: HistoricalAccountPins, options: HistoricalAccountOptions) {
	const common = seedAttempt(db, p, options);
	insert(db, "coordinator_auth_browser_transactions", browserRow(p, "link"));
	const claimId = options.authority === "device_claim" ? p.linkId : null;
	if (claimId)
		insert(db, "coordinator_auth_device_claims", {
			claim_id: claimId,
			coordinator_id: p.config.coordinatorId,
			identity_id: p.identityId,
			group_id: p.groupId,
			device_id: p.deviceId,
			public_key: p.publicKey,
			fingerprint: p.fingerprint,
			key_id: p.keyId,
			attempt_id: p.attemptId,
			issuer: p.config.issuer,
			auth_config_revision: p.config.revision,
			created_at_ms: p.bornAtMs,
		});
	const link = {
		coordinator_id: p.config.coordinatorId,
		link_id: p.linkId,
		issuer: p.config.issuer,
		subject: p.account.subject,
		identity_id: p.identityId,
		attempt_id: p.attemptId,
		controller_attestation_id: p.controllerAttestationId,
		auth_config_revision: p.config.revision,
		created_at_ms: p.bornAtMs,
		revoked_at_ms: null,
		authority_kind: options.authority,
		device_claim_id: claimId,
	};
	const changed: Record<string, Record<string, unknown>> = {
		link_identity: { identity_id: "other-identity" },
		link_subject: { subject: "other-subject" },
		link_issuer: { issuer: "https://other.example.test" },
		link_attempt: { attempt_id: "other-attempt" },
		link_controller: { controller_attestation_id: "other-controller" },
		link_revision: { auth_config_revision: "f".repeat(64) },
	};
	if (options.defect !== "missing_link")
		insert(db, "coordinator_auth_account_links", { ...link, ...changed[options.defect ?? ""] });
	if (options.defect !== "missing_creation_audit")
		insert(db, "coordinator_auth_link_audit_log", {
			...common,
			link_id: p.linkId,
			action: "link_created",
			device_claim_id: claimId,
			created_at_ms: p.bornAtMs,
		});
}
function seedSession(db: Database, p: HistoricalAccountPins, options: HistoricalAccountOptions) {
	const s = p.session;
	if (!s) return;
	insert(db, "coordinator_auth_browser_transactions", browserRow(p, "signin"));
	const common = {
		coordinator_id: p.config.coordinatorId,
		browser_transaction_hash: s.browserTransactionHash,
		link_id: p.linkId,
		session_id: s.sessionId,
		auth_config_revision: s.revision,
		created_at_ms: s.createdAtMs,
	};
	insert(db, "coordinator_auth_session_receipts", {
		...common,
		source: "signin",
		attempt_id: null,
		purge_eligible: 1,
	});
	insert(db, "coordinator_auth_sessions", {
		...common,
		credential_hash: s.credentialHash,
		identity_id: p.identityId,
		issuer: p.account.issuer,
		subject: p.account.subject,
		expires_at_ms: s.expiresAtMs,
		revoked_at_ms: null,
	});
	const profile = options.session?.profile;
	if (profile)
		insert(db, "coordinator_auth_account_profiles", {
			coordinator_id: p.config.coordinatorId,
			link_id: p.linkId,
			display_name: profile.displayName ?? null,
			email: profile.email ?? null,
			email_verified: profile.emailVerified === undefined ? null : Number(profile.emailVerified),
			picture_url: profile.pictureUrl ?? null,
			source_session_id: s.sessionId,
			source_signed_in_at_ms: s.createdAtMs,
		});
}

/** Test-only historical facts, not an OIDC verifier or authority/grant writer.
 * Requires a fresh test-owned database. Seed first, explicitly upgrade later if
 * desired, then open the current store; never migrate existing data on open.
 */
export function prepareHistoricalAccountDatabase(
	db: Database,
	options: HistoricalAccountOptions,
): HistoricalAccountPins {
	if (
		db.inTransaction ||
		db
			.prepare(
				"SELECT 1 FROM main.sqlite_master UNION ALL SELECT 1 FROM sqlite_temp_master LIMIT 1",
			)
			.get() ||
		(db.prepare("PRAGMA database_list").all() as { name: string }[]).some(
			({ name }) => name !== "main" && name !== "temp",
		) ||
		db.pragma("ignore_check_constraints", { simple: true }) !== 0
	)
		throw new Error("historical_auth_fixture_requires_fresh_database");
	if (options.authority === "device_claim" && options.defect === "link_controller")
		throw new Error("historical_auth_fixture_invalid_defect");
	const p = pinsFor(options);
	db.transaction(() => {
		for (const name of AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES)
			db.exec(
				readFileSync(
					new URL(`../../cloudflare-coordinator-worker/migrations/${name}`, import.meta.url),
					"utf8",
				),
			);
		db.exec(AUTH_LINK_AUTHORITY_CUTOVER_SQL);
		seedBirth(db, p, options);
		seedSession(db, p, options);
	}).immediate();
	return p;
}
