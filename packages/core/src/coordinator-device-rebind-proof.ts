import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { verifyOwnerEnrollmentSignature } from "./coordinator-owner-enrollment-proof.js";

/** One stored rebinding attempt. Private ceremony state, never current authority. */
export interface DeviceRebindAttempt {
	coordinator_id: string;
	attempt_id: string;
	origin: string;
	device_id: string;
	public_key: string;
	key_id: string;
	fingerprint: string;
	current_identity_id: string;
	issuer: string;
	auth_config_revision: string;
	loopback_redirect: string | null;
	browser_start_hash: string;
	browser_transaction_hash: string | null;
	browser_binder_hash: string | null;
	account_subject: string | null;
	target_identity_id: string | null;
	link_id: string | null;
	link_authority_kind: "controller_attestation" | "device_claim" | null;
	review_digest: string | null;
	team_effects_json: string | null;
	enrollment_count: number | null;
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

// Domain strings differ from owner enrollment so no proof can cross ceremonies.
const CONFIRM_DOMAIN = "codemem-device-rebind-confirm-v1";
const FINAL_DOMAIN = "codemem-device-rebind-finalize-v1";

const CONFIRMED_FIELDS = [
	"coordinator_id",
	"attempt_id",
	"origin",
	"device_id",
	"public_key",
	"key_id",
	"fingerprint",
	"current_identity_id",
	"issuer",
	"auth_config_revision",
	"browser_start_hash",
	"browser_transaction_hash",
	"browser_binder_hash",
	"account_subject",
	"target_identity_id",
	"link_id",
	"link_authority_kind",
	"review_digest",
	"team_effects_json",
	"enrollment_count",
	"created_at_ms",
	"expires_at_ms",
] as const satisfies readonly (keyof DeviceRebindAttempt)[];

async function sha256Hex(text: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What the browser confirms: the Google account, both Identities, the device,
 * the local review digest, and the Team effects shown to the person.
 */
export function deviceRebindConfirmationHash(a: DeviceRebindAttempt): Promise<string> {
	return sha256Hex(JSON.stringify([CONFIRM_DOMAIN, ...CONFIRMED_FIELDS.map((field) => a[field])]));
}

/** What the device key signs after the loopback delivers the completion secret. */
export function deviceRebindFinalMessage(a: DeviceRebindAttempt, completionSecret: string): string {
	return JSON.stringify([
		FINAL_DOMAIN,
		a.coordinator_id,
		a.origin,
		a.auth_config_revision,
		a.attempt_id,
		a.device_id,
		a.public_key,
		a.key_id,
		a.fingerprint,
		a.issuer,
		a.current_identity_id,
		a.target_identity_id,
		a.review_digest,
		a.confirmation_hash,
		completionSecret,
	]);
}

function confirmedAndCurrent(a: DeviceRebindAttempt, revision: string, now: number): boolean {
	return (
		a.state === "confirmed" &&
		[
			a.account_subject,
			a.target_identity_id,
			a.link_id,
			a.review_digest,
			a.confirmation_hash,
		].every((value) => typeof value === "string" && value.length > 0) &&
		Number.isSafeInteger(now) &&
		now >= a.created_at_ms &&
		now < a.expires_at_ms &&
		revision === a.auth_config_revision
	);
}

/**
 * Checks the three proofs this attempt binds: the confirmed browser commitment,
 * the completion secret delivered to this device, and its enrolled key's
 * signature. It does not check current authority; the commit SQL does that.
 */
export async function verifyDeviceRebindCompletion(
	a: DeviceRebindAttempt,
	input: { revision: string; now: number; completionSecret: string; signature: string },
): Promise<{ keyProofHash: string } | null> {
	if (!confirmedAndCurrent(a, input.revision, input.now)) return null;
	if ((await deviceRebindConfirmationHash(a)) !== a.confirmation_hash) return null;
	const secret = decodeCoordinatorAuthProof32(input.completionSecret);
	if (!secret || (await hashCoordinatorAuthProofBytes32(secret)) !== a.completion_secret_hash)
		return null;
	if ((await ed25519KeyId(a.public_key)) !== a.key_id) return null;
	if ((await sha256Hex(a.public_key)) !== a.fingerprint) return null;
	const message = deviceRebindFinalMessage(a, input.completionSecret);
	if (!(await verifyOwnerEnrollmentSignature(a.public_key, message, input.signature))) return null;
	return { keyProofHash: await sha256Hex(input.signature) };
}
