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

	close(): void {
		// No-op for D1 bindings.
	}

	createGroup(_groupId: string, _displayName?: string | null): void {
		notImplemented("createGroup");
	}

	getGroup(_groupId: string): CoordinatorGroup | null {
		notImplemented("getGroup");
	}

	listGroups(): CoordinatorGroup[] {
		notImplemented("listGroups");
	}

	enrollDevice(_groupId: string, _opts: CoordinatorEnrollDeviceInput): void {
		notImplemented("enrollDevice");
	}

	listEnrolledDevices(_groupId: string, _includeDisabled?: boolean): CoordinatorEnrollment[] {
		notImplemented("listEnrolledDevices");
	}

	getEnrollment(_groupId: string, _deviceId: string): CoordinatorEnrollment | null {
		notImplemented("getEnrollment");
	}

	renameDevice(_groupId: string, _deviceId: string, _displayName: string): boolean {
		notImplemented("renameDevice");
	}

	setDeviceEnabled(_groupId: string, _deviceId: string, _enabled: boolean): boolean {
		notImplemented("setDeviceEnabled");
	}

	removeDevice(_groupId: string, _deviceId: string): boolean {
		notImplemented("removeDevice");
	}

	recordNonce(_deviceId: string, _nonce: string, _createdAt: string): boolean {
		notImplemented("recordNonce");
	}

	cleanupNonces(_cutoff: string): void {
		notImplemented("cleanupNonces");
	}

	createInvite(_opts: CoordinatorCreateInviteInput): CoordinatorInvite {
		notImplemented("createInvite");
	}

	getInviteByToken(_token: string): CoordinatorInvite | null {
		notImplemented("getInviteByToken");
	}

	listInvites(_groupId: string): CoordinatorInvite[] {
		notImplemented("listInvites");
	}

	createJoinRequest(_opts: CoordinatorCreateJoinRequestInput): CoordinatorJoinRequest {
		notImplemented("createJoinRequest");
	}

	listJoinRequests(_groupId: string, _status?: string): CoordinatorJoinRequest[] {
		notImplemented("listJoinRequests");
	}

	reviewJoinRequest(
		_opts: CoordinatorReviewJoinRequestInput,
	): CoordinatorJoinRequestReviewResult | null {
		notImplemented("reviewJoinRequest");
	}

	upsertPresence(_opts: CoordinatorUpsertPresenceInput): CoordinatorPresenceRecord {
		notImplemented("upsertPresence");
	}

	listGroupPeers(_groupId: string, _requestingDeviceId: string): CoordinatorPeerRecord[] {
		notImplemented("listGroupPeers");
	}
}
