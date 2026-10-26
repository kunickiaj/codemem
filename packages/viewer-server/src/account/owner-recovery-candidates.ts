import {
	type coordinatorAuthControllerReviewAction,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "@codemem/core";
import { recoveryId } from "./owner-recovery-evidence.js";

export interface RecoveryOwnerCandidate {
	id: string;
	label?: string;
}
interface CandidateDevice {
	deviceId: string;
	fingerprint: string;
	identityId: string;
}

function historyRows(response: unknown): unknown[] {
	const history = (response as { legacy_history?: unknown } | null)?.legacy_history;
	return Array.isArray(history) ? history : [];
}

/** Return [identity, group] pairs for this device, or none when the record is unreadable. */
function recordedOwners(row: unknown, deviceId: string): Array<[string, string]> {
	const record = row as { group_id?: unknown; manifest?: unknown } | null;
	const groupId = record?.group_id;
	if (!recoveryId(groupId)) return [];
	let manifest: ReturnType<typeof normalizeCoordinatorLegacyTeamCompletionManifest>;
	try {
		manifest = normalizeCoordinatorLegacyTeamCompletionManifest(record?.manifest);
	} catch {
		return [];
	}
	return manifest.device_decisions.flatMap((decision): Array<[string, string]> => {
		const identityId = decision.identity_id;
		if (decision.device_id !== deviceId || !recoveryId(identityId)) return [];
		return [[identityId, groupId]];
	});
}

/** Map each Identity recorded for this device to the groups whose Team history records it. */
export function recordedOwnerGroups(
	responses: readonly unknown[],
	device: Pick<CandidateDevice, "deviceId">,
): Map<string, Set<string>> {
	const owners = new Map<string, Set<string>>();
	const pairs = responses
		.flatMap(historyRows)
		.flatMap((row) => recordedOwners(row, device.deviceId));
	for (const [identityId, groupId] of pairs) {
		owners.set(identityId, new Set([...(owners.get(identityId) ?? []), groupId]));
	}
	return owners;
}

// The browser rejects the whole profile response when any candidate label exceeds this.
const MAX_LABEL_LENGTH = 256;
const LISTED_GROUPS = 3;

function candidateLabel(prefix: string, groups: readonly string[]): string {
	const sorted = [...groups].sort();
	const listed = sorted.slice(0, LISTED_GROUPS).join(", ");
	const more = sorted.length - LISTED_GROUPS;
	const named = more > 0 ? `${listed} and ${more} more` : listed;
	const label = `${prefix} recorded for this device in ${named}`;
	if (label.length <= MAX_LABEL_LENGTH) return label;
	// Long group IDs: fall back to a count, which always fits.
	const count = sorted.length === 1 ? "1 group" : `${sorted.length} groups`;
	return `${prefix} recorded for this device in ${count}`;
}

export function candidateList(
	owners: Map<string, Set<string>>,
	currentIdentityId: string,
): RecoveryOwnerCandidate[] {
	return [...owners.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([id, groups]) => {
			const prefix = id === currentIdentityId ? "This profile's Identity," : "Identity";
			return { id, label: candidateLabel(prefix, [...groups]) };
		});
}

/**
 * Suggest owners from read-only coordinator previews of this device's current review.
 * Suggestions are display hints: the scoped owner preview still checks the chosen ID.
 */
export async function readRecoveryCandidates(options: {
	previewDeviceOwner: typeof coordinatorAuthControllerReviewAction;
	remoteUrl: string;
	adminSecret: string;
	groups: readonly string[];
	device: CandidateDevice;
}): Promise<RecoveryOwnerCandidate[]> {
	const { device } = options;
	const results = await Promise.allSettled(
		options.groups.map((groupId) =>
			options.previewDeviceOwner({
				remoteUrl: options.remoteUrl,
				adminSecret: options.adminSecret,
				groupId,
				deviceId: device.deviceId,
				fingerprint: device.fingerprint,
				identityId: device.identityId,
			}),
		),
	);
	const responses = results.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	return candidateList(recordedOwnerGroups(responses, device), device.identityId);
}
