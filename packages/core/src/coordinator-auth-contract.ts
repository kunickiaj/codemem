/**
 * Inert coordinator account-link policy. These results authenticate no claims,
 * grant no access, and must not be used as a runtime authorization gate.
 */
export interface CoordinatorAccountReference {
	readonly issuer: string;
	readonly subject: string;
}

export type CoordinatorAccountReferenceResult =
	| { ok: true; account: CoordinatorAccountReference }
	| {
			ok: false;
			error: "invalid_account_reference" | "invalid_issuer" | "issuer_mismatch" | "invalid_subject";
	  };

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function field(value: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function isIssuer(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^https:\/\//i.test(value) ||
		value !== value.trim() ||
		CONTROL_OR_FORMAT.test(value) ||
		value.includes("\\") ||
		value.includes("?") ||
		value.includes("#")
	) {
		return false;
	}
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname.length > 0 &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

export { isIssuer as isCoordinatorAccountIssuer };

function isSubject(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 255 &&
		value.trim().length > 0 &&
		!CONTROL_OR_FORMAT.test(value)
	);
}

function readAccountReference(value: unknown): CoordinatorAccountReferenceResult {
	if (!isRecord(value)) return { ok: false, error: "invalid_account_reference" };
	const issuer = field(value, "issuer");
	const subject = field(value, "subject");
	if (!isIssuer(issuer)) return { ok: false, error: "invalid_issuer" };
	if (!isSubject(subject)) return { ok: false, error: "invalid_subject" };
	return { ok: true, account: { issuer, subject } };
}

/** Shape validation only; the caller must authenticate the issuer and subject independently. */
export function parseCoordinatorAccountReference(
	value: unknown,
	options: { issuer: string },
): CoordinatorAccountReferenceResult {
	const configuredIssuer = isRecord(options) ? field(options, "issuer") : undefined;
	if (!isIssuer(configuredIssuer)) return { ok: false, error: "invalid_issuer" };
	const reference = readAccountReference(value);
	if (!reference.ok) return reference;
	if (reference.account.issuer !== configuredIssuer) {
		return { ok: false, error: "issuer_mismatch" };
	}
	return reference;
}

export interface CoordinatorAccountLink {
	readonly coordinatorId: string;
	readonly account: CoordinatorAccountReference;
	readonly identityId: string;
	readonly status: "active" | "revoked";
}

/**
 * Kind labels do not verify ownership. The caller must verify proofs first;
 * controller_verified means an existing trusted Identity-controlling device.
 */
export type CoordinatorIdentityOwnershipEvidence =
	| {
			readonly kind: "controller_verified" | "admin_verified";
			readonly coordinatorId: string;
			readonly identityId: string;
			readonly deviceId: string;
			readonly fingerprint: string;
	  }
	| { readonly kind: "invitation_claim" | "unavailable" };

export interface CoordinatorAccountLinkInput {
	readonly coordinatorId: string;
	readonly account: CoordinatorAccountReference;
	readonly identityId: string;
	readonly device: { readonly deviceId: string; readonly fingerprint: string };
	readonly ownership: CoordinatorIdentityOwnershipEvidence;
	readonly accountLink: CoordinatorAccountLink | null;
	readonly identityLink: CoordinatorAccountLink | null;
}

export type CoordinatorAccountLinkDecision =
	| {
			kind: "eligible";
			disposition: "create" | "existing";
			coordinatorId: string;
			identityId: string;
			account: CoordinatorAccountReference;
	  }
	| {
			kind: "rejected";
			error:
				| "invalid_link_input"
				| "ownership_review_required"
				| "ownership_mismatch"
				| "invalid_link_snapshot"
				| "account_link_conflict"
				| "identity_link_conflict"
				| "link_revoked";
	  };

function isId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value === value.trim() &&
		!CONTROL_OR_FORMAT.test(value)
	);
}

function sameAccount(
	left: CoordinatorAccountReference,
	right: CoordinatorAccountReference,
): boolean {
	return left.issuer === right.issuer && left.subject === right.subject;
}

function isFingerprint(value: unknown): value is string {
	return typeof value === "string" && FINGERPRINT.test(value);
}

interface ValidatedLinkInput {
	readonly coordinatorId: string;
	readonly identityId: string;
	readonly account: CoordinatorAccountReference;
	readonly deviceId: string;
	readonly fingerprint: string;
	readonly ownership: unknown;
	readonly accountLink: unknown;
	readonly identityLink: unknown;
}

function readLinkInput(input: unknown, options: { issuer: string }): ValidatedLinkInput | null {
	if (!isRecord(input)) return null;
	const coordinatorId = field(input, "coordinatorId");
	const identityId = field(input, "identityId");
	const accountValue = field(input, "account");
	const device = field(input, "device");
	const ownership = field(input, "ownership");
	const accountLink = field(input, "accountLink");
	const identityLink = field(input, "identityLink");
	if (!isRecord(device) || !isId(coordinatorId) || !isId(identityId)) return null;
	const deviceId = field(device, "deviceId");
	const fingerprint = field(device, "fingerprint");
	if (!isId(deviceId) || !isFingerprint(fingerprint)) return null;
	const account = parseCoordinatorAccountReference(accountValue, options);
	if (!account.ok) return null;
	return {
		coordinatorId,
		identityId,
		account: account.account,
		deviceId,
		fingerprint,
		ownership,
		accountLink,
		identityLink,
	};
}

function readLinkSnapshot(
	value: unknown,
	coordinatorId: string,
): CoordinatorAccountLink | undefined {
	if (!isRecord(value)) return undefined;
	const snapshotCoordinatorId = field(value, "coordinatorId");
	const identityId = field(value, "identityId");
	const status = field(value, "status");
	const account = readAccountReference(field(value, "account"));
	if (
		snapshotCoordinatorId !== coordinatorId ||
		!isId(identityId) ||
		(status !== "active" && status !== "revoked") ||
		!account.ok
	) {
		return undefined;
	}
	// A different issuer is a valid stored link, but conflicts with this request.
	return { coordinatorId, identityId, status, account: account.account };
}

function validateOwnership(expected: ValidatedLinkInput): CoordinatorAccountLinkDecision | null {
	const { ownership } = expected;
	if (!isRecord(ownership)) return { kind: "rejected", error: "invalid_link_input" };
	const kind = field(ownership, "kind");
	if (kind === "invitation_claim" || kind === "unavailable") {
		return { kind: "rejected", error: "ownership_review_required" };
	}
	if (kind !== "controller_verified" && kind !== "admin_verified") {
		return { kind: "rejected", error: "invalid_link_input" };
	}
	const coordinatorId = field(ownership, "coordinatorId");
	const identityId = field(ownership, "identityId");
	const deviceId = field(ownership, "deviceId");
	const fingerprint = field(ownership, "fingerprint");
	if (!isId(coordinatorId) || !isId(identityId) || !isId(deviceId) || !isFingerprint(fingerprint)) {
		return { kind: "rejected", error: "invalid_link_input" };
	}
	if (
		coordinatorId !== expected.coordinatorId ||
		identityId !== expected.identityId ||
		deviceId !== expected.deviceId ||
		fingerprint !== expected.fingerprint
	) {
		return { kind: "rejected", error: "ownership_mismatch" };
	}
	return null;
}

function validateSnapshots(expected: ValidatedLinkInput): CoordinatorAccountLinkDecision | null {
	const { coordinatorId, identityId, account } = expected;
	const accountLink =
		expected.accountLink === null ? null : readLinkSnapshot(expected.accountLink, coordinatorId);
	const identityLink =
		expected.identityLink === null ? null : readLinkSnapshot(expected.identityLink, coordinatorId);
	if (accountLink === undefined || identityLink === undefined) {
		return { kind: "rejected", error: "invalid_link_snapshot" };
	}
	if (accountLink !== null && !sameAccount(accountLink.account, account)) {
		return { kind: "rejected", error: "invalid_link_snapshot" };
	}
	if (identityLink !== null && identityLink.identityId !== identityId) {
		return { kind: "rejected", error: "invalid_link_snapshot" };
	}
	if (accountLink?.status === "revoked" || identityLink?.status === "revoked") {
		return { kind: "rejected", error: "link_revoked" };
	}
	if (accountLink !== null && accountLink.identityId !== identityId) {
		return { kind: "rejected", error: "account_link_conflict" };
	}
	if (identityLink !== null && !sameAccount(identityLink.account, account)) {
		return { kind: "rejected", error: "identity_link_conflict" };
	}
	if ((accountLink === null) !== (identityLink === null)) {
		return { kind: "rejected", error: "invalid_link_snapshot" };
	}
	return null;
}

/**
 * Metadata decision only. Supply trusted internal ownership evidence and a
 * same-coordinator snapshot; any future writer must recheck both links atomically.
 * Authentication protocol approval remains required before runtime integration.
 */
export function decideCoordinatorAccountLink(
	input: CoordinatorAccountLinkInput,
	options: { issuer: string },
): CoordinatorAccountLinkDecision {
	const validated = readLinkInput(input, options);
	if (!validated) return { kind: "rejected", error: "invalid_link_input" };
	const ownershipDecision = validateOwnership(validated);
	if (ownershipDecision) return ownershipDecision;
	const snapshotDecision = validateSnapshots(validated);
	if (snapshotDecision) return snapshotDecision;
	return {
		kind: "eligible",
		disposition: validated.accountLink === null ? "create" : "existing",
		coordinatorId: validated.coordinatorId,
		identityId: validated.identityId,
		account: validated.account,
	};
}
