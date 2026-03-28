import type {
	CoordinatorCreateInviteInput,
	CoordinatorCreateJoinRequestInput,
	CoordinatorEnrollDeviceInput,
	CoordinatorEnrollment,
	CoordinatorGroup,
	CoordinatorInvite,
	CoordinatorJoinRequest,
	CoordinatorJoinRequestReviewResult,
	CoordinatorPeerRecord,
	CoordinatorPresenceRecord,
	CoordinatorReviewJoinRequestInput,
	CoordinatorStore,
	CoordinatorUpsertPresenceInput,
} from "./coordinator-store-contract.js";

/**
 * Experimental D1 adapter scaffold.
 *
 * This is intentionally internal for now while the sync-only store contract
 * is still being validated against an async backend shape.
 */

export interface D1PreparedStatementLike {
	bind(...values: unknown[]): D1PreparedStatementLike;
	first<T = unknown>(): Promise<T | null>;
	run(): Promise<unknown>;
	all<T = unknown>(): Promise<{ results?: T[] }>;
	raw<T = unknown>(): Promise<T[]>;
}

export interface D1DatabaseLike {
	prepare(query: string): D1PreparedStatementLike;
	batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
	exec?(query: string): Promise<unknown>;
}

function notImplemented(method: string): never {
	throw new Error(`D1CoordinatorStore.${method} is not implemented yet.`);
}

export class D1CoordinatorStore implements CoordinatorStore {
	readonly db: D1DatabaseLike;

	constructor(db: D1DatabaseLike) {
		this.db = db;
	}

	async close(): Promise<void> {
		// No-op for D1 bindings.
	}

	async createGroup(_groupId: string, _displayName?: string | null): Promise<void> {
		notImplemented("createGroup");
	}

	async getGroup(_groupId: string): Promise<CoordinatorGroup | null> {
		notImplemented("getGroup");
	}

	async listGroups(): Promise<CoordinatorGroup[]> {
		notImplemented("listGroups");
	}

	async enrollDevice(_groupId: string, _opts: CoordinatorEnrollDeviceInput): Promise<void> {
		notImplemented("enrollDevice");
	}

	async listEnrolledDevices(
		_groupId: string,
		_includeDisabled?: boolean,
	): Promise<CoordinatorEnrollment[]> {
		notImplemented("listEnrolledDevices");
	}

	async getEnrollment(_groupId: string, _deviceId: string): Promise<CoordinatorEnrollment | null> {
		notImplemented("getEnrollment");
	}

	async renameDevice(_groupId: string, _deviceId: string, _displayName: string): Promise<boolean> {
		notImplemented("renameDevice");
	}

	async setDeviceEnabled(_groupId: string, _deviceId: string, _enabled: boolean): Promise<boolean> {
		notImplemented("setDeviceEnabled");
	}

	async removeDevice(_groupId: string, _deviceId: string): Promise<boolean> {
		notImplemented("removeDevice");
	}

	async recordNonce(_deviceId: string, _nonce: string, _createdAt: string): Promise<boolean> {
		notImplemented("recordNonce");
	}

	async cleanupNonces(_cutoff: string): Promise<void> {
		notImplemented("cleanupNonces");
	}

	async createInvite(_opts: CoordinatorCreateInviteInput): Promise<CoordinatorInvite> {
		notImplemented("createInvite");
	}

	async getInviteByToken(_token: string): Promise<CoordinatorInvite | null> {
		notImplemented("getInviteByToken");
	}

	async listInvites(_groupId: string): Promise<CoordinatorInvite[]> {
		notImplemented("listInvites");
	}

	async createJoinRequest(
		_opts: CoordinatorCreateJoinRequestInput,
	): Promise<CoordinatorJoinRequest> {
		notImplemented("createJoinRequest");
	}

	async listJoinRequests(_groupId: string, _status?: string): Promise<CoordinatorJoinRequest[]> {
		notImplemented("listJoinRequests");
	}

	async reviewJoinRequest(
		_opts: CoordinatorReviewJoinRequestInput,
	): Promise<CoordinatorJoinRequestReviewResult | null> {
		notImplemented("reviewJoinRequest");
	}

	async upsertPresence(_opts: CoordinatorUpsertPresenceInput): Promise<CoordinatorPresenceRecord> {
		notImplemented("upsertPresence");
	}

	async listGroupPeers(
		_groupId: string,
		_requestingDeviceId: string,
	): Promise<CoordinatorPeerRecord[]> {
		notImplemented("listGroupPeers");
	}
}
