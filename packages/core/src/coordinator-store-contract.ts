export interface CoordinatorGroup {
	group_id: string;
	display_name: string | null;
	archived_at: string | null;
	created_at: string;
}

export interface CoordinatorEnrollment {
	group_id: string;
	device_id: string;
	public_key: string;
	fingerprint: string;
	display_name: string | null;
	enabled: number;
	created_at: string;
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
	public_key: string;
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
	bootstrap_grant?: CoordinatorBootstrapGrant | null;
}

export interface CoordinatorReviewJoinRequestBootstrapGrantInput {
	seedDeviceId: string;
	expiresAt: string;
	createdBy?: string | null;
}

export interface CoordinatorPresenceRecord {
	group_id: string;
	device_id: string;
	addresses: string[];
	expires_at: string;
}

export interface CoordinatorPeerRecord {
	device_id: string;
	public_key: string;
	fingerprint: string;
	display_name: string | null;
	addresses: string[];
	last_seen_at: string | null;
	expires_at: string | null;
	stale: boolean;
	capabilities: Record<string, unknown>;
}

export interface CoordinatorReciprocalApproval {
	request_id: string;
	group_id: string;
	requesting_device_id: string;
	requested_device_id: string;
	status: string;
	created_at: string;
	resolved_at: string | null;
}

export interface CoordinatorBootstrapGrant {
	grant_id: string;
	group_id: string;
	seed_device_id: string;
	worker_device_id: string;
	expires_at: string;
	created_at: string;
	created_by: string | null;
	revoked_at: string | null;
}

export interface CoordinatorScope {
	scope_id: string;
	label: string;
	kind: string;
	authority_type: string;
	coordinator_id: string | null;
	group_id: string | null;
	manifest_issuer_device_id: string | null;
	membership_epoch: number;
	manifest_hash: string | null;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface CoordinatorScopeMembership {
	scope_id: string;
	device_id: string;
	role: string;
	status: string;
	membership_epoch: number;
	coordinator_id: string | null;
	group_id: string | null;
	manifest_issuer_device_id: string | null;
	manifest_hash: string | null;
	signed_manifest_json: string | null;
	updated_at: string;
}

export type CoordinatorScopeMembershipAuditAction = "grant" | "revoke";

export interface CoordinatorScopeMembershipAuditEvent {
	event_id: number;
	action: CoordinatorScopeMembershipAuditAction;
	scope_id: string;
	device_id: string;
	role: string | null;
	status: string;
	membership_epoch: number;
	previous_role: string | null;
	previous_status: string | null;
	previous_membership_epoch: number | null;
	coordinator_id: string | null;
	group_id: string | null;
	actor_type: string | null;
	actor_id: string | null;
	manifest_hash: string | null;
	created_at: string;
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
	bootstrapGrant?: CoordinatorReviewJoinRequestBootstrapGrantInput | null;
}

export interface CoordinatorUpsertPresenceInput {
	groupId: string;
	deviceId: string;
	addresses: string[];
	ttlS: number;
	capabilities?: Record<string, unknown> | null;
}

export interface CoordinatorCreateReciprocalApprovalInput {
	groupId: string;
	requestingDeviceId: string;
	requestedDeviceId: string;
}

export interface CoordinatorCreateBootstrapGrantInput {
	groupId: string;
	seedDeviceId: string;
	workerDeviceId: string;
	expiresAt: string;
	createdBy?: string | null;
}

export interface CoordinatorCreateScopeInput {
	scopeId: string;
	label: string;
	kind?: string | null;
	authorityType?: string | null;
	coordinatorId?: string | null;
	groupId?: string | null;
	manifestIssuerDeviceId?: string | null;
	membershipEpoch?: number | null;
	manifestHash?: string | null;
	status?: string | null;
}

export interface CoordinatorUpdateScopeInput {
	/** Internal sharing-domain identifier (`scope_id`). */
	scopeId: string;
	/** User-facing Sharing domain label. Omitted fields keep existing metadata. */
	label?: string | null;
	kind?: string | null;
	authorityType?: string | null;
	coordinatorId?: string | null;
	groupId?: string | null;
	manifestIssuerDeviceId?: string | null;
	membershipEpoch?: number | null;
	manifestHash?: string | null;
	status?: string | null;
}

export interface CoordinatorListScopesInput {
	coordinatorId?: string | null;
	groupId?: string | null;
	status?: string | null;
	includeInactive?: boolean;
}

export interface CoordinatorGrantScopeMembershipInput {
	scopeId: string;
	deviceId: string;
	role?: string | null;
	membershipEpoch?: number | null;
	/** Optional assertion; persisted authority is derived from the referenced scope. */
	coordinatorId?: string | null;
	/** Optional assertion; persisted authority is derived from the referenced scope. */
	groupId?: string | null;
	manifestIssuerDeviceId?: string | null;
	manifestHash?: string | null;
	signedManifestJson?: string | null;
	actorType?: string | null;
	actorId?: string | null;
}

export interface CoordinatorRevokeScopeMembershipInput {
	scopeId: string;
	deviceId: string;
	membershipEpoch?: number | null;
	manifestHash?: string | null;
	signedManifestJson?: string | null;
	actorType?: string | null;
	actorId?: string | null;
}

export interface CoordinatorListScopeMembershipAuditInput {
	scopeId: string;
	deviceId?: string | null;
	limit?: number | null;
}

export interface CoordinatorListReciprocalApprovalsInput {
	groupId: string;
	deviceId: string;
	direction: "incoming" | "outgoing";
	status?: string;
}

export interface CoordinatorStore {
	close(): Promise<void>;
	createGroup(groupId: string, displayName?: string | null): Promise<void>;
	getGroup(groupId: string): Promise<CoordinatorGroup | null>;
	listGroups(includeArchived?: boolean): Promise<CoordinatorGroup[]>;
	renameGroup(groupId: string, displayName: string): Promise<boolean>;
	archiveGroup(groupId: string, archivedAt?: string): Promise<boolean>;
	unarchiveGroup(groupId: string): Promise<boolean>;
	enrollDevice(groupId: string, opts: CoordinatorEnrollDeviceInput): Promise<void>;
	listEnrolledDevices(groupId: string, includeDisabled?: boolean): Promise<CoordinatorEnrollment[]>;
	getEnrollment(groupId: string, deviceId: string): Promise<CoordinatorEnrollment | null>;
	renameDevice(groupId: string, deviceId: string, displayName: string): Promise<boolean>;
	setDeviceEnabled(groupId: string, deviceId: string, enabled: boolean): Promise<boolean>;
	removeDevice(groupId: string, deviceId: string): Promise<boolean>;
	recordNonce(deviceId: string, nonce: string, createdAt: string): Promise<boolean>;
	cleanupNonces(cutoff: string): Promise<void>;
	createInvite(opts: CoordinatorCreateInviteInput): Promise<CoordinatorInvite>;
	getInviteByToken(token: string): Promise<CoordinatorInvite | null>;
	listInvites(groupId: string): Promise<CoordinatorInvite[]>;
	createJoinRequest(opts: CoordinatorCreateJoinRequestInput): Promise<CoordinatorJoinRequest>;
	listJoinRequests(groupId: string, status?: string): Promise<CoordinatorJoinRequest[]>;
	reviewJoinRequest(
		opts: CoordinatorReviewJoinRequestInput,
	): Promise<CoordinatorJoinRequestReviewResult | null>;
	createReciprocalApproval(
		opts: CoordinatorCreateReciprocalApprovalInput,
	): Promise<CoordinatorReciprocalApproval>;
	createBootstrapGrant(
		opts: CoordinatorCreateBootstrapGrantInput,
	): Promise<CoordinatorBootstrapGrant>;
	createScope(opts: CoordinatorCreateScopeInput): Promise<CoordinatorScope>;
	updateScope(opts: CoordinatorUpdateScopeInput): Promise<CoordinatorScope | null>;
	listScopes(opts?: CoordinatorListScopesInput): Promise<CoordinatorScope[]>;
	grantScopeMembership(
		opts: CoordinatorGrantScopeMembershipInput,
	): Promise<CoordinatorScopeMembership>;
	revokeScopeMembership(opts: CoordinatorRevokeScopeMembershipInput): Promise<boolean>;
	listScopeMemberships(
		scopeId: string,
		includeRevoked?: boolean,
	): Promise<CoordinatorScopeMembership[]>;
	listScopeMembershipAuditEvents(
		opts: CoordinatorListScopeMembershipAuditInput,
	): Promise<CoordinatorScopeMembershipAuditEvent[]>;
	getBootstrapGrant(grantId: string): Promise<CoordinatorBootstrapGrant | null>;
	listBootstrapGrants(groupId: string): Promise<CoordinatorBootstrapGrant[]>;
	revokeBootstrapGrant(grantId: string, revokedAt?: string): Promise<boolean>;
	listReciprocalApprovals(
		opts: CoordinatorListReciprocalApprovalsInput,
	): Promise<CoordinatorReciprocalApproval[]>;
	upsertPresence(opts: CoordinatorUpsertPresenceInput): Promise<CoordinatorPresenceRecord>;
	listGroupPeers(groupId: string, requestingDeviceId: string): Promise<CoordinatorPeerRecord[]>;
}

export interface CoordinatorBootstrapGrantVerification {
	grant: CoordinatorBootstrapGrant;
	worker_enrollment: CoordinatorEnrollment;
}
