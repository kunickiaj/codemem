export interface CoordinatorGroup {
	group_id: string;
	display_name: string | null;
	created_at: string;
}

export interface CoordinatorEnrollment {
	group_id?: string;
	device_id: string;
	public_key?: string;
	fingerprint: string;
	display_name: string | null;
	enabled?: number;
	created_at?: string;
}

export interface CoordinatorInvite {
	invite_id: string;
	group_id: string;
	token: string;
	policy: string;
	expires_at: string;
	created_at: string;
	created_by: string | null;
	team_name_snapshot: string | null;
	revoked_at: string | null;
}

export interface CoordinatorJoinRequest {
	request_id: string;
	group_id: string;
	device_id: string;
	public_key?: string;
	fingerprint: string;
	display_name: string | null;
	token: string;
	status: string;
	created_at: string;
	reviewed_at: string | null;
	reviewed_by: string | null;
}

export interface CoordinatorJoinRequestReviewResult extends CoordinatorJoinRequest {
	_no_transition?: boolean;
}

export interface CoordinatorPresenceRecord {
	group_id: string;
	device_id: string;
	addresses: string[];
	expires_at: string;
}

export interface CoordinatorPeerRecord {
	device_id: string;
	fingerprint: string;
	display_name: string | null;
	addresses: string[];
	last_seen_at: string | null;
	expires_at: string | null;
	stale: boolean;
	capabilities: Record<string, unknown>;
}

export interface CoordinatorEnrollDeviceInput {
	deviceId: string;
	fingerprint: string;
	publicKey: string;
	displayName?: string | null;
}

export interface CoordinatorCreateInviteInput {
	groupId: string;
	policy: string;
	expiresAt: string;
	createdBy?: string | null;
}

export interface CoordinatorCreateJoinRequestInput {
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	displayName?: string | null;
	token: string;
}

export interface CoordinatorReviewJoinRequestInput {
	requestId: string;
	approved: boolean;
	reviewedBy?: string | null;
}

export interface CoordinatorUpsertPresenceInput {
	groupId: string;
	deviceId: string;
	addresses: string[];
	ttlS: number;
	capabilities?: Record<string, unknown> | null;
}

export interface CoordinatorStore {
	close(): void;
	createGroup(groupId: string, displayName?: string | null): void;
	getGroup(groupId: string): CoordinatorGroup | null;
	listGroups(): CoordinatorGroup[];
	enrollDevice(groupId: string, opts: CoordinatorEnrollDeviceInput): void;
	listEnrolledDevices(groupId: string, includeDisabled?: boolean): CoordinatorEnrollment[];
	getEnrollment(groupId: string, deviceId: string): CoordinatorEnrollment | null;
	renameDevice(groupId: string, deviceId: string, displayName: string): boolean;
	setDeviceEnabled(groupId: string, deviceId: string, enabled: boolean): boolean;
	removeDevice(groupId: string, deviceId: string): boolean;
	recordNonce(deviceId: string, nonce: string, createdAt: string): boolean;
	cleanupNonces(cutoff: string): void;
	createInvite(opts: CoordinatorCreateInviteInput): CoordinatorInvite;
	getInviteByToken(token: string): CoordinatorInvite | null;
	listInvites(groupId: string): CoordinatorInvite[];
	createJoinRequest(opts: CoordinatorCreateJoinRequestInput): CoordinatorJoinRequest;
	listJoinRequests(groupId: string, status?: string): CoordinatorJoinRequest[];
	reviewJoinRequest(
		opts: CoordinatorReviewJoinRequestInput,
	): CoordinatorJoinRequestReviewResult | null;
	upsertPresence(opts: CoordinatorUpsertPresenceInput): CoordinatorPresenceRecord;
	listGroupPeers(groupId: string, requestingDeviceId: string): CoordinatorPeerRecord[];
}
