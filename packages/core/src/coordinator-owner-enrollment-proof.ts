import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { ed25519KeyId, parseSshEd25519PublicKey } from "./coordinator-ed25519-key-id.js";

/** Private ceremony metadata and pending-key proof, never current account/group authority. */
export interface OwnerAttempt {
	coordinator_id: string;
	attempt_id: string;
	purpose: "owner_enroll";
	origin: string;
	device_id: string;
	public_key: string;
	key_id: string;
	fingerprint: string;
	issuer: string;
	auth_config_revision: string;
	loopback_redirect: string | null;
	browser_start_hash: string;
	browser_transaction_hash: string | null;
	browser_binder_hash: string | null;
	account_subject: string | null;
	identity_id: string | null;
	link_id: string | null;
	link_attempt_id: string | null;
	link_controller_attestation_id: string | null;
	link_auth_config_revision: string | null;
	grant_revisions_json: string | null;
	confirmation_hash: string | null;
	completion_secret_hash: string | null;
	final_key_proof_hash: string | null;
	state: string;
	created_at_ms: number;
	expires_at_ms: number;
	finalized_at_ms: number | null;
	binding_id: string | null;
	audit_event_id: string | null;
	final_outcome_json: string | null;
}

export interface GrantPin {
	groupId: string;
	revision: number;
}
export function readGrantPins(value: string | null): GrantPin[] | null {
	try {
		const pins: unknown = JSON.parse(value ?? "null");
		if (!Array.isArray(pins) || pins.length < 1 || pins.length > 50) return null;
		if (
			!pins.every(
				(p) =>
					p &&
					typeof p === "object" &&
					typeof p.groupId === "string" &&
					p.groupId.trim().length > 0 &&
					p.groupId === p.groupId.trim() &&
					!p.groupId.includes("\0") &&
					Number.isSafeInteger(p.revision) &&
					p.revision > 0,
			)
		)
			return null;
		if (new Set(pins.map((p) => p.groupId)).size !== pins.length) return null;
		return pins.map(({ groupId, revision }) => ({ groupId, revision }));
	} catch {
		return null;
	}
}
export function validAttemptTime(row: OwnerAttempt): boolean {
	return (
		Number.isSafeInteger(row.created_at_ms) &&
		row.created_at_ms >= 0 &&
		row.created_at_ms <= 9007199254140991 &&
		row.expires_at_ms === row.created_at_ms + 600000
	);
}
export function validWriteTime(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		typeof value === "number" &&
		value >= 0 &&
		value <= 8640000000000000
	);
}

export function ownerEnrollmentFinalMessage(a: OwnerAttempt, completionSecret: string): string {
	return JSON.stringify([
		"codemem-owner-enrollment-finalize-v1",
		"owner_enroll",
		a.coordinator_id,
		a.origin,
		a.auth_config_revision,
		a.attempt_id,
		a.device_id,
		a.public_key,
		a.key_id,
		a.fingerprint,
		a.issuer,
		a.account_subject,
		a.identity_id,
		a.link_id,
		a.confirmation_hash,
		completionSecret,
	]);
}
/** Verifies the pending-key signature and hashes proof bytes, not the stored completion hash or current authority. */
export async function verifyPendingKeySignatureAndHashes(
	a: OwnerAttempt,
	completionSecret: string,
	signature: string,
) {
	const bytes = decodeCoordinatorAuthProof32(completionSecret);
	if (!bytes || (await ed25519KeyId(a.public_key)) !== a.key_id) return null;
	// Legacy fingerprints hash the exact key text, unlike the canonical SSH key ID.
	const fingerprintDigest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(a.public_key),
	);
	const fingerprint = Array.from(new Uint8Array(fingerprintDigest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	if (fingerprint !== a.fingerprint) return null;
	const completionHash = await hashCoordinatorAuthProofBytes32(bytes);
	const message = ownerEnrollmentFinalMessage(a, completionSecret);
	if (!(await verifyOwnerEnrollmentSignature(a.public_key, message, signature))) return null;
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(signature),
	);
	const keyProofHash = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	return { completionHash, keyProofHash };
}
export async function verifyOwnerEnrollmentSignature(
	publicKey: string,
	message: string,
	signature: string,
): Promise<boolean> {
	try {
		if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(signature)) return false;
		const binary = atob(`${signature.replaceAll("-", "+").replaceAll("_", "/")}==`);
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		const parsed = parseSshEd25519PublicKey(publicKey);
		if (parsed.kind !== "ed25519" || bytes.length !== 64) return false;
		const key = await globalThis.crypto.subtle.importKey(
			"raw",
			new Uint8Array(parsed.blob.slice(19)),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return await globalThis.crypto.subtle.verify(
			"Ed25519",
			key,
			bytes,
			new TextEncoder().encode(message),
		);
	} catch {
		return false;
	}
}

/** Validates proof and metadata only; the atomic writer must still check live authority in SQL. */
export async function verifyOwnerEnrollmentCompletion(
	a: OwnerAttempt,
	revision: string,
	now: number,
	completionSecret: string,
	signature: string,
) {
	const grants = readGrantPins(a.grant_revisions_json);
	if (
		!grants ||
		a.purpose !== "owner_enroll" ||
		a.state !== "confirmed" ||
		![a.account_subject, a.identity_id, a.link_id, a.confirmation_hash].every(isNonemptyText) ||
		!validAttemptTime(a) ||
		!validWriteTime(now) ||
		now < a.created_at_ms ||
		now >= a.expires_at_ms ||
		revision !== a.auth_config_revision
	)
		return null;
	const proof = await verifyPendingKeySignatureAndHashes(a, completionSecret, signature);
	if (!proof || proof.completionHash !== a.completion_secret_hash) return null;
	return { grants, ...proof };
}
function isNonemptyText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function receiptOutcomeMatches(row: OwnerAttempt): boolean {
	const grants = readGrantPins(row.grant_revisions_json);
	try {
		const outcome = JSON.parse(row.final_outcome_json ?? "null");
		return (
			!!grants &&
			outcome?.kind === "finalized" &&
			outcome.bindingId === row.binding_id &&
			JSON.stringify(outcome.groups) === JSON.stringify(grants.map((g) => g.groupId))
		);
	} catch {
		return false;
	}
}
/** Receipt shape is not evidence that a database commit occurred or permission remains active. */
export function validOwnerEnrollmentReceiptMetadata(a: OwnerAttempt): boolean {
	return (
		a.purpose === "owner_enroll" &&
		a.state === "finalized" &&
		!!a.binding_id &&
		!!a.audit_event_id &&
		isNonemptyText(a.final_key_proof_hash) &&
		isNonemptyText(a.completion_secret_hash) &&
		receiptOutcomeMatches(a) &&
		validAttemptTime(a) &&
		validWriteTime(a.finalized_at_ms) &&
		a.finalized_at_ms >= a.created_at_ms &&
		a.finalized_at_ms < a.expires_at_ms
	);
}
