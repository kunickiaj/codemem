import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	type NegativeOwnerGuards,
	readNegativeOwnerConsistency,
	readUnknownNamespaceOwnerConsistency,
} from "./coordinator-owner-negative-read-set.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";

export function validateRecipientOwnerInput(input: CoordinatorConsumeRecipientInviteInput): void {
	if (
		!input.identityId ||
		!input.deviceId ||
		!input.publicKey ||
		!input.fingerprint ||
		input.identityId !== input.identityId.trim() ||
		input.deviceId !== input.deviceId.trim() ||
		input.identityId.length > 256 ||
		input.deviceId.length > 256 ||
		/[\p{Cc}\p{Cf}]/u.test(input.identityId) ||
		/[\p{Cc}\p{Cf}]/u.test(input.deviceId)
	)
		throw new Error("invite_identity_conflict");
}

/** Reads the recipient's retained ownership. Null refuses the invite. */
export function readRecipientOwnerConsistency(
	backend: Pick<AuthLinkBackend, "first" | "all" | "readBatch">,
	input: CoordinatorConsumeRecipientInviteInput,
): Promise<NegativeOwnerGuards | null> {
	if (input.coordinatorId === undefined)
		return readUnknownNamespaceOwnerConsistency(backend, input);
	if (!isAuthControllerId(input.coordinatorId)) return Promise.resolve(null);
	return readNegativeOwnerConsistency(backend, {
		coordinatorId: input.coordinatorId,
		ownerIdentityId: input.identityId,
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
	});
}
