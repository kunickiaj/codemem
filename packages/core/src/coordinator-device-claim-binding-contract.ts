import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorAuthLinkSigner } from "./coordinator-auth-link-contract.js";
import { capture, captureAuthLinkSigner } from "./coordinator-auth-link-input.js";

export interface DeviceClaimBindingInput {
	/** Authenticated by the signed-device boundary, never copied from a request body. */
	signer: CoordinatorAuthLinkSigner;
	/** Assertion of the unchanged current/default Identity. The committed claim is authority. */
	currentIdentityId: string;
}
export interface DeviceClaimBindingReceipt {
	bindingId: string;
	claimId: string;
	coordinatorId: string;
	deviceId: string;
	keyId: string;
	identityId: string;
	enrollmentCount: number;
	boundAt: string;
}
export type DeviceClaimBindingReadiness =
	| { kind: "ready" }
	| { kind: "complete"; receipt: DeviceClaimBindingReceipt }
	| { kind: "requires_review" };
export type DeviceClaimBindingResult =
	| Exclude<DeviceClaimBindingReadiness, { kind: "ready" }>
	| { kind: "completed"; receipt: DeviceClaimBindingReceipt };

export function captureDeviceClaimBindingInput(value: unknown): DeviceClaimBindingInput | null {
	const i = capture(value, ["signer", "currentIdentityId"]);
	const signer = i && captureAuthLinkSigner(i.signer);
	if (!i || !signer || !isAuthControllerId(i.currentIdentityId)) return null;
	return { signer, currentIdentityId: i.currentIdentityId };
}

/** Recognize only the trigger-independent batch assertion. Ordinary malformed
 * JSON, constraint failures and I/O errors retain their original unknown outcome.
 */
export function isDeviceClaimBindingConflict(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
		if (
			/(?:bad JSON path:|JSON path error near) ['"]device_claim_binding_count_mismatch['"]/.test(
				current.message,
			)
		)
			return true;
		current = current.cause;
	}
	return false;
}
