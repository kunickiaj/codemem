import type { Database } from "./db.js";
import { isPolicyTeamMembershipActiveForMode } from "./policy-team-device-eligibility.js";
import {
	RECIPIENT_POLICY_CONTRACT_VERSION,
	type RecipientPolicyContractVersion,
	type RecipientPolicyIdentityDeviceV1,
	type RecipientPolicyIdentityV1,
	type RecipientPolicyProjectRecipientV1,
	type RecipientPolicyTeamMembershipV1,
	type RecipientPolicyTeamV1,
} from "./recipient-policy-contract.js";
import {
	canonicalRepositoryProjectIdentity,
	repositoryIdentitiesByWorkspace,
} from "./repository-mapping-aliases.js";

export interface RecipientPolicyIntentGraphV1 {
	version: RecipientPolicyContractVersion;
	identities: RecipientPolicyIdentityV1[];
	teams: RecipientPolicyTeamV1[];
	teamMemberships: RecipientPolicyTeamMembershipV1[];
	identityDevices: RecipientPolicyIdentityDeviceV1[];
	projectRecipients: RecipientPolicyProjectRecipientV1[];
}

function identityStatus(value: string): RecipientPolicyIdentityV1["status"] {
	if (value === "active" || value === "pending" || value === "merged") return value;
	return "pending";
}

function teamStatus(value: string): RecipientPolicyTeamV1["status"] {
	return value === "active" ? "active" : "archived";
}

function membershipStatus(
	value: string,
	deviceEligibilityMode: string,
): RecipientPolicyTeamMembershipV1["status"] {
	if (value === "pending" || value === "revoked") return value;
	if (isPolicyTeamMembershipActiveForMode(deviceEligibilityMode, value)) return "active";
	return "revoked";
}

function recipientIntentSource(
	provenance: unknown,
): RecipientPolicyProjectRecipientV1["intentSource"] {
	if (provenance === "user") return "user";
	if (provenance === "exact_project_invite") return "legacy_project_invite";
	return "migration";
}

function projectRecipientFromRow(
	value: Record<string, unknown>,
	repositoryIdentities: ReadonlyMap<string, string>,
): RecipientPolicyProjectRecipientV1 {
	const base = {
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		canonicalProjectIdentity: canonicalRepositoryProjectIdentity(
			repositoryIdentities,
			String(value.canonical_project_identity ?? ""),
		),
		intentSource: recipientIntentSource(value.provenance),
		policyRevision: String(value.policy_revision ?? ""),
		status: value.status === "active" ? ("active" as const) : ("revoked" as const),
	};
	if (value.recipient_kind === "team") {
		return { ...base, recipientKind: "team", teamId: String(value.recipient_id ?? "") };
	}
	return { ...base, recipientKind: "identity", identityId: String(value.recipient_id ?? "") };
}

function projectRecipientKey(recipient: RecipientPolicyProjectRecipientV1): string {
	const recipientId = recipient.recipientKind === "team" ? recipient.teamId : recipient.identityId;
	return `${recipient.canonicalProjectIdentity}\u0000${recipient.recipientKind}\u0000${recipientId}`;
}

function projectRecipientIntent(db: Database): RecipientPolicyProjectRecipientV1[] {
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const rows = db
		.prepare(
			`SELECT canonical_project_identity, recipient_kind, recipient_id, status,
			 provenance, policy_revision
			 FROM project_recipients
			 ORDER BY canonical_project_identity, recipient_kind, recipient_id`,
		)
		.all() as Array<Record<string, unknown>>;
	const recipients = new Map<string, RecipientPolicyProjectRecipientV1>();
	for (const value of rows) {
		const recipient = projectRecipientFromRow(value, repositoryIdentities);
		const key = projectRecipientKey(recipient);
		const current = recipients.get(key);
		if (!current || (current.status !== "active" && recipient.status === "active")) {
			recipients.set(key, recipient);
		}
	}
	return [...recipients.values()];
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
				status: identityStatus(String(value.status ?? "")),
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
				status: teamStatus(String(value.status ?? "")),
			};
		});
	const teamMemberships = db
		.prepare(
			`SELECT membership.team_id, membership.identity_id, membership.role, membership.status,
				team.device_eligibility_mode
			 FROM policy_team_memberships membership
			 LEFT JOIN policy_teams team ON team.team_id = membership.team_id
			 ORDER BY membership.team_id, membership.identity_id`,
		)
		.all()
		.map((row): RecipientPolicyTeamMembershipV1 => {
			const value = row as Record<string, unknown>;
			return {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				teamId: String(value.team_id ?? ""),
				identityId: String(value.identity_id ?? ""),
				role: value.role === "admin" ? "admin" : "member",
				status: membershipStatus(
					String(value.status ?? ""),
					String(value.device_eligibility_mode ?? ""),
				),
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
				status: value.status === "active" ? "active" : "revoked",
			};
		});
	const projectRecipients = projectRecipientIntent(db);
	return {
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		identities,
		teams,
		teamMemberships,
		identityDevices,
		projectRecipients,
	};
}
