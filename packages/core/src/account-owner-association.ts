import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

export type AccountOwnerProfilePins = Pick<
	AccountOwnerAssociation,
	| "databaseFile"
	| "deviceId"
	| "keyId"
	| "fingerprint"
	| "actorId"
	| "coordinatorUrl"
	| "coordinatorId"
	| "groupId"
>;

type AssociationOptions = { expectedProfilePins?: AccountOwnerProfilePins };
const PIN_FIELDS = [
	"databaseFile",
	"deviceId",
	"keyId",
	"fingerprint",
	"actorId",
	"coordinatorUrl",
	"coordinatorId",
	"groupId",
] as const;
const REVIEW_FIELDS = ["ownerIdentityId", "attestationId", "reviewDigest"] as const;

function invalidAssociation(): never {
	throw new Error("account_owner_association_invalid");
}

function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Local context only, not authority. Does not inspect the running actor or its config. */
export function captureAccountOwnerProfilePins(
	profile: AccountOwnerProfile,
): AccountOwnerProfilePins {
	const origin = normalizeCoordinatorAccountLinkOrigin(profile.coordinatorUrl);
	const key = parseSshEd25519PublicKey(profile.publicKey);
	if (
		!origin ||
		key.kind !== "ed25519" ||
		!isAuthControllerId(profile.actorId) ||
		!isAuthControllerId(profile.deviceId) ||
		!isAuthControllerId(profile.groupId) ||
		!isAuthControllerId(profile.coordinatorId) ||
		typeof profile.fingerprint !== "string" ||
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

const profilePins = captureAccountOwnerProfilePins;

function ownData(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object") return invalidAssociation();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return invalidAssociation();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(descriptors).length !== fields.length) return invalidAssociation();
	return Object.fromEntries(
		fields.map((field) => {
			const descriptor = descriptors[field];
			if (!Object.hasOwn(descriptors, field) || !descriptor || !("value" in descriptor))
				return invalidAssociation();
			return [field, descriptor.value];
		}),
	);
}

function captureStoredPins(value: Record<string, unknown>): AccountOwnerProfilePins {
	if (
		typeof value.databaseFile !== "string" ||
		!/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(value.databaseFile) ||
		!isAuthControllerId(value.deviceId) ||
		!isAuthControllerId(value.actorId) ||
		!isAuthControllerId(value.coordinatorId) ||
		!isAuthControllerId(value.groupId) ||
		typeof value.keyId !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.keyId) ||
		typeof value.fingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.fingerprint) ||
		typeof value.coordinatorUrl !== "string" ||
		normalizeCoordinatorAccountLinkOrigin(value.coordinatorUrl) !== value.coordinatorUrl
	)
		return invalidAssociation();
	return {
		databaseFile: value.databaseFile,
		deviceId: value.deviceId,
		keyId: value.keyId,
		fingerprint: value.fingerprint,
		actorId: value.actorId,
		coordinatorUrl: value.coordinatorUrl,
		coordinatorId: value.coordinatorId,
		groupId: value.groupId,
	};
}

function pinsMatch(value: AccountOwnerProfilePins, expected: AccountOwnerProfilePins): boolean {
	return PIN_FIELDS.every((field) => value[field] === expected[field]);
}

function captureStoredAssociation(input: unknown): AccountOwnerAssociation {
	const value = ownData(input, ["version", ...PIN_FIELDS, ...REVIEW_FIELDS]);
	const pins = captureStoredPins(value);
	if (
		value.version !== 1 ||
		!isAuthControllerId(value.ownerIdentityId) ||
		!isAuthControllerId(value.attestationId) ||
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
	const record = captureStoredAssociation(value);
	if (!pinsMatch(record, profilePins(profile))) return invalidAssociation();
	return record;
}

type GenerationContext = {
	dbPath: string;
	pins: AccountOwnerProfilePins;
	legacyPath: string;
	previousPath: string;
	path: string;
};

function captureGeneration(profile: AccountOwnerProfile, expected: unknown): GenerationContext {
	const expectedPins = captureStoredPins(ownData(expected, PIN_FIELDS));
	const dbPath = resolve(profile.dbPath);
	const pins = profilePins({ ...profile, dbPath });
	if (!pinsMatch(pins, expectedPins)) return invalidAssociation();
	const scope = hash(JSON.stringify([pins.coordinatorUrl, pins.coordinatorId, pins.groupId])).slice(
		0,
		32,
	);
	const base = `${dbPath}.account-owner-${scope}`;
	const generation = hash(JSON.stringify(pins));
	// Hash the DB basename so the final name and its .tmp-UUID staging name fit NAME_MAX.
	const boundedBase = join(dirname(dbPath), `${hash(basename(dbPath))}.account-owner-${scope}`);
	return {
		dbPath,
		pins,
		legacyPath: `${base}.json`,
		previousPath: `${base}-${generation}.json`,
		path: `${boundedBase}-${generation}.json`,
	};
}

function assertGenerationCurrent(profile: AccountOwnerProfile, context: GenerationContext): void {
	try {
		if (resolve(profile.dbPath) === context.dbPath && pinsMatch(profilePins(profile), context.pins))
			return;
	} catch {
		// A missing or newly unsafe database also invalidates the captured context.
	}
	throw new Error("account_owner_association_context_changed_outcome_unknown");
}

function readStoredAssociation(
	path: string,
	options: { historicalPath?: boolean } = {},
): AccountOwnerAssociation | null {
	try {
		lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error) {
			if (error.code === "ENOENT") return null;
			// Historical names may be impossible on this filesystem; existing evidence is still checked.
			if (options.historicalPath && error.code === "ENAMETOOLONG") return null;
		}
		return invalidAssociation();
	}
	try {
		const stat = lstatSync(path);
		if (typeof process.getuid === "function" && stat.uid !== process.getuid())
			return invalidAssociation();
		return captureStoredAssociation(readOwnerState(path));
	} catch {
		return invalidAssociation();
	}
}

function readGeneration(context: GenerationContext): AccountOwnerAssociation | null {
	// A valid current record must never hide malformed or unsafe older evidence.
	const legacy = readStoredAssociation(context.legacyPath, { historicalPath: true });
	const previous = readStoredAssociation(context.previousPath, { historicalPath: true });
	if (previous && !pinsMatch(previous, context.pins)) return invalidAssociation();
	const exact = readStoredAssociation(context.path);
	if (exact) {
		if (!pinsMatch(exact, context.pins)) return invalidAssociation();
		if (previous && JSON.stringify(previous) !== JSON.stringify(exact)) return invalidAssociation();
		return exact;
	}
	if (previous) return previous;
	if (legacy && pinsMatch(legacy, context.pins)) return legacy;
	return null;
}

/**
 * Read without initializing the database, changing the actor, or granting access.
 * Expected pins opt trusted local callers into exact generations; omitted pins keep legacy behavior.
 */
export function readAccountOwnerAssociation(
	profile: AccountOwnerProfile,
	options?: AssociationOptions,
): AccountOwnerAssociation | null {
	if (options?.expectedProfilePins !== undefined) {
		const context = captureGeneration(profile, options.expectedProfilePins);
		const record = readGeneration(context);
		assertGenerationCurrent(profile, context);
		return record;
	}
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

/**
 * Create-only publication after review; an exact retry never replaces prior owner evidence.
 * Generation checks cover this profile object and the DB file, not runtime actor/config state.
 * A future recovery service must check that state before and after calling this helper.
 * Pathname replacement and restoration between checks is not detected atomically.
 */
export function retainAccountOwnerAssociation(
	profile: AccountOwnerProfile,
	input: Pick<AccountOwnerAssociation, "ownerIdentityId" | "attestationId" | "reviewDigest">,
	options?: AssociationOptions,
): AccountOwnerAssociation {
	const review = ownData(input, REVIEW_FIELDS);
	if (options?.expectedProfilePins !== undefined)
		return retainGeneration(
			profile,
			review,
			captureGeneration(profile, options.expectedProfilePins),
		);
	const record = captureAssociation({ version: 1, ...profilePins(profile), ...review }, profile);
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

function retainGeneration(
	profile: AccountOwnerProfile,
	review: Record<string, unknown>,
	context: GenerationContext,
): AccountOwnerAssociation {
	const record = captureStoredAssociation({ version: 1, ...context.pins, ...review });
	const existing = readGeneration(context);
	assertGenerationCurrent(profile, context);
	if (existing) {
		if (JSON.stringify(existing) !== JSON.stringify(record)) return invalidAssociation();
		syncOwnerProfileDirectory(dirname(context.path));
		assertGenerationCurrent(profile, context);
		return existing;
	}
	try {
		retainOwnerState(context.path, record);
	} catch (error) {
		// Publication may already be visible. Never remove evidence on an ambiguous failure.
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
			return invalidAssociation();
	}
	assertGenerationCurrent(profile, context);
	const retained = readGeneration(context);
	if (!retained || JSON.stringify(retained) !== JSON.stringify(record)) return invalidAssociation();
	syncOwnerProfileDirectory(dirname(context.path));
	assertGenerationCurrent(profile, context);
	return retained;
}
