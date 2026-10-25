import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
	type AccountOwnerProfile,
	type AccountOwnerProfilePins,
	captureAccountOwnerProfilePins,
	loadPublicKey,
	readAccountLinkDevice,
	readAccountOwnerAssociation,
} from "@codemem/core";
import type { AccountContext, AccountContextReader } from "./context.js";
import { recoveryId, requireRecovery } from "./owner-recovery-evidence.js";
import type { RecoveryProfile, RecoverySelection } from "./owner-recovery-types.js";

export interface RecoveryCapture {
	context: AccountContext;
	groups: string[];
	publicKey: string;
	semanticId: string;
}
export function recoverySha(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function captureDevice(context: AccountContext): string {
	const before = statSync(context.dbPath, { bigint: true });
	const device = readAccountLinkDevice(context.dbPath);
	const publicKey = loadPublicKey(context.keysDir);
	const after = statSync(context.dbPath, { bigint: true });
	requireRecovery(
		before.isFile() &&
			before.dev === after.dev &&
			before.ino === after.ino &&
			after.dev.toString() === context.fileIdentity.dev &&
			after.ino.toString() === context.fileIdentity.ino &&
			device.deviceId === context.deviceId &&
			device.fingerprint === context.fingerprint &&
			recoverySha(device.publicKey) === context.publicKeyHash &&
			publicKey === device.publicKey,
	);
	return device.publicKey;
}
export function captureRecoveryContext(readContext: AccountContextReader): RecoveryCapture {
	let result = readContext();
	requireRecovery(!("error" in result) && result.groups.length > 0 && result.groups.length <= 25);
	if (!result.context) result = readContext(result.groups[0]);
	requireRecovery(!("error" in result) && result.setup === "ready" && result.context);
	const context = structuredClone(result.context);
	const groups = [...result.groups].sort();
	requireRecovery(
		groups.every(recoveryId) &&
			new Set(groups).size === groups.length &&
			recoveryId(context.identityId),
	);
	const publicKey = captureDevice(context);
	const semanticId = recoverySha(
		JSON.stringify([
			resolve(context.dbPath),
			context.keysDir === undefined ? null : resolve(context.keysDir),
			context.configPath === undefined ? null : resolve(context.configPath),
			context.fileIdentity,
			context.identityId,
			context.deviceId,
			context.publicKeyHash,
			context.fingerprint,
			context.coordinatorUrl,
			groups,
		]),
	);
	return { context, groups, publicKey, semanticId };
}
export function recoveryProfile(capture: RecoveryCapture, coordinatorId: string): RecoveryProfile {
	const context = capture.context;
	return {
		contextId: recoverySha(JSON.stringify([capture.semanticId, coordinatorId])),
		memoryActorId: context.identityId,
		deviceId: context.deviceId,
		fingerprint: context.fingerprint,
		coordinatorOrigin: context.coordinatorUrl,
		coordinatorId,
		configuredGroups: [...capture.groups],
	};
}
export function assertRecoverySelection(
	selection: RecoverySelection,
	expected: RecoveryProfile,
): void {
	requireRecovery(
		JSON.stringify(selection.profile) === JSON.stringify(expected) &&
			recoveryId(selection.existingOwnerId) &&
			Array.isArray(selection.groups) &&
			selection.groups.length > 0 &&
			selection.groups.length <= 25 &&
			new Set(selection.groups).size === selection.groups.length &&
			selection.groups.every((group) => expected.configuredGroups.includes(group)),
	);
}
export function recoveryDestinations(
	capture: RecoveryCapture,
	coordinatorId: string,
): Map<string, { profile: AccountOwnerProfile; pins: AccountOwnerProfilePins }> {
	return new Map(
		capture.groups.map((groupId) => {
			const profile: AccountOwnerProfile = {
				dbPath: capture.context.dbPath,
				deviceId: capture.context.deviceId,
				publicKey: capture.publicKey,
				fingerprint: capture.context.fingerprint,
				actorId: capture.context.identityId,
				coordinatorUrl: capture.context.coordinatorUrl,
				coordinatorId,
				groupId,
			};
			return [groupId, { profile, pins: captureAccountOwnerProfilePins(profile) }];
		}),
	);
}
export type RecoveryDestinations = ReturnType<typeof recoveryDestinations>;
export function assertNoCompetingOwner(
	destinations: RecoveryDestinations,
	ownerIdentityId: string,
): void {
	for (const { profile, pins } of destinations.values()) {
		const existing = readAccountOwnerAssociation(profile, { expectedProfilePins: pins });
		requireRecovery(!existing || existing.ownerIdentityId === ownerIdentityId);
	}
}
