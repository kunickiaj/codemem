import { createHash } from "node:crypto";

/**
 * Locale-independent codepoint comparison. Every fingerprint and digest in the
 * recipient-policy feature relies on byte-identical ordering across machines,
 * so `localeCompare` (ICU-collation dependent) must never feed a digest.
 */
export function compareCodepoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalRecipientPolicyJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalRecipientPolicyJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.toSorted(([left], [right]) => compareCodepoints(left, right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalRecipientPolicyJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function recipientPolicyDigest(prefix: string, value: unknown): string {
	return `${prefix}:${createHash("sha256")
		.update(canonicalRecipientPolicyJson(value))
		.digest("hex")}`;
}

/**
 * Decision provenances owned by the invite flows. Activation deliberately
 * preserves these rows and readiness must tolerate them; every layer that
 * classifies decision ownership must use this single set — hand-repeated
 * literals with opposite polarity (allowlist vs denylist) are how the two
 * sides drift apart.
 */
export const INVITE_DECISION_PROVENANCES = ["team_invite", "coordinator_invite"] as const;

export function legacyTeamCandidateId(coordinatorId: string, groupId: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([coordinatorId, groupId]))
		.digest("hex")
		.slice(0, 32);
	return `legacy-team-candidate:${digest}`;
}

export function deterministicPolicyTeamId(teamCandidateId: string): string {
	return recipientPolicyDigest("policy-team-v1", teamCandidateId);
}

export function legacyTeamRosterFingerprint(
	devices: ReadonlyArray<{
		deviceId: string;
		fingerprint: string;
		enabled: boolean;
		identityId: string | null;
	}>,
): string {
	return recipientPolicyDigest(
		"legacy-team-roster-v1",
		devices
			.map((device) => ({
				deviceId: device.deviceId,
				fingerprint: device.fingerprint,
				enabled: device.enabled,
				identityId: device.identityId,
			}))
			.toSorted((left, right) => compareCodepoints(left.deviceId, right.deviceId)),
	);
}
