import { createHash } from "node:crypto";

/**
 * Locale-independent UTF-16 code-unit comparison. Every fingerprint and digest
 * in the recipient-policy feature relies on byte-identical ordering across
 * machines, so `localeCompare` (ICU-collation dependent) must never feed a
 * digest.
 */
export function compareCodepoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

const INVALID_CANONICAL_JSON_MESSAGE = "Recipient policy value must be strict JSON data";

function invalidCanonicalJson(): never {
	throw new TypeError(INVALID_CANONICAL_JSON_MESSAGE);
}

function serializeJsonString(value: string): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return invalidCanonicalJson();
	return serialized;
}

function canonicalJson(value: unknown, ancestors: WeakSet<object>): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "string") return serializeJsonString(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0)) return invalidCanonicalJson();
		return String(value);
	}
	if (typeof value !== "object") return invalidCanonicalJson();
	if (ancestors.has(value)) return invalidCanonicalJson();

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) return invalidCanonicalJson();
			const keys = Reflect.ownKeys(value);
			if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
				return invalidCanonicalJson();
			}
			const children: string[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor?.enumerable || !("value" in descriptor)) return invalidCanonicalJson();
				children.push(canonicalJson(descriptor.value, ancestors));
			}
			return `[${children.join(",")}]`;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return invalidCanonicalJson();
		const entries = Reflect.ownKeys(value).map((key): [string, unknown] => {
			if (typeof key !== "string") return invalidCanonicalJson();
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) return invalidCanonicalJson();
			return [key, descriptor.value];
		});
		return `{${entries
			.toSorted(([left], [right]) => compareCodepoints(left, right))
			.map(([key, child]) => `${serializeJsonString(key)}:${canonicalJson(child, ancestors)}`)
			.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalRecipientPolicyJson(value: unknown): string {
	return canonicalJson(value, new WeakSet());
}

export function recipientPolicyDigest(prefix: string, value: unknown): string {
	// Node replaces unpaired UTF-16 surrogates with U+FFFD during UTF-8
	// encoding, so accepting them would make distinct domains hash identically.
	if (prefix.includes("\0") || !prefix.isWellFormed()) {
		throw new TypeError("Recipient policy digest prefix must be well-formed without NUL");
	}
	return `${prefix}:${createHash("sha256")
		.update(prefix, "utf8")
		.update("\0", "utf8")
		.update(canonicalRecipientPolicyJson(value), "utf8")
		.digest("hex")}`;
}

/**
 * Compatibility digest for identifiers persisted by released recipient-policy
 * flows before domain separation was introduced. New digest domains must use
 * `recipientPolicyDigest`; changing these bytes requires an explicit DB rekey.
 */
export function legacyRecipientPolicyDigest(prefix: string, value: unknown): string {
	return `${prefix}:${createHash("sha256")
		.update(canonicalRecipientPolicyJson(value), "utf8")
		.digest("hex")}`;
}

/**
 * Decision and membership provenances owned by the invite flows. Activation
 * deliberately preserves these rows and readiness must tolerate them; every
 * layer that classifies invite ownership must use this single set —
 * hand-repeated literals with opposite polarity (allowlist vs denylist) are
 * how the two sides drift apart.
 */
export const INVITE_DECISION_PROVENANCES = ["team_invite", "coordinator_invite"] as const;

export function legacyTeamCandidateId(coordinatorId: string, groupId: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([coordinatorId, groupId]))
		.digest("hex")
		.slice(0, 32);
	return `legacy-team-candidate:${digest}`;
}

export function legacyTeamProjectRef(candidateId: string, sourceProjectIdentity: string): string {
	return recipientPolicyDigest("legacy-team-project-ref-v1", [candidateId, sourceProjectIdentity]);
}

export function deterministicPolicyTeamId(teamCandidateId: string): string {
	return legacyRecipientPolicyDigest("policy-team-v1", teamCandidateId);
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
