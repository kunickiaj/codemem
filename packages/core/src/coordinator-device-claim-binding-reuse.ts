import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { DeviceClaimBindingInput } from "./coordinator-device-claim-binding-contract.js";
import type { PreparedDeviceClaimBinding } from "./coordinator-device-claim-binding-sql.js";

export interface ExistingFirstLinkBinding {
	device_id: string;
	key_id: string;
	identity_id: string;
	coordinator_id: string;
	binding_id: string;
	provenance: "owner_enrollment" | "reviewed_legacy_migration";
	source_ref: string;
	bound_at: string;
}
const COLUMNS = [
	"device_id",
	"key_id",
	"identity_id",
	"coordinator_id",
	"binding_id",
	"provenance",
	"source_ref",
	"bound_at",
] as const;

/** Missing means mint. Null means contradictory ownership, never authority. */
export async function readExistingFirstLinkBinding(
	backend: AuthLinkBackend,
	input: DeviceClaimBindingInput,
	coordinatorId: string,
	keyId: string,
): Promise<ExistingFirstLinkBinding | null | undefined> {
	const row = await backend.first<{ rows: string }>({
		sql: `SELECT json_group_array(json_object(${COLUMNS.map((c) => `'${c}',${c}`).join(",")})) AS rows FROM coordinator_device_ownership_bindings WHERE device_id=? OR key_id=?`,
		values: [input.signer.deviceId, keyId],
	});
	const rows = JSON.parse(row?.rows ?? "[]") as ExistingFirstLinkBinding[];
	if (rows.length === 0) return undefined;
	const binding = rows[0];
	if (
		rows.length !== 1 ||
		!binding ||
		binding.device_id !== input.signer.deviceId ||
		binding.key_id !== keyId ||
		binding.identity_id !== input.currentIdentityId ||
		binding.coordinator_id !== coordinatorId
	)
		return null;
	if (
		!["owner_enrollment", "reviewed_legacy_migration"].includes(binding.provenance) ||
		!binding.binding_id ||
		!binding.source_ref ||
		!binding.bound_at
	)
		return null;
	return binding;
}

export function existingFirstLinkBindingPin(binding: ExistingFirstLinkBinding): AuthLinkStatement {
	return {
		sql: `EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b WHERE ${COLUMNS.map((c) => `b.${c} IS ?`).join(" AND ")})`,
		values: COLUMNS.map((c) => binding[c]),
	};
}

/** A failing projection runs before table triggers, including RAISE(IGNORE). */
export function assertPredicate(predicate: AuthLinkStatement): AuthLinkStatement {
	return {
		sql: `INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
 SELECT json_extract('{}','device_claim_binding_count_mismatch'),NULL,NULL,NULL,NULL,NULL,NULL,NULL WHERE NOT (${predicate.sql})`,
		values: predicate.values,
	};
}

/** Existing positive ownership keeps its original receipt/provenance. Only this
 * device's NULL enrollment fields may change after the claim's winning writes.
 */
export function reuseFirstLinkBindingStatements(
	plan: PreparedDeviceClaimBinding,
	binding: ExistingFirstLinkBinding,
): AuthLinkStatement[] {
	const pin = existingFirstLinkBindingPin(binding);
	const { input } = plan;
	if (!plan.completedGuard) throw new Error("first_link_binding_plan_incomplete");
	return [
		...plan.negativeGuards,
		assertPredicate({ sql: `EXISTS (${plan.guard.sql})`, values: plan.guard.values }),
		{
			sql: `UPDATE enrolled_devices SET identity_id=? WHERE device_id=? AND identity_id IS NULL AND public_key=? AND fingerprint=? AND ${pin.sql}`,
			values: [
				input.currentIdentityId,
				input.signer.deviceId,
				input.signer.publicKey,
				input.signer.fingerprint,
				...pin.values,
			],
		},
		assertPredicate({ sql: "changes()=?", values: [plan.nullCount] }),
		// Only the retained facts: this batch's own claim and enrollment writes change the rest.
		...plan.completedNegativeGuards,
		assertPredicate({
			sql: `EXISTS (${plan.completedGuard.sql})`,
			values: plan.completedGuard.values,
		}),
	];
}
