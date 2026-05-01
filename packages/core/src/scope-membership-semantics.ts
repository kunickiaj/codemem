export const SCOPE_MEMBERSHIP_REVOCATION_LIMITATION =
	"Revocation prevents future sync only; it does not remove data already copied to the revoked device.";

export interface ScopeMembershipRevocationNotice {
	scope_id: string;
	device_id: string;
	membership_epoch: number | null;
	prevents_future_sync: true;
	deletes_already_copied_data: false;
	message: string;
}

export interface ScopeMembershipEpochStatus {
	membership_epoch: number | null;
	required_epoch: number | null;
	stale: boolean;
	reason: "current" | "stale_epoch" | "unknown_epoch";
}

export function scopeMembershipEpochStatus(input: {
	membershipEpoch?: number | null;
	requiredEpoch?: number | null;
}): ScopeMembershipEpochStatus {
	const membershipEpoch = Number.isFinite(input.membershipEpoch)
		? Number(input.membershipEpoch)
		: null;
	const requiredEpoch = Number.isFinite(input.requiredEpoch) ? Number(input.requiredEpoch) : null;
	if (membershipEpoch == null || requiredEpoch == null) {
		return {
			membership_epoch: membershipEpoch,
			required_epoch: requiredEpoch,
			stale: false,
			reason: "unknown_epoch",
		};
	}
	return {
		membership_epoch: membershipEpoch,
		required_epoch: requiredEpoch,
		stale: membershipEpoch < requiredEpoch,
		reason: membershipEpoch < requiredEpoch ? "stale_epoch" : "current",
	};
}

export function explainScopeMembershipRevocation(input: {
	scopeId: string;
	deviceId: string;
	membershipEpoch?: number | null;
}): ScopeMembershipRevocationNotice {
	return {
		scope_id: input.scopeId,
		device_id: input.deviceId,
		membership_epoch: Number.isFinite(input.membershipEpoch) ? Number(input.membershipEpoch) : null,
		prevents_future_sync: true,
		deletes_already_copied_data: false,
		message: SCOPE_MEMBERSHIP_REVOCATION_LIMITATION,
	};
}
