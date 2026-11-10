import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import { captureAuthLinkConfig } from "./coordinator-auth-link-input.js";
import {
	captureDeviceClaimBindingInput,
	type DeviceClaimBindingInput,
	type DeviceClaimBindingReadiness,
	type DeviceClaimBindingReceipt,
	type DeviceClaimBindingResult,
} from "./coordinator-device-claim-binding-contract.js";
import {
	deviceClaimBindingGenesisSql,
	deviceClaimBindingStatements,
	prepareDeviceClaimBinding,
	prepareFirstLinkDeviceClaimBinding,
} from "./coordinator-device-claim-binding-sql.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

export type {
	DeviceClaimBindingInput,
	DeviceClaimBindingReadiness,
	DeviceClaimBindingReceipt,
	DeviceClaimBindingResult,
} from "./coordinator-device-claim-binding-contract.js";
export { isDeviceClaimBindingConflict } from "./coordinator-device-claim-binding-contract.js";
export {
	deviceClaimBindingStatements,
	type PreparedDeviceClaimBinding,
	prepareDeviceClaimBinding,
	prepareFirstLinkDeviceClaimBinding,
} from "./coordinator-device-claim-binding-sql.js";

/** Producer completion/retry status, not a claim-specific binding receipt.
 * Positive current claim genesis and the exact existing ownership row must both
 * verify, and every own enrollment must already name the unchanged Identity.
 */
export async function readFirstLinkDeviceClaimOwnershipComplete(
	backend: AuthLinkBackend,
	input: DeviceClaimBindingInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<boolean> {
	const plan = await prepareFirstLinkDeviceClaimBinding(backend, input, config, now);
	return (
		!!plan?.existingBinding && plan.nullCount === 0 && (await backend.first(plan.guard)) !== null
	);
}

/** Read-only immutable receipt. Enrollment changes after completion do not rewrite
 * history. The signed boundary still authenticates the exact current key.
 */
export async function readDeviceClaimBindingReceipt(
	backend: AuthLinkBackend,
	value: DeviceClaimBindingInput,
	config: CoordinatorAuthLinkConfig,
): Promise<DeviceClaimBindingReceipt | null> {
	const i = captureDeviceClaimBindingInput(value);
	const c = captureAuthLinkConfig(config);
	if (!i || !c?.enabled) return null;
	const key = await ed25519KeyIdForRevocation(i.signer.publicKey);
	if (!key) return null;
	const genesis = deviceClaimBindingGenesisSql(await hasConnectionSessionSchema(backend));
	return backend.first<DeviceClaimBindingReceipt>({
		sql: `SELECT b.binding_id AS bindingId,d.claim_id AS claimId,b.coordinator_id AS coordinatorId,b.device_id AS deviceId,
 b.key_id AS keyId,b.identity_id AS identityId,a.enrollment_count AS enrollmentCount,b.bound_at AS boundAt
 FROM coordinator_device_ownership_bindings b JOIN coordinator_auth_device_claims d
 ON d.coordinator_id=b.coordinator_id AND b.source_ref='device_claim:'||d.claim_id AND d.device_id=b.device_id
 AND d.key_id=b.key_id AND d.identity_id=b.identity_id
 JOIN coordinator_device_rebind_audit_log a ON a.coordinator_id=b.coordinator_id AND a.binding_id=b.binding_id
 AND a.attempt_id=b.source_ref AND a.action='owner_device_rebound' AND a.device_id=b.device_id
 AND a.previous_identity_id=b.identity_id AND a.target_identity_id=b.identity_id
 AND strftime('%Y-%m-%dT%H:%M:%fZ',a.created_at_ms/1000.0,'unixepoch')=b.bound_at
 WHERE b.coordinator_id=? AND b.device_id=? AND b.key_id=? AND b.identity_id=? AND b.provenance='owner_enrollment'
 AND d.group_id=? AND d.public_key=? AND d.fingerprint=? AND d.issuer=? AND ${genesis}`,
		values: [
			c.coordinatorId,
			i.signer.deviceId,
			key,
			i.currentIdentityId,
			i.signer.groupId,
			i.signer.publicKey,
			i.signer.fingerprint,
			c.issuer,
		],
	});
}

export async function readDeviceClaimBindingReadiness(
	backend: AuthLinkBackend,
	value: DeviceClaimBindingInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<DeviceClaimBindingReadiness> {
	const i = captureDeviceClaimBindingInput(value);
	const c = captureAuthLinkConfig(config);
	if (!i || !c?.enabled || !Number.isSafeInteger(now) || now < 0)
		return { kind: "requires_review" };
	const receipt = await readDeviceClaimBindingReceipt(backend, i, c);
	if (receipt) return { kind: "complete", receipt };
	const plan = await prepareDeviceClaimBinding(backend, i, c, now);
	if (!plan || !(await backend.first(plan.guard))) return { kind: "requires_review" };
	return { kind: "ready" };
}

/** Unknown outcomes propagate. Callers must read the receipt before retrying.
 * No grants, membership, other-device or local Identity writes occur here.
 */
export async function completeDeviceClaimBinding(
	backend: AuthLinkBackend,
	value: DeviceClaimBindingInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<DeviceClaimBindingResult> {
	const i = captureDeviceClaimBindingInput(value);
	const c = captureAuthLinkConfig(config);
	if (!i || !c?.enabled || !Number.isSafeInteger(now) || now < 0)
		return { kind: "requires_review" };
	const receipt = await readDeviceClaimBindingReceipt(backend, i, c);
	if (receipt) return { kind: "complete", receipt };
	const plan = await prepareDeviceClaimBinding(backend, i, c, now);
	if (!plan || !(await backend.first(plan.guard))) return { kind: "requires_review" };
	await backend.batch(
		deviceClaimBindingStatements(
			plan,
			globalThis.crypto.randomUUID(),
			globalThis.crypto.randomUUID(),
		),
	);
	const committed = await readDeviceClaimBindingReceipt(backend, i, c);
	if (!committed) throw new Error("device_claim_binding_outcome_unknown");
	return { kind: "completed", receipt: committed };
}
