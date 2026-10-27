import {
	type coordinatorAuthControllerReviewAction,
	legacyDecisionCountsAsOwner,
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
		// Another device's guessed label is not a recorded owner.
		if (decision.device_id !== deviceId || !recoveryId(identityId)) return [];
		if (!legacyDecisionCountsAsOwner(decision)) return [];
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

// The browser also rejects the whole response above this many candidates.
const MAX_CANDIDATES = 256;

export function candidateList(
	owners: Map<string, Set<string>>,
	currentIdentityId: string,
): RecoveryOwnerCandidate[] {
	// Sort this profile's Identity first so the cap never drops it.
	const rank = (id: string) => (id === currentIdentityId ? 0 : 1);
	return [...owners.entries()]
		.sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
		.slice(0, MAX_CANDIDATES)
		.map(([id, groups]) => {
			const prefix = id === currentIdentityId ? "This profile's Identity," : "Identity";
			return { id, label: candidateLabel(prefix, [...groups]) };
		});
}

/**
 * The coordinator returns this device's history across all groups once it finds an
 * enrollment. It hides the enrollment on an identity mismatch but still sends the
 * history, so non-empty history also counts as complete.
 */
function hasCompleteHistory(response: unknown): boolean {
	const row = response as { enrollment?: unknown; legacy_history?: unknown } | null;
	const enrolled = row?.enrollment !== null && typeof row?.enrollment === "object";
	return enrolled || historyRows(response).length > 0;
}

/**
 * Suggest owners from read-only coordinator previews of this device's current review.
 * Suggestions are display hints: the scoped owner preview still checks the chosen ID.
 *
 * Previews share the coordinator's admin review rate limit with the owner preview and
 * confirmation. History is filtered by device, not group, so this asks one group at a
 * time and stops at the first enrolled group instead of spending one request per group.
 */
export async function readRecoveryCandidates(options: {
	previewDeviceOwner: typeof coordinatorAuthControllerReviewAction;
	remoteUrl: string;
	adminSecret: string;
	groups: readonly string[];
	device: CandidateDevice;
	timeoutS?: number;
}): Promise<RecoveryOwnerCandidate[]> {
	const { device } = options;
	const responses: unknown[] = [];
	for (const groupId of options.groups) {
		let response: unknown;
		try {
			response = await options.previewDeviceOwner({
				remoteUrl: options.remoteUrl,
				adminSecret: options.adminSecret,
				groupId,
				deviceId: device.deviceId,
				fingerprint: device.fingerprint,
				identityId: device.identityId,
				timeoutS: options.timeoutS,
			});
		} catch {
			continue;
		}
		responses.push(response);
		if (hasCompleteHistory(response)) break;
	}
	return candidateList(recordedOwnerGroups(responses, device), device.identityId);
}
