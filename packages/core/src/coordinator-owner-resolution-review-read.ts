import { readConnectionSchemaState } from "./coordinator-account-connection-schema.js";
import { CONNECTION_NOT_REVOKED_SQL } from "./coordinator-account-connection-storage.js";
import type {
	CoordinatorAuthControllerAttestation,
	CoordinatorAuthControllerVerifiedSnapshot,
} from "./coordinator-auth-controller.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { ControllerHistorySnapshot } from "./coordinator-auth-controller-history.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { isHash } from "./coordinator-auth-link-input.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";
import type { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	CONTROLLER_COLUMNS,
	RESOLUTION_COLUMNS,
} from "./coordinator-device-ownership-evidence-queries.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	captureLegacyOwnerResolutionRecord,
	type LegacyOwnerResolutionRecord,
	readLegacyOwnerResolutionSchemaState,
} from "./coordinator-legacy-owner-resolution-metadata.js";
import type {
	OwnerResolutionReviewBackend,
	OwnerResolutionReviewSelection,
} from "./coordinator-owner-resolution-review.js";

export interface ResolutionTarget {
	link_id: string;
	auth_config_revision: string;
	created_at_ms: number;
}

export class ReviewUnavailable extends Error {}

export async function requireReviewSchema(backend: OwnerResolutionReviewBackend) {
	if (
		(await readLegacyOwnerResolutionSchemaState(backend)) !== "ready" ||
		(await readConnectionSchemaState(backend)) !== "ready"
	)
		throw new ReviewUnavailable(
			"upgrade_required: ask the operator to upgrade the coordinator ownership schema",
		);
}

/** Account provenance belongs to A; the requester is collected separately, never impersonated. */
export async function readResolutionTarget(
	backend: OwnerResolutionReviewBackend,
	selection: OwnerResolutionReviewSelection,
	config: CoordinatorAuthLinkConfig,
): Promise<ResolutionTarget> {
	const rows = await backend.all<ResolutionTarget>({
		sql: `SELECT l.link_id,l.auth_config_revision,l.created_at_ms FROM coordinator_auth_account_links l
		 WHERE l.coordinator_id=? AND l.identity_id=? AND l.issuer=?
		 AND ${CONNECTION_NOT_REVOKED_SQL}
		 AND ${authAccountLinkProvenanceSql("l", { connections: true })} LIMIT 2`,
		values: [config.coordinatorId, selection.identityId, config.issuer],
	});
	const row = rows[0];
	if (
		rows.length !== 1 ||
		!row ||
		!isAuthControllerId(row.link_id) ||
		!isHash(row.auth_config_revision) ||
		!Number.isSafeInteger(row.created_at_ms) ||
		row.created_at_ms < 0
	)
		throw new ReviewUnavailable(
			"account_owner_target_unavailable: verify the selected account connection",
		);
	return row;
}

export async function readResolutionRequester(
	backend: OwnerResolutionReviewBackend,
	selection: OwnerResolutionReviewSelection,
) {
	const row = await backend.first<{
		public_key: string;
		fingerprint: string;
		identity_id: string | null;
	}>({
		sql: `SELECT CASE WHEN length(CAST(e.public_key AS BLOB))<=4096 THEN e.public_key ELSE NULL END AS public_key,
		 e.fingerprint,e.identity_id FROM enrolled_devices e JOIN groups g ON g.group_id=e.group_id
		 WHERE e.group_id=? AND e.device_id=? AND e.enabled=1 AND g.archived_at IS NULL`,
		values: [selection.groupId, selection.deviceId],
	});
	if (
		!row ||
		row.fingerprint !== selection.fingerprint ||
		!(await ed25519KeyIdForRevocation(row.public_key))
	)
		throw new ReviewUnavailable(
			"requester_unavailable: verify the current group, enrollment and key",
		);
	return {
		signer: {
			groupId: selection.groupId,
			deviceId: selection.deviceId,
			publicKey: row.public_key,
			fingerprint: row.fingerprint,
		},
		enrollmentIdentityId: row.identity_id,
	};
}

export async function readResolutionInvites(
	backend: OwnerResolutionReviewBackend,
	signer: CoordinatorAuthLinkSigner,
) {
	const invites = await backend.all<CoordinatorAuthControllerVerifiedSnapshot["invites"][number]>({
		sql: `SELECT invite_id AS inviteId,invite_kind AS kind,recipient_actor_id AS actorId,
		 assigned_identity_id AS assignedIdentityId,target_identity_id AS targetIdentityId,reviewed_preview_digest AS digest
		 FROM coordinator_invites WHERE group_id=? AND bound_device_id=? AND bound_public_key=? AND bound_fingerprint=?
		 AND revoked_at IS NULL AND consumed_at IS NOT NULL AND consumed_at!=''
		 AND invite_kind IN ('team_member','add_device') ORDER BY invite_id LIMIT 501`,
		values: [signer.groupId, signer.deviceId, signer.publicKey, signer.fingerprint],
	});
	if (invites.length > 500)
		throw new ReviewUnavailable(
			"evidence_too_large: ask the operator to inspect consumed invitations",
		);
	return invites;
}

function controllerFromResolution(
	row: LegacyOwnerResolutionRecord,
): CoordinatorAuthControllerAttestation {
	return {
		attestation_id: row.source_attestation_id,
		coordinator_id: row.coordinator_id,
		identity_id: row.owner_identity_id,
		group_id: row.source_group_id,
		device_id: row.device_id,
		public_key: row.source_public_key,
		fingerprint: row.source_fingerprint,
		review_receipt_id: row.source_review_receipt_id,
		evidence_digest: row.source_evidence_digest,
		enrollment_identity_id: row.source_enrollment_identity_id,
		revision: row.source_controller_revision,
		created_at: row.source_created_at,
		revoked_at: null,
	};
}

async function readExistingResolutions(
	backend: OwnerResolutionReviewBackend,
	config: CoordinatorAuthLinkConfig,
	signer: CoordinatorAuthLinkSigner,
) {
	const keyId = await ed25519KeyIdForRevocation(signer.publicKey);
	const rows = await backend.all<unknown>({
		sql: `SELECT ${RESOLUTION_COLUMNS.join(",")} FROM coordinator_legacy_owner_resolutions
		 WHERE coordinator_id=? AND (device_id=? OR key_id=?)
		 ORDER BY created_at,resolution_id LIMIT 501`,
		values: [config.coordinatorId, signer.deviceId, keyId],
	});
	if (rows.length > 500 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 750_000)
		throw new ReviewUnavailable("evidence_too_large: inspect retained resolution receipts");
	const exact: LegacyOwnerResolutionRecord[] = [];
	for (const value of rows) {
		const row = await captureLegacyOwnerResolutionRecord(value);
		if (!row)
			throw new ReviewUnavailable("source_unavailable: inspect retained resolution metadata");
		if (row.device_id === signer.deviceId && row.key_id === keyId) exact.push(row);
	}
	if (rows.length && !exact.length)
		throw new ReviewUnavailable(
			"source_unavailable: ask the operator to inspect the retained resolution subject",
		);
	return exact;
}

async function verifiedResolutionSource(
	rows: LegacyOwnerResolutionRecord[],
	selection: OwnerResolutionReviewSelection,
	signer: CoordinatorAuthLinkSigner,
	evidence: CoordinatorDeviceOwnershipEvidence,
) {
	for (const resolution of rows) {
		const verified = await evidence.verifyControllerSource({
			sourceRef: resolution,
			expectedOwnerId: selection.identityId,
			actualSigner: signer,
		});
		if (verified.kind === "verified_controller_source")
			return { controller: controllerFromResolution(resolution), resolution };
	}
	throw new ReviewUnavailable(
		"source_unavailable: inspect the original controllers and immutable resolution receipts",
	);
}

async function readRetainedControllers(
	backend: OwnerResolutionReviewBackend,
	config: CoordinatorAuthLinkConfig,
	signer: CoordinatorAuthLinkSigner,
	history: ControllerHistorySnapshot,
) {
	const rows = await backend.all<CoordinatorAuthControllerAttestation>({
		sql: `SELECT ${CONTROLLER_COLUMNS.join(",")} FROM coordinator_auth_controller_attestations
		 WHERE coordinator_id=? AND device_id=? AND (public_key IN (SELECT value FROM json_each(?))
		 OR (group_id=? AND fingerprint=?)) ORDER BY group_id,attestation_id LIMIT 501`,
		values: [
			config.coordinatorId,
			signer.deviceId,
			JSON.stringify(history.keys.map((key) => key.public_key)),
			signer.groupId,
			signer.fingerprint,
		],
	});
	if (rows.length > 500 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 750_000)
		throw new ReviewUnavailable(
			"evidence_too_large: ask the operator to inspect retained controllers",
		);
	return rows;
}

export async function readResolutionSource(options: {
	backend: OwnerResolutionReviewBackend;
	config: CoordinatorAuthLinkConfig;
	selection: OwnerResolutionReviewSelection;
	signer: CoordinatorAuthLinkSigner;
	history: ControllerHistorySnapshot;
	evidence: CoordinatorDeviceOwnershipEvidence;
}) {
	const { backend, config, selection, signer, history, evidence } = options;
	const controllers = await readRetainedControllers(backend, config, signer, history);
	const current = controllers.filter(
		(row) => row.group_id === signer.groupId && row.fingerprint === signer.fingerprint,
	);
	if (
		current.some(
			(row) =>
				row.revoked_at !== null ||
				row.identity_id !== selection.identityId ||
				row.public_key !== signer.publicKey,
		)
	)
		throw new ReviewUnavailable(
			"controller_unavailable: inspect the current controller tombstone or owner conflict",
		);
	const resolutions = await readExistingResolutions(backend, config, signer);
	if (resolutions.length) return verifiedResolutionSource(resolutions, selection, signer, evidence);
	const controller =
		controllers.find(
			(row) => row.revoked_at === null && row.identity_id === selection.identityId,
		) ?? null;
	return { controller, resolution: null };
}
