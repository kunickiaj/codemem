import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { parseSshEd25519PublicKey } from "./coordinator-ed25519-key-id.js";
import {
	ownerDatabaseFile,
	readOwnerState,
	retainOwnerState,
	syncOwnerProfileDirectory,
} from "./coordinator-owner-profile-files.js";

export interface AccountOwnerProfile {
	dbPath: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	actorId: string;
	coordinatorUrl: string;
	coordinatorId: string;
	groupId: string;
}

/** Proposed account context only. Every consumer must recheck remote authority. */
export interface AccountOwnerAssociation {
	version: 1;
	databaseFile: string;
	deviceId: string;
	keyId: string;
	fingerprint: string;
	actorId: string;
	coordinatorUrl: string;
	coordinatorId: string;
	groupId: string;
	ownerIdentityId: string;
	attestationId: string;
	reviewDigest: string;
}

function invalidAssociation(): never {
	throw new Error("account_owner_association_invalid");
}

function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function profilePins(profile: AccountOwnerProfile) {
	const origin = normalizeCoordinatorAccountLinkOrigin(profile.coordinatorUrl);
	const key = parseSshEd25519PublicKey(profile.publicKey);
	if (
		!origin ||
		key.kind !== "ed25519" ||
		!isAuthControllerId(profile.actorId) ||
		!isAuthControllerId(profile.deviceId) ||
		!isAuthControllerId(profile.groupId) ||
		!isAuthControllerId(profile.coordinatorId) ||
		!/^[a-f0-9]{64}$/.test(profile.fingerprint)
	)
		return invalidAssociation();
	return {
		databaseFile: ownerDatabaseFile(profile.dbPath),
		deviceId: profile.deviceId,
		keyId: hash(key.blob),
		fingerprint: profile.fingerprint,
		actorId: profile.actorId,
		coordinatorUrl: origin,
		coordinatorId: profile.coordinatorId,
		groupId: profile.groupId,
	};
}

function associationPath(profile: AccountOwnerProfile): string {
	const origin = normalizeCoordinatorAccountLinkOrigin(profile.coordinatorUrl);
	if (!origin || !isAuthControllerId(profile.groupId)) return invalidAssociation();
	const scope = hash(JSON.stringify([origin, profile.coordinatorId, profile.groupId])).slice(0, 32);
	return `${resolve(profile.dbPath)}.account-owner-${scope}.json`;
}

function captureAssociation(
	value: Record<string, unknown>,
	profile: AccountOwnerProfile,
): AccountOwnerAssociation {
	const pins = profilePins(profile);
	const fields = [
		"version",
		...Object.keys(pins),
		"ownerIdentityId",
		"attestationId",
		"reviewDigest",
	];
	if (
		Object.keys(value).length !== fields.length ||
		fields.some((field) => !Object.hasOwn(value, field)) ||
		value.version !== 1 ||
		Object.entries(pins).some(([field, expected]) => value[field] !== expected) ||
		!isAuthControllerId(value.ownerIdentityId) ||
		typeof value.attestationId !== "string" ||
		!/^controller-v1:[a-f0-9]{64}$/.test(value.attestationId) ||
		typeof value.reviewDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.reviewDigest)
	)
		return invalidAssociation();
	return {
		version: 1,
		...pins,
		ownerIdentityId: value.ownerIdentityId,
		attestationId: value.attestationId,
		reviewDigest: value.reviewDigest,
	};
}

/** Read without initializing the database, changing the actor, or granting access. */
export function readAccountOwnerAssociation(
	profile: AccountOwnerProfile,
): AccountOwnerAssociation | null {
	const path = associationPath(profile);
	try {
		lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return null;
		return invalidAssociation();
	}
	try {
		const stat = lstatSync(path);
		if (typeof process.getuid === "function" && stat.uid !== process.getuid())
			return invalidAssociation();
		return captureAssociation(readOwnerState(path), profile);
	} catch {
		return invalidAssociation();
	}
}

/** Create-only publication after review; an exact retry never replaces prior owner evidence. */
export function retainAccountOwnerAssociation(
	profile: AccountOwnerProfile,
	input: Pick<AccountOwnerAssociation, "ownerIdentityId" | "attestationId" | "reviewDigest">,
): AccountOwnerAssociation {
	const record = captureAssociation({ version: 1, ...profilePins(profile), ...input }, profile);
	const existing = readAccountOwnerAssociation(profile);
	if (existing) {
		if (JSON.stringify(existing) !== JSON.stringify(record)) return invalidAssociation();
		syncOwnerProfileDirectory(dirname(associationPath(profile)));
		return existing;
	}
	try {
		retainOwnerState(associationPath(profile), record);
	} catch (error) {
		// Another publisher may have retained this exact review while we were preparing it.
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
			return invalidAssociation();
	}
	const retained = readAccountOwnerAssociation(profile);
	if (!retained || JSON.stringify(retained) !== JSON.stringify(record)) return invalidAssociation();
	syncOwnerProfileDirectory(dirname(associationPath(profile)));
	return retained;
}
