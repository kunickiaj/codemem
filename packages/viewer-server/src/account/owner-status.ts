import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
	type AccountOwnerAssociation,
	type CoordinatorResolvedAccountOwnerStatusRead,
	captureAccountOwnerProfilePins,
	type ResolvedAccountOwnerStatus,
	readAccountLinkDevice,
	readAccountOwnerAssociation,
	readAccountOwnerAssociationRetainedAtMs,
	readCompletedLocalIdentitySwitches,
} from "@codemem/core";
import type { AccountContext } from "./context.js";
import type { AccountLinkViewV1 } from "./status.js";

/** The coordinator ID comes from the first signed actor-status read, never the origin. */
export function readOwnerAssociation(
	context: AccountContext,
	coordinatorId: string,
): AccountOwnerAssociation | null {
	// Legacy trusted test/embedding readers do not supply public evidence.
	if (context.publicKeyHash === undefined) return null;
	const before = statSync(context.dbPath, { bigint: true });
	const device = readAccountLinkDevice(context.dbPath);
	const profileFor = (actorId: string) => {
		const profile = { ...context, publicKey: device.publicKey, actorId, coordinatorId };
		return { profile, expectedProfilePins: captureAccountOwnerProfilePins(profile) };
	};
	const evidence: AssociationEvidence = {
		// Exact generations are keyed by every pin, including the actor.
		generation: (actorId) => {
			const { profile, expectedProfilePins } = profileFor(actorId);
			return readAccountOwnerAssociation(profile, { expectedProfilePins });
		},
		generationRetainedAtMs: (actorId) => {
			const { profile, expectedProfilePins } = profileFor(actorId);
			return readAccountOwnerAssociationRetainedAtMs(profile, { expectedProfilePins });
		},
		// The legacy file is shared by every actor in this coordinator and group.
		legacy: (actorId) => readAccountOwnerAssociation(profileFor(actorId).profile),
		legacyRetainedAtMs: (actorId) =>
			readAccountOwnerAssociationRetainedAtMs(profileFor(actorId).profile),
	};
	const association = readCurrentAssociation(context, evidence);
	const after = statSync(context.dbPath, { bigint: true });
	if (
		!before.isFile() ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		after.dev.toString() !== context.fileIdentity.dev ||
		after.ino.toString() !== context.fileIdentity.ino ||
		device.deviceId !== context.deviceId ||
		createHash("sha256").update(device.publicKey).digest("hex") !== context.publicKeyHash ||
		device.fingerprint !== context.fingerprint
	)
		throw new Error("account_owner_association_invalid");
	return association;
}

type AssociationEvidence = {
	generation: (actorId: string) => AccountOwnerAssociation | null;
	generationRetainedAtMs: (actorId: string) => number | null;
	legacy: (actorId: string) => AccountOwnerAssociation | null;
	legacyRetainedAtMs: (actorId: string) => number | null;
};
type Switches = ReturnType<typeof readCompletedLocalIdentitySwitches>;

/** A switch away from `actorId` completed after evidence published at `retainedAtMs`. */
function switchedAwayAfter(switches: Switches, actorId: string, retainedAtMs: number | null) {
	return (
		retainedAtMs !== null &&
		switches.some((s) => s.previousIdentityId === actorId && s.completedAtMs > retainedAtMs)
	);
}

/** The shared legacy file pins a previous Identity whose switch superseded it. */
function legacySuperseded(evidence: AssociationEvidence, switches: Switches): boolean {
	return [...new Set(switches.map((s) => s.previousIdentityId))].some((actorId) => {
		try {
			return (
				evidence.legacy(actorId) !== null &&
				switchedAwayAfter(switches, actorId, evidence.legacyRetainedAtMs(actorId))
			);
		} catch {
			return false;
		}
	});
}

/**
 * A switch away from the pinned Identity, completed after the association was
 * published, supersedes it for good. Read failures are suppressed only for the
 * shared legacy file, and only when it pins such a superseded Identity; a
 * failing exact generation for the current Identity is always reported.
 */
function readCurrentAssociation(
	context: AccountContext,
	evidence: AssociationEvidence,
): AccountOwnerAssociation | null {
	const current = context.identityId;
	const generation = evidence.generation(current);
	const switches = () => readCompletedLocalIdentitySwitches(context.dbPath);
	if (generation)
		return switchedAwayAfter(switches(), current, evidence.generationRetainedAtMs(current))
			? null
			: generation;
	let legacy: AccountOwnerAssociation | null;
	try {
		legacy = evidence.legacy(current);
	} catch (error) {
		if (legacySuperseded(evidence, switches())) return null;
		throw error;
	}
	if (!legacy) return null;
	// Returning to the pinned Identity after switching away doesn't revive it.
	return switchedAwayAfter(switches(), current, evidence.legacyRetainedAtMs(current))
		? null
		: legacy;
}

export function ownerUnavailable(
	view: AccountLinkViewV1,
	code: "account_owner_association_invalid" | "context_changed",
): AccountLinkViewV1 {
	return {
		...withoutOwnerCapabilities(view),
		remote: { kind: "unavailable", code },
		canLink: false,
		blockedReason: code === "context_changed" ? "status_unavailable" : "review_required",
	};
}

function withoutOwnerCapabilities(view: AccountLinkViewV1): AccountLinkViewV1 {
	const { managementActions, unlinkTarget, accountOwner, ownerProjection, ...local } = view;
	return local;
}

function ownerProfile(value: unknown): NonNullable<ResolvedAccountOwnerStatus["profile"]> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	const profile: NonNullable<ResolvedAccountOwnerStatus["profile"]> = {};
	for (const [field, limit] of [
		["displayName", 256],
		["email", 320],
		["pictureUrl", 2048],
	] as const) {
		const text = source[field];
		if (text === undefined) continue;
		if (
			typeof text !== "string" ||
			!text.trim() ||
			text.length > limit ||
			/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text)
		)
			return null;
		if (field === "pictureUrl" && !safeOwnerPicture(text)) return null;
		profile[field] = text;
	}
	return profile;
}

function safeOwnerPicture(text: string): boolean {
	try {
		const url = new URL(text);
		return (
			url.protocol === "https:" &&
			url.hostname === "lh3.googleusercontent.com" &&
			!url.username &&
			!url.password &&
			!url.port
		);
	} catch {
		return false;
	}
}

export function associatedOwnerView(
	view: AccountLinkViewV1,
	context: AccountContext,
	association: AccountOwnerAssociation,
	remote: CoordinatorResolvedAccountOwnerStatusRead,
): AccountLinkViewV1 {
	const contextId = createHash("sha256")
		.update(JSON.stringify({ version: "account-owner-view-v1", context, association }))
		.digest("hex");
	const base = { ...withoutOwnerCapabilities(view), contextId };
	if (
		remote?.kind !== "owner_status" ||
		!remote.status ||
		remote.status.version !== 1 ||
		remote.status.coordinatorId !== association.coordinatorId ||
		remote.status.groupId !== context.groupId ||
		remote.status.deviceId !== context.deviceId ||
		remote.status.fingerprint !== context.fingerprint ||
		remote.status.ownerIdentity !== association.ownerIdentityId ||
		remote.status.state !== "owner_confirmed"
	)
		return ownerUnavailable(base, "account_owner_association_invalid");
	const status = remote.status;
	const profile = status.profileState === "linked" ? ownerProfile(status.profile) : null;
	if (
		(status.profileState === "linked" && profile === null) ||
		(status.profileState !== "linked" &&
			((status.profileState !== "account_unlinked" && status.profileState !== "unavailable") ||
				status.profile !== null))
	)
		return ownerUnavailable(base, "account_owner_association_invalid");
	const subject = {
		version: 1 as const,
		coordinatorId: status.coordinatorId,
		groupId: status.groupId,
		deviceId: status.deviceId,
		fingerprint: status.fingerprint,
		state: "owner_confirmed" as const,
		ownerIdentity: status.ownerIdentity,
	};
	let confirmed: Extract<ResolvedAccountOwnerStatus, { state: "owner_confirmed" }>;
	if (status.profileState === "linked" && profile) {
		confirmed = { ...subject, profileState: "linked", profile };
	} else if (status.profileState === "account_unlinked" || status.profileState === "unavailable") {
		confirmed = { ...subject, profileState: status.profileState, profile: null };
	} else {
		return ownerUnavailable(base, "account_owner_association_invalid");
	}
	// This is a current authenticated transport read, not a signed response or a grant.
	return {
		...base,
		accountOwner: { identityId: association.ownerIdentityId, memoryActorId: context.identityId },
		remote: { kind: "not_checked" },
		ownerProjection: {
			kind: "resolved_account_owner",
			status: confirmed,
		},
		canLink: false,
		blockedReason: profile ? "already_linked" : "status_unavailable",
	};
}
