import { ownerEnrollmentOwnerCommitment } from "./owner-enrollment-admission.js";

/** NULL denotes the existing operator path, never an owner inferred from a device. */
export function validAdmissionOwnerHash(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

interface OwnerPin {
	admission_owner_hash: string | null;
	coordinator_id: string;
	issuer: string;
	account_subject: string | null;
	identity_id: string | null;
	link_id: string | null;
}

/** Recompute from independently verified, exact account/link facts, not the token companion. */
export async function matchesAdmissionOwner(row: OwnerPin): Promise<boolean> {
	if (!validAdmissionOwnerHash(row.admission_owner_hash)) return false;
	if (row.admission_owner_hash === null) return true;
	if (!row.account_subject || !row.identity_id || !row.link_id) return false;
	try {
		return (
			row.admission_owner_hash ===
			(await ownerEnrollmentOwnerCommitment({
				coordinatorId: row.coordinator_id,
				issuer: row.issuer,
				subject: row.account_subject,
				identityId: row.identity_id,
				linkId: row.link_id,
			}))
		);
	} catch {
		return false;
	}
}
