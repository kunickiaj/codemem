import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import {
	applyAuthenticatedRetirementControls,
	authenticateRetirementPacket,
	MEMORY_RETIREMENT_FEATURE,
	parseRetirementBatch,
	type RetirementControl,
	type RetirementPeer,
	type SignedRetirementPacket,
} from "./memory-retirement-delivery.js";
import { getRetirementPeer } from "./memory-retirement-trust.js";
import {
	memorySourceNamespace,
	verifyAuthenticatedMemorySource,
} from "./memory-source-identity.js";
import type { SecretScanner } from "./secret-scanner.js";
import { recordNonce } from "./sync-auth.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import { supportsSyncFeature } from "./sync-capability.js";
import type { SyncMemorySnapshotItem, SyncResetRequired } from "./types.js";

export const RETIREMENT_RESET_REQUEST_PATH = "/v1/memory-scope-retirements/reset";
export const RETIREMENT_RESET_PAGE_PATH = `${RETIREMENT_RESET_REQUEST_PATH}/page`;
const PAGE_SIZE = 100;
const MAX_RESET_CONTROLS = 100_000;

interface ResetState {
	reset_id: string;
	source_device_id: string;
	source_public_key: string;
	local_device_id: string;
	boundary: string;
	next_offset: number;
	complete: number;
	last_page_digest: string | null;
}
export interface RetirementResetRequest {
	feature: typeof MEMORY_RETIREMENT_FEATURE;
	resetId: string;
	boundary: string;
	offset: number;
}
export interface RetirementResetPage extends RetirementResetRequest {
	recipientDeviceId: string;
	controls: RetirementControl[];
	complete: boolean;
}
interface ResetPeerOptions {
	localDeviceId: string;
	peer: RetirementPeer;
	peerFeatures: unknown;
	now: string;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function boundaryDigest(info: SyncResetRequired): string {
	return digest([info.scope_id ?? null, info.generation, info.snapshot_id, info.baseline_cursor]);
}
function requireInternalReset(db: Database, options: ResetPeerOptions): void {
	if (db.inTransaction) throw new Error("retirement_outer_transaction_forbidden");
	if (!supportsSyncFeature(options.peerFeatures, MEMORY_RETIREMENT_FEATURE))
		throw new Error("retirement_feature_required");
	const peer = getRetirementPeer(db, {
		localDeviceId: options.localDeviceId,
		peerDeviceId: options.peer.deviceId,
	});
	if (!peer || peer.publicKey !== options.peer.publicKey)
		throw new Error("retirement_peer_untrusted");
}
function resetState(db: Database, resetId: string): ResetState {
	const row = db
		.prepare("SELECT * FROM memory_retirement_reset_receivers WHERE reset_id = ?")
		.get(resetId) as ResetState | undefined;
	if (!row) throw new Error("retirement_reset_unknown");
	return row;
}
function requestFromState(state: ResetState): RetirementResetRequest {
	return {
		feature: MEMORY_RETIREMENT_FEATURE,
		resetId: state.reset_id,
		boundary: state.boundary,
		offset: state.next_offset,
	};
}

/** Persist a fresh random challenge BEFORE fetching controls or any snapshot pages. */
export function beginRetirementReset(
	db: Database,
	options: ResetPeerOptions & { resetInfo: SyncResetRequired },
): RetirementResetRequest {
	requireInternalReset(db, options);
	const resetId = randomUUID();
	db.prepare(`INSERT INTO memory_retirement_reset_receivers(reset_id, source_device_id, source_public_key, local_device_id, boundary)
		VALUES (?, ?, ?, ?, ?)`).run(
		resetId,
		options.peer.deviceId,
		options.peer.publicKey,
		options.localDeviceId,
		boundaryDigest(options.resetInfo),
	);
	return requestFromState(resetState(db, resetId));
}

/** Resume after restart without deriving a control cursor from content state. */
export function retirementResetProgress(
	db: Database,
	resetId: string,
): { request: RetirementResetRequest; complete: boolean } {
	const state = resetState(db, resetId);
	return { request: requestFromState(state), complete: state.complete === 1 };
}

function validateRequest(value: RetirementResetRequest): void {
	if (
		value?.feature !== MEMORY_RETIREMENT_FEATURE ||
		typeof value.resetId !== "string" ||
		!/^[0-9a-f-]{36}$/.test(value.resetId) ||
		typeof value.boundary !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.boundary) ||
		!Number.isSafeInteger(value.offset) ||
		value.offset < 0 ||
		value.offset > MAX_RESET_CONTROLS ||
		value.offset % PAGE_SIZE !== 0
	) {
		throw new Error("retirement_reset_request_invalid");
	}
}

function resetManifest(
	db: Database,
	request: RetirementResetRequest,
	options: ResetPeerOptions,
): RetirementControl[] {
	const existing = db
		.prepare(`SELECT boundary, controls_json FROM memory_retirement_reset_manifests
		WHERE reset_id = ? AND peer_device_id = ? AND source_device_id = ?`)
		.get(request.resetId, options.peer.deviceId, options.localDeviceId) as
		| { boundary: string; controls_json: string }
		| undefined;
	if (existing) {
		if (existing.boundary !== request.boundary)
			throw new Error("retirement_reset_boundary_mismatch");
		return JSON.parse(existing.controls_json) as RetirementControl[];
	}
	if (request.offset !== 0) throw new Error("retirement_reset_start_required");
	const controls = db
		.prepare(`SELECT control_id AS controlId, entity_id AS entityId, source_device_id AS sourceDeviceId,
		retired_scope_id AS retiredScopeId FROM memory_retirement_deliveries WHERE peer_device_id = ? AND source_device_id = ? ORDER BY control_id LIMIT ?`)
		.all(
			options.peer.deviceId,
			options.localDeviceId,
			MAX_RESET_CONTROLS + 1,
		) as RetirementControl[];
	if (controls.length > MAX_RESET_CONTROLS) throw new Error("retirement_reset_too_large");
	db.prepare(`INSERT INTO memory_retirement_reset_manifests(reset_id, peer_device_id, source_device_id, boundary, controls_json)
		VALUES (?, ?, ?, ?, ?)`).run(
		request.resetId,
		options.peer.deviceId,
		options.localDeviceId,
		request.boundary,
		JSON.stringify(controls),
	);
	return controls;
}

/** Authenticate a former recipient; replay its complete retained manifest INCLUDING acked controls. */
export function serveRetirementReset(
	db: Database,
	packet: SignedRetirementPacket,
	options: ResetPeerOptions,
): RetirementResetPage {
	requireInternalReset(db, options);
	authenticateRetirementPacket(packet, { ...options, path: RETIREMENT_RESET_REQUEST_PATH });
	const request = JSON.parse(packet.body) as RetirementResetRequest;
	validateRequest(request);
	return db
		.transaction((): RetirementResetPage => {
			if (!recordNonce(db, options.peer.deviceId, packet.nonce, options.now))
				throw new Error("retirement_nonce_replayed");
			const controls = resetManifest(db, request, options);
			if (request.offset > controls.length) throw new Error("retirement_reset_offset_invalid");
			return {
				feature: MEMORY_RETIREMENT_FEATURE,
				resetId: request.resetId,
				boundary: request.boundary,
				offset: request.offset,
				recipientDeviceId: options.peer.deviceId,
				controls: controls.slice(request.offset, request.offset + PAGE_SIZE),
				complete: request.offset + PAGE_SIZE >= controls.length,
			};
		})
		.immediate();
}

function validatedPage(
	packet: SignedRetirementPacket,
	options: ResetPeerOptions,
): RetirementResetPage {
	authenticateRetirementPacket(packet, { ...options, path: RETIREMENT_RESET_PAGE_PATH });
	const page = JSON.parse(packet.body) as RetirementResetPage;
	validateRequest(page);
	if (
		page.recipientDeviceId !== options.localDeviceId ||
		typeof page.complete !== "boolean" ||
		!Array.isArray(page.controls) ||
		page.controls.length > PAGE_SIZE ||
		(!page.complete && page.controls.length !== PAGE_SIZE)
	)
		throw new Error("retirement_reset_page_invalid");
	if (
		Object.keys(page).some(
			(key) =>
				![
					"feature",
					"resetId",
					"boundary",
					"offset",
					"recipientDeviceId",
					"controls",
					"complete",
				].includes(key),
		)
	)
		throw new Error("retirement_reset_page_invalid");
	if (page.controls.length)
		parseRetirementBatch(
			JSON.stringify({
				feature: MEMORY_RETIREMENT_FEATURE,
				recipientDeviceId: page.recipientDeviceId,
				controls: page.controls,
			}),
			options.localDeviceId,
		);
	return page;
}

/** Commit source-pinned controls and checkpoint together, before admitting snapshot content. */
export function receiveRetirementResetPage(
	db: Database,
	packet: SignedRetirementPacket,
	options: ResetPeerOptions,
): void {
	requireInternalReset(db, options);
	const page = validatedPage(packet, options);
	db.transaction(() => {
		const state = resetState(db, page.resetId);
		if (
			state.source_device_id !== options.peer.deviceId ||
			state.source_public_key !== options.peer.publicKey ||
			state.local_device_id !== options.localDeviceId ||
			state.boundary !== page.boundary
		)
			throw new Error("retirement_reset_source_mismatch");
		if (state.last_page_digest === digest(page)) return;
		if (state.complete || state.next_offset !== page.offset)
			throw new Error("retirement_reset_page_out_of_order");
		if (!recordNonce(db, options.peer.deviceId, packet.nonce, options.now))
			throw new Error("retirement_nonce_replayed");
		applyAuthenticatedRetirementControls(db, page.controls, options.peer.deviceId, options.now);
		db.prepare(
			`UPDATE memory_retirement_reset_receivers SET next_offset = ?, complete = ?, last_page_digest = ? WHERE reset_id = ?`,
		).run(page.offset + page.controls.length, Number(page.complete), digest(page), page.resetId);
	}).immediate();
}

/** Protected direct-source bootstrap entry point. Legacy IDs need the ownership recovery workflow. */
export function applyRetirementProtectedSnapshot(
	db: Database,
	options: ResetPeerOptions & {
		resetId: string;
		resetInfo: SyncResetRequired;
		items: SyncMemorySnapshotItem[];
		mode: "replace" | "merge";
		scanner?: SecretScanner;
	},
) {
	requireInternalReset(db, options);
	return db
		.transaction(() => {
			const state = resetState(db, options.resetId);
			if (
				!state.complete ||
				state.source_device_id !== options.peer.deviceId ||
				state.source_public_key !== options.peer.publicKey ||
				state.local_device_id !== options.localDeviceId ||
				state.boundary !== boundaryDigest(options.resetInfo)
			)
				throw new Error("retirement_reset_not_ready");
			for (const item of options.items) {
				const source = memorySourceNamespace(item.entity_id);
				if (!source) throw new Error("memory_source_verification_required");
				if (source !== options.peer.deviceId)
					throw new Error("retirement_snapshot_source_required");
				verifyAuthenticatedMemorySource(db, {
					entityId: item.entity_id,
					verifiedPeerDeviceId: options.peer.deviceId,
				});
			}
			const apply = options.mode === "replace" ? applyBootstrapSnapshot : mergeBootstrapSnapshot;
			return apply(db, options.peer.deviceId, options.items, options.resetInfo, options.scanner);
		})
		.immediate();
}
