import {
	coordinatorGetLegacyTeamCompletionAction,
	coordinatorListDevicesAction,
	coordinatorListRemovedDevicesAction,
} from "./coordinator-actions.js";
import {
	fetchBlockedDeviceIdsForGroup,
	type PeerRemovalLookupEntry,
} from "./coordinator-peer-revocation.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import type { CoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { coordinatorReadTeamGroupBindingsAction } from "./coordinator-team-group-binding-client.js";
import type { CoordinatorTeamGroupBinding } from "./coordinator-team-group-bindings.js";
import { coordinatorListTeamMemberRemovalsAction } from "./coordinator-team-member-removal-client.js";
import type { CoordinatorTeamMemberRemoval } from "./coordinator-team-member-removals.js";
import type { Database } from "./db.js";
import { deterministicPolicyTeamId } from "./recipient-policy-identifiers.js";
import type { MemoryStore } from "./store.js";
import { buildBaseUrl } from "./sync-http-client.js";
import type { TeamRecoveryEvidenceReading } from "./team-recovery-commit.js";
import type { TeamRecoveryDeviceRemoval } from "./team-recovery-devices.js";
import type { TeamRecoveryEvidence } from "./team-recovery-preview.js";

/*
 * Reads the evidence a Team recovery needs from the coordinator, for one
 * request. Each part is read on its own, and a part that fails reads as
 * unavailable, so the recovery names it and changes nothing.
 *
 * The reader says where each part came from by what it asked: the coordinator
 * and the group of its own requests. Nothing in a reply decides that. The block
 * checks follow the same rule: each answer carries the device and the key this
 * machine sent, and only the blocked flag comes from the coordinator.
 */

/** What the reader asks about. The coordinator is the one every read is sent to. */
export interface TeamRecoveryEvidenceTarget {
	coordinatorId: string;
	groupId: string;
	teamId: string;
	candidateRef: string;
}

/** The coordinator reads, replaced in tests. Each throws when its read fails. */
export interface TeamRecoveryEvidenceActions {
	/** Every device enrolled in the group, disabled ones included. */
	listDevices(groupId: string): Promise<readonly CoordinatorEnrollment[]>;
	/** The coordinator's device removal records, blocked devices included. */
	listDeviceRemovals(): Promise<readonly TeamRecoveryDeviceRemoval[]>;
	/** The IDs among `peers` that the coordinator blocks, asked as a member of the group. */
	blockedDeviceIds(
		groupId: string,
		peers: readonly Required<PeerRemovalLookupEntry>[],
	): Promise<readonly string[]>;
	/** The coordinator's copy of the completed setup, or null when it holds none. */
	getCompletion(groupId: string, candidateRef: string): Promise<unknown>;
	listMemberRemovals(groupId: string): Promise<readonly CoordinatorTeamMemberRemoval[]>;
	readGroupBinding(teamId: string): Promise<CoordinatorTeamGroupBinding>;
}

const UNAVAILABLE = { status: "unavailable" } as const;

/** One part of the evidence, or unavailable when its read fails for any reason. */
async function part<T extends object>(
	read: () => Promise<T>,
): Promise<({ status: "read" } & T) | typeof UNAVAILABLE> {
	try {
		return { status: "read", ...(await read()) };
	} catch {
		return UNAVAILABLE;
	}
}

/**
 * The group's devices, and whether the coordinator blocks each one. The block
 * check asks about every enrolled device under the key the roster lists, so it
 * waits for the roster.
 */
async function readRosterAndBlocks(
	target: TeamRecoveryEvidenceTarget,
	actions: TeamRecoveryEvidenceActions,
): Promise<Pick<TeamRecoveryEvidence, "roster" | "deviceBlocks">> {
	const source = { coordinatorId: target.coordinatorId, groupId: target.groupId };
	let enrolled: readonly CoordinatorEnrollment[];
	try {
		enrolled = await actions.listDevices(target.groupId);
	} catch {
		return { roster: UNAVAILABLE, deviceBlocks: UNAVAILABLE };
	}
	const devices = enrolled.map((device) => ({
		deviceId: device.device_id,
		fingerprint: device.fingerprint,
		displayName: device.display_name ?? "Device",
		enabled: device.enabled === 1,
	}));
	const peers = enrolled.map((device) => ({
		device_id: device.device_id,
		public_key: device.public_key,
	}));
	const deviceBlocks = await part(async () => {
		const blocked = new Set(await actions.blockedDeviceIds(target.groupId, peers));
		// The device and key of each answer are the ones sent, never ones a reply names.
		const checks = peers.map((peer) => ({
			deviceId: peer.device_id,
			publicKey: peer.public_key,
			blocked: blocked.has(peer.device_id),
		}));
		return { source, checks };
	});
	return { roster: { status: "read", source, devices }, deviceBlocks };
}

/**
 * Reads every part of the evidence now. `startedAtMs` is this machine's clock
 * before the first read is sent, which is what a recovery measures the age of
 * its evidence from.
 */
export async function readTeamRecoveryEvidence(
	target: TeamRecoveryEvidenceTarget,
	actions: TeamRecoveryEvidenceActions,
	nowMs: () => number = Date.now,
): Promise<TeamRecoveryEvidenceReading> {
	const startedAtMs = nowMs();
	const here = { coordinatorId: target.coordinatorId };
	const group = { ...here, groupId: target.groupId };
	const [rosterAndBlocks, deviceRemovals, completion, memberRemovals, groupBinding] =
		await Promise.all([
			readRosterAndBlocks(target, actions),
			part(async () => ({ source: here, removals: await actions.listDeviceRemovals() })),
			part(async () => ({
				source: group,
				manifest: await actions.getCompletion(target.groupId, target.candidateRef),
			})),
			part(async () => ({
				source: group,
				removals: await actions.listMemberRemovals(target.groupId),
			})),
			part(async () => ({
				source: here,
				binding: await actions.readGroupBinding(target.teamId),
			})),
		]);
	return {
		startedAtMs,
		evidence: { ...rosterAndBlocks, deviceRemovals, completion, memberRemovals, groupBinding },
	};
}

/**
 * The setup that completed the Team: its coordinator, group and candidate.
 * Null for a Team no reviewed setup on this machine completed.
 */
export function teamRecoveryTarget(
	db: Database,
	teamId: string,
): TeamRecoveryEvidenceTarget | null {
	const setup = db
		.prepare(
			`SELECT candidate_id, coordinator_id, group_id FROM legacy_team_setup_drafts
			 WHERE completed_team_id = ? AND state = 'completed' ORDER BY rowid DESC LIMIT 1`,
		)
		.get(teamId) as { candidate_id: string; coordinator_id: string; group_id: string } | undefined;
	if (!setup || deterministicPolicyTeamId(setup.candidate_id) !== teamId) return null;
	return {
		coordinatorId: setup.coordinator_id,
		groupId: setup.group_id,
		teamId,
		candidateRef: setup.candidate_id,
	};
}

/**
 * The reads against the configured coordinator. The admin reads carry the
 * admin secret, and a request that carries it never follows a redirect. The
 * block check is signed by this device as a member of the group it asks.
 */
export function coordinatorTeamRecoveryEvidenceActions(
	store: Pick<MemoryStore, "db" | "dbPath">,
	config: CoordinatorSyncConfig,
	device: { localDeviceId: string; keysDir?: string },
): TeamRecoveryEvidenceActions {
	const remoteUrl = buildBaseUrl(config.syncCoordinatorUrl);
	const adminSecret = config.syncCoordinatorAdminSecret;
	const timeoutS = Math.max(1, config.syncCoordinatorTimeoutS);
	const admin = { remoteUrl, adminSecret, timeoutS };
	return {
		listDevices: (groupId) =>
			coordinatorListDevicesAction({ groupId, includeDisabled: true, ...admin }),
		listDeviceRemovals: () =>
			coordinatorListRemovedDevicesAction({
				includeBlocked: true,
				remote: { url: remoteUrl, adminSecret, timeoutS },
			}),
		blockedDeviceIds: (groupId, peers) =>
			fetchBlockedDeviceIdsForGroup(store, config, { ...device, groupId }, peers),
		getCompletion: (groupId, candidateRef) =>
			coordinatorGetLegacyTeamCompletionAction({ groupId, candidateRef, ...admin }),
		listMemberRemovals: (groupId) => coordinatorListTeamMemberRemovalsAction({ groupId, ...admin }),
		readGroupBinding: async (teamId) => {
			const [binding] = await coordinatorReadTeamGroupBindingsAction({
				...admin,
				teamIds: [teamId],
			});
			if (!binding) throw new Error("team_group_binding_response_invalid");
			return binding;
		},
	};
}
