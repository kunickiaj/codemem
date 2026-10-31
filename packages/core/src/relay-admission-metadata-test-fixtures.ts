import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";
import {
	RELAY_ADMISSION_METADATA_GATE_SQL,
	RELAY_ADMISSION_METADATA_RETURNING_SQL,
} from "./relay-admission-metadata-schema.js";

export const METADATA_INSERT_SQL = `INSERT INTO relay_clock_test_nonces(device_id,nonce,created_at)
SELECT ?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE ${RELAY_ADMISSION_CLOCK_SQL}>=0 AND ${RELAY_ADMISSION_CLOCK_SQL}<?4
AND (${RELAY_ADMISSION_METADATA_GATE_SQL})
ON CONFLICT(device_id,nonce) DO NOTHING
RETURNING device_id AS deviceId,nonce,?3 AS attemptId,
${RELAY_ADMISSION_CLOCK_SQL} AS decidedAtMs,created_at AS createdAt,
${RELAY_ADMISSION_METADATA_RETURNING_SQL}`;

export const METADATA_POLICY_INSERT =
	"INSERT INTO relay_admission_authority_policy(authority_id,policy_revision,operator_state) VALUES (?1,?2,?3)";
export const METADATA_AUDIENCE_INSERT =
	"INSERT INTO relay_admission_audiences(authority_id,audience_id,state,changed_revision) VALUES (?1,?2,?3,?4)";
export const METADATA_REALM_INSERT =
	"INSERT INTO relay_admission_realms(authority_id,group_id,operator_state,changed_revision) VALUES (?1,?2,?3,?4)";
export const METADATA_READINESS_INSERT =
	"INSERT INTO relay_admission_readiness(authority_id,scope,group_id,revision,state,observed_at_ms) VALUES (?1,?2,?3,?4,?5,?6)";

export const METADATA_CONTEXT = {
	authority: "a".repeat(64),
	group: "group-A",
	audience: "f".repeat(64),
};
export const METADATA_ASSOCIATION = {
	deviceId: "device-A",
	nonce: "b".repeat(32),
	attemptId: "c".repeat(32),
};
export const METADATA_NOW = 130_000;
export type MetadataStatement = { sql: string; values: (string | number | null)[] };
export type MetadataSeedOptions = {
	authority?: string;
	group?: string;
	audience?: string;
	policyRevision?: number;
	operatorState?: string;
	audienceState?: string;
	realmState?: string;
	authorityState?: string;
	healthState?: string;
	authorityObserved?: number | null;
	realmObserved?: number | null;
	omit?: "policy" | "audience" | "realm" | "authorityHealth" | "realmHealth";
};

// Test-only publications. Production exposes no installer or metadata writer.
export function metadataSeed(options: MetadataSeedOptions = {}): MetadataStatement[] {
	const authority = options.authority ?? METADATA_CONTEXT.authority;
	const group = options.group ?? METADATA_CONTEXT.group;
	const revision = options.policyRevision ?? 1;
	const policy = {
		sql: METADATA_POLICY_INSERT,
		values: [authority, revision, options.operatorState ?? "enabled"],
	};
	const audience = {
		sql: METADATA_AUDIENCE_INSERT,
		values: [
			authority,
			options.audience ?? METADATA_CONTEXT.audience,
			options.audienceState ?? "enabled",
			revision,
		],
	};
	const realm = {
		sql: METADATA_REALM_INSERT,
		values: [authority, group, options.realmState ?? "enabled", revision],
	};
	const authorityHealth = {
		sql: METADATA_READINESS_INSERT,
		values: [
			authority,
			"authority",
			"",
			1,
			options.authorityState ?? "ready",
			options.authorityObserved === undefined ? METADATA_NOW : options.authorityObserved,
		],
	};
	const realmHealth = {
		sql: METADATA_READINESS_INSERT,
		values: [
			authority,
			"realm",
			group,
			1,
			options.healthState ?? "ready",
			options.realmObserved === undefined ? METADATA_NOW : options.realmObserved,
		],
	};
	const entries: [string, MetadataStatement][] = [
		["policy", policy],
		["audience", audience],
		["realm", realm],
		["authorityHealth", authorityHealth],
		["realmHealth", realmHealth],
	];
	return entries
		.filter(([key]) => includeSeed(key, options.omit))
		.map(([, statement]) => statement);
}

// Never create orphan fixtures when testing a missing required parent.
function includeSeed(key: string, omit: MetadataSeedOptions["omit"]) {
	if (omit === "policy" || key === omit) return false;
	return key !== "realmHealth" || (omit !== "realm" && omit !== "authorityHealth");
}

export function metadataBindings(
	options: { authority?: string; group?: string; audience?: string; policyRevision?: number } = {},
) {
	return [
		METADATA_ASSOCIATION.deviceId,
		METADATA_ASSOCIATION.nonce,
		METADATA_ASSOCIATION.attemptId,
		Number.MAX_SAFE_INTEGER,
		options.authority ?? METADATA_CONTEXT.authority,
		options.group ?? METADATA_CONTEXT.group,
		options.audience ?? METADATA_CONTEXT.audience,
		options.policyRevision ?? 1,
	];
}
