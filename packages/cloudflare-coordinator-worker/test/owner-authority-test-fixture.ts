import { createHash } from "node:crypto";
import type { D1DatabaseLike } from "../../core/src/d1-coordinator-store.js";

export async function pendingKey() {
	const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
	const raw = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey));
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	return {
		publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
		sign: async (message: string) => Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(message))).toString("base64url"),
	};
}

/** Historical A authority only. Never creates B, enrollment attempts or group grants. */
export async function seedOwnerAuthority(db: D1DatabaseLike, pins: {
	coordinatorId: string;
	issuer: string;
	revision: string;
	linkId: string;
	subject: string;
	identityId: string;
	attemptId: string;
	controllerAttestationId: string;
	controllerReviewReceiptId: string;
	redirectUri: string;
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	createdAtMs: number;
}) {
	const hash = (value: string) => createHash("sha256").update(value).digest("hex");
	const birth = pins.createdAtMs;
	const common = {
		coordinator_id: pins.coordinatorId,
		identity_id: pins.identityId,
		group_id: pins.groupId,
		device_id: pins.deviceId,
		fingerprint: pins.fingerprint,
		controller_attestation_id: pins.controllerAttestationId,
		auth_config_revision: pins.revision,
		authority_kind: "controller_attestation",
	};
	const browserHash = hash(`${pins.coordinatorId}:${pins.attemptId}:link`);
	const facts: [string, Record<string, string | number | null>][] = [
		["coordinator_auth_link_attempts", {
			...common, attempt_id: pins.attemptId, public_key: pins.publicKey,
			controller_review_receipt_id: pins.controllerReviewReceiptId, controller_revision: 1,
			issuer: pins.issuer, runtime_verifier_hash: hash(`${browserHash}:runtime`),
			loopback_redirect: "http://127.0.0.1:43210/codemem/auth/complete",
			state: "finalized", browser_transaction_hash: browserHash, account_subject: pins.subject,
			completion_secret_hash: hash(`${browserHash}:completion`), link_id: pins.linkId,
			browser_start_hash: hash(`${browserHash}:start`), created_at_ms: birth - 100,
			expires_at_ms: birth + 599900, claimed_at_ms: birth - 80,
			oidc_verified_at_ms: birth - 60, confirmed_at_ms: birth - 40, finalized_at_ms: birth,
		}],
		["coordinator_auth_browser_transactions", {
			coordinator_id: pins.coordinatorId, browser_transaction_hash: browserHash,
			purpose: "link", attempt_id: pins.attemptId, state_hash: hash(`${browserHash}:state`),
			binder_hash: hash(`${browserHash}:binder`), issuer: pins.issuer,
			auth_config_revision: pins.revision, redirect_uri: pins.redirectUri,
			state: "consumed", nonce: null, pkce_verifier: null, claim_token: hash(`${browserHash}:claim`),
			created_at_ms: birth - 90, expires_at_ms: birth + 599910, consumed_at_ms: birth - 70,
		}],
		["coordinator_auth_account_links", {
			coordinator_id: pins.coordinatorId, link_id: pins.linkId, issuer: pins.issuer,
			subject: pins.subject, identity_id: pins.identityId, attempt_id: pins.attemptId,
			controller_attestation_id: pins.controllerAttestationId, auth_config_revision: pins.revision,
			created_at_ms: birth, revoked_at_ms: null, authority_kind: "controller_attestation",
			device_claim_id: null,
		}],
		["coordinator_auth_link_audit_log", {
			...common, link_id: pins.linkId, attempt_id: pins.attemptId,
			action: "link_created", device_claim_id: null, created_at_ms: birth,
		}],
	];
	if (!db.batch) throw new Error("Authority fixture requires atomic D1 batch");
	await db.batch(facts.map(([table, row]) => {
		const entries = Object.entries(row);
		return db.prepare(
			`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
		).bind(...entries.map(([, value]) => value));
	}));
}
