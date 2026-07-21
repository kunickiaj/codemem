import type { Database } from "./db.js";
import {
	RECIPIENT_POLICY_CONTRACT_VERSION,
	type RecipientPolicyContractVersion,
	type RecipientPolicyIdentityDeviceV1,
	type RecipientPolicyIdentityV1,
	type RecipientPolicyProjectRecipientV1,
	type RecipientPolicyTeamMembershipV1,
	type RecipientPolicyTeamV1,
} from "./recipient-policy-contract.js";

export interface RecipientPolicyIntentGraphV1 {
	version: RecipientPolicyContractVersion;
	identities: RecipientPolicyIdentityV1[];
	teams: RecipientPolicyTeamV1[];
	teamMemberships: RecipientPolicyTeamMembershipV1[];
	identityDevices: RecipientPolicyIdentityDeviceV1[];
	projectRecipients: RecipientPolicyProjectRecipientV1[];
}

function identityStatus(value: string): RecipientPolicyIdentityV1["status"] {
	return value === "pending" || value === "merged" ? value : "active";
}

export function listRecipientPolicyIntent(db: Database): RecipientPolicyIntentGraphV1 {
	const identities = db
		.prepare(
			`SELECT actor_id, display_name, is_local, status, merged_into_actor_id
			 FROM actors WHERE status <> 'deactivated'
			 ORDER BY display_name, actor_id`,
		)
		.all()
		.map((row): RecipientPolicyIdentityV1 => {
			const value = row as Record<string, unknown>;
			return {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				identityId: String(value.actor_id ?? ""),
				displayName: String(value.display_name ?? ""),
				kind: "other",
				verification: "local",
				status: identityStatus(String(value.status ?? "active")),
				mergedIntoIdentityId:
					typeof value.merged_into_actor_id === "string" && value.merged_into_actor_id
						? value.merged_into_actor_id
						: null,
			};
		});
	const teams = db
		.prepare(
			"SELECT team_id, display_name, status FROM policy_teams ORDER BY display_name, team_id",
		)
		.all()
		.map((row): RecipientPolicyTeamV1 => {
			const value = row as Record<string, unknown>;
			return {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				teamId: String(value.team_id ?? ""),
				displayName: String(value.display_name ?? ""),
				status: value.status === "archived" ? "archived" : "active",
			};
		});
	const teamMemberships = db
		.prepare(
			`SELECT team_id, identity_id, role, status FROM policy_team_memberships
			 ORDER BY team_id, identity_id`,
		)
		.all()
		.map((row): RecipientPolicyTeamMembershipV1 => {
			const value = row as Record<string, unknown>;
			const status = String(value.status ?? "active");
			return {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				teamId: String(value.team_id ?? ""),
				identityId: String(value.identity_id ?? ""),
				role: value.role === "admin" ? "admin" : "member",
				status: status === "pending" || status === "revoked" ? status : "active",
			};
		});
	const identityDevices = db
		.prepare(
			`SELECT identity_id, device_id, display_name, status FROM identity_devices
			 ORDER BY identity_id, device_id`,
		)
		.all()
		.map((row): RecipientPolicyIdentityDeviceV1 => {
			const value = row as Record<string, unknown>;
			return {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				identityId: String(value.identity_id ?? ""),
				deviceId: String(value.device_id ?? ""),
				displayName: String(value.display_name ?? ""),
				status: value.status === "revoked" ? "revoked" : "active",
			};
		});
	const projectRecipients = db
		.prepare(
			`SELECT canonical_project_identity, recipient_kind, recipient_id, status,
				provenance, policy_revision
			 FROM project_recipients
			 ORDER BY canonical_project_identity, recipient_kind, recipient_id`,
		)
		.all()
		.map((row): RecipientPolicyProjectRecipientV1 => {
			const value = row as Record<string, unknown>;
			const base = {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				canonicalProjectIdentity: String(value.canonical_project_identity ?? ""),
				intentSource:
					value.provenance === "user"
						? ("user" as const)
						: value.provenance === "exact_project_invite"
							? ("legacy_project_invite" as const)
							: ("migration" as const),
				policyRevision: String(value.policy_revision ?? ""),
				status: value.status === "revoked" ? ("revoked" as const) : ("active" as const),
			};
			return value.recipient_kind === "team"
				? { ...base, recipientKind: "team", teamId: String(value.recipient_id ?? "") }
				: { ...base, recipientKind: "identity", identityId: String(value.recipient_id ?? "") };
		});
	return {
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		identities,
		teams,
		teamMemberships,
		identityDevices,
		projectRecipients,
	};
}
