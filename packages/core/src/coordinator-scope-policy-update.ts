import type {
	CoordinatorScope,
	CoordinatorUpdateScopeInput,
} from "./coordinator-store-contract.js";
import { normalizeCoordinatorUpdateScopeInput } from "./coordinator-store-input-rules.js";

/** Pin the row used to normalize omitted fields. In particular, a concurrent move
 * must not overwrite a new group's policy and invalidate the old group instead. */
export function scopePolicyUpdate(
	opts: CoordinatorUpdateScopeInput,
	old: CoordinatorScope,
	now: string,
) {
	const next = normalizeCoordinatorUpdateScopeInput(opts, old);
	const previous = [
		old.kind,
		old.authority_type,
		old.coordinator_id,
		old.group_id,
		old.manifest_issuer_device_id,
		old.membership_epoch,
		old.manifest_hash,
		old.status,
	];
	const policy = [
		next.kind,
		next.authorityType,
		next.coordinatorId,
		next.groupId,
		next.manifestIssuerDeviceId,
		next.membershipEpoch,
		next.manifestHash,
		next.status,
	];
	const columns =
		"kind,authority_type,coordinator_id,group_id,manifest_issuer_device_id,membership_epoch,manifest_hash,status";
	return {
		write: {
			sql: `UPDATE coordinator_scopes SET (label,${columns},updated_at)=(?,?,?,?,?,?,?,?,?,?)
WHERE scope_id=? AND (label,${columns}) IS (?,?,?,?,?,?,?,?,?)`,
			values: [next.label, ...policy, now, next.scopeId, old.label, ...previous],
		},
		invalidate: policy.some((value, i) => value !== previous[i])
			? {
					sql: `UPDATE groups SET readiness_generation=NULL WHERE changes()=1
AND readiness_generation IS NOT NULL AND group_id IN (?,?)`,
					values: [old.group_id, next.groupId],
				}
			: null,
	};
}
