import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import { coordinatorListRemovedDevicesAction } from "./coordinator-actions.js";
import { captureRemovalCommit } from "./coordinator-device-removal-commit.js";
import type { Database } from "./db.js";
import { type PairingRemovalCounts, removePairingState } from "./pairing-removal.js";
import { readPeerRemovalCheckState } from "./peer-removal-check-state.js";
import { canonicalKeyId } from "./retired-device-aliases.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { requestJson } from "./sync-http-client.js";
import {
	readViewerRemovalPreview,
	readViewerRemovalReceipt,
	recoverViewerRemoval,
	type ViewerRemovalEvidence,
	type ViewerRemovalPreview,
} from "./viewer-device-removal-evidence.js";

interface CoordinatorTarget {
	url: string;
	adminSecret: string;
	timeoutS?: number;
}

interface ViewerRemovalContext {
	coordinator: CoordinatorTarget | null;
	/** The existing Viewer identity check must verify this key and ID together. */
	local: { deviceId: string; keyId: string | null } | null;
}

interface ViewerRemovalOptions {
	db: Database;
	readContext(): ViewerRemovalContext;
	waitForRefresh(): Promise<void>;
	refresh(): Promise<void>;
	/** Compound Block must not remove an enrollment different from its preflight. */
	expectedEnrollment?: { groupId: string; keyId: string };
}

type Rejection =
	| "invalid_input"
	| "coordinator_admin_required"
	| "coordinator_update_required"
	| "device_removal_unavailable"
	| "local_identity_unverified"
	| "cannot_remove_this_device"
	| "removal_preview_stale";

type LocalCleanup = { state: "applied"; counts: PairingRemovalCounts } | { state: "deferred" };
type Outcome =
	| { kind: "rejected"; error: Rejection }
	| { kind: "unknown"; error: "removal_outcome_unknown" }
	| {
			kind: "removed";
			evidence: ViewerRemovalEvidence;
			localCleanup: LocalCleanup;
			refreshPending: boolean;
	  };

type ConfirmedInput = {
	deviceIds: readonly string[];
	expectedDigest: string;
	/** The trusted coordinator selected when the Viewer created the preview. */
	coordinatorOrigin: string;
};
type CapturedInput = ReturnType<typeof captureRemovalCommit> & { coordinatorOrigin: string };
type Dispatch =
	| { kind: "rejected"; error: Rejection }
	| { kind: "verify"; evidence: ViewerRemovalEvidence | null };

function captureContext(options: ViewerRemovalOptions) {
	const { local, coordinator } = options.readContext();
	const url = normalizeCoordinatorAccountLinkOrigin(coordinator?.url);
	return {
		local: local ? { ...local } : null,
		coordinator: url && coordinator?.adminSecret.trim() ? { ...coordinator, url } : null,
	};
}

function sameContext(options: ViewerRemovalOptions, before: ViewerRemovalContext): boolean {
	const after = captureContext(options);
	return (
		after.coordinator?.url === before.coordinator?.url &&
		after.coordinator?.adminSecret === before.coordinator?.adminSecret &&
		after.local?.deviceId === before.local?.deviceId &&
		after.local?.keyId === before.local?.keyId
	);
}

function send(
	target: CoordinatorTarget,
	action: "removal-preview" | "removal",
	body: Record<string, unknown>,
) {
	return requestJson("POST", `${target.url}/v1/admin/devices/${action}`, {
		headers: { "X-Codemem-Coordinator-Admin": target.adminSecret },
		// The admin header also forbids redirects in requestJson.
		body,
		timeoutS: target.timeoutS,
		maxResponseBytes: 256_000,
	});
}

async function refreshPreview(target: CoordinatorTarget, input: CapturedInput) {
	const [status, payload] = await send(target, "removal-preview", { device_ids: input.deviceIds });
	if (status === 404 && payload?.error !== "removal_target_not_enrolled")
		return "coordinator_update_required";
	if (status === 404 || status === 409) return "removal_preview_stale";
	if (status !== 200) return "device_removal_unavailable";
	return readViewerRemovalPreview(payload, input) ?? "removal_preview_stale";
}

async function dispatchRemoval(
	target: CoordinatorTarget,
	preview: ViewerRemovalPreview,
): Promise<Dispatch> {
	try {
		const [status, payload] = await send(target, "removal", {
			device_ids: preview.device_ids,
			expected_digest: preview.expected_digest,
		});
		if (status === 404) return { kind: "rejected", error: "coordinator_update_required" };
		if (status === 409 && payload?.error === "removal_preview_stale")
			return { kind: "rejected", error: "removal_preview_stale" };
		if ([400, 401, 403, 413, 429].includes(status))
			return { kind: "rejected", error: "device_removal_unavailable" };
		return {
			kind: "verify",
			evidence: status === 200 ? readViewerRemovalReceipt(payload, preview) : null,
		};
	} catch {
		// The request may have been applied. Never send the commit again.
		return { kind: "verify", evidence: null };
	}
}

async function readRecovery(target: CoordinatorTarget, preview: ViewerRemovalPreview) {
	try {
		const rows = await coordinatorListRemovedDevicesAction({ remote: target });
		return recoverViewerRemoval(rows, preview);
	} catch {
		return null;
	}
}

interface Pairing {
	peer_device_id: string;
	public_key: string | null;
	pinned_fingerprint: string | null;
}

function matchesRemovedKey(pair: Pairing, keyId: string | null, fingerprints?: Set<string>) {
	const { public_key: publicKey, pinned_fingerprint: fingerprint } = pair;
	if (!publicKey || !fingerprint || fingerprintPublicKey(publicKey) !== fingerprint) return false;
	if (keyId !== null) return canonicalKeyId(publicKey) === keyId;
	return fingerprints?.has(fingerprint) === true;
}

/** Local-only aliases must pin the verified canonical key. A replacement key under the same ID stays. */
function matchingLocalIds(db: Database, preview: ViewerRemovalPreview, ownId: string): string[] {
	const expected = new Map<string, Set<string>>();
	for (const row of preview.enrollments) {
		const fingerprints = expected.get(row.device_id) ?? new Set<string>();
		fingerprints.add(row.fingerprint);
		expected.set(row.device_id, fingerprints);
	}
	const aliases = new Set(expected.keys());
	const pairs = db
		.prepare("SELECT peer_device_id, public_key, pinned_fingerprint FROM sync_peers")
		.all() as Pairing[];
	for (const pair of pairs) {
		const id = pair.peer_device_id;
		if (matchesRemovedKey(pair, preview.key_id, expected.get(id))) {
			aliases.add(id);
			const fingerprint = pair.pinned_fingerprint;
			if (fingerprint) {
				const fingerprints = expected.get(id) ?? new Set<string>();
				fingerprints.add(fingerprint);
				expected.set(id, fingerprints);
			}
		} else aliases.delete(id);
	}
	aliases.delete(ownId);
	const binding = db.prepare("SELECT source_fingerprint FROM identity_devices WHERE device_id = ?");
	return [...aliases].filter((id) => {
		const row = binding.get(id) as { source_fingerprint: string | null } | undefined;
		return (
			row?.source_fingerprint == null || expected.get(id)?.has(row.source_fingerprint) === true
		);
	});
}

async function cleanupAfterVerification(
	options: ViewerRemovalOptions,
	preview: ViewerRemovalPreview,
	context: ViewerRemovalContext,
	snapshot: { generation: number; deviceId: string },
): Promise<LocalCleanup> {
	try {
		await options.waitForRefresh();
		if (!sameContext(options, context)) return { state: "deferred" };
		return options.db
			.transaction((): LocalCleanup => {
				if (readPeerRemovalCheckState(options.db)?.generation !== snapshot.generation)
					return { state: "deferred" };
				const deviceIds = matchingLocalIds(options.db, preview, snapshot.deviceId);
				const counts = removePairingState(options.db, {
					reason: "removed",
					deviceIds,
					localDeviceId: snapshot.deviceId,
				});
				return { state: "applied", counts };
			})
			.immediate();
	} catch {
		// Coordinator removal stands even if the local transaction did not commit.
		return { state: "deferred" };
	}
}

async function refreshAfterVerification(options: ViewerRemovalOptions): Promise<boolean> {
	try {
		await options.refresh();
		return false;
	} catch {
		return true;
	}
}

function matchesExpectedEnrollment(
	preview: ViewerRemovalPreview,
	deviceId: string | undefined,
	expected: ViewerRemovalOptions["expectedEnrollment"],
) {
	if (!expected) return true;
	return (
		preview.key_id === expected.keyId &&
		preview.enrollments.some(
			(row) => row.group_id === expected.groupId && row.device_id === deviceId,
		)
	);
}

async function commitConfirmed(
	input: CapturedInput,
	options: ViewerRemovalOptions,
): Promise<Outcome> {
	const context = captureContext(options);
	const { coordinator, local } = context;
	if (!coordinator) return { kind: "rejected", error: "coordinator_admin_required" };
	if (coordinator.url !== input.coordinatorOrigin)
		return { kind: "rejected", error: "removal_preview_stale" };
	if (!local?.deviceId || !local.keyId)
		return { kind: "rejected", error: "local_identity_unverified" };
	if (input.deviceIds.includes(local.deviceId))
		return { kind: "rejected", error: "cannot_remove_this_device" };
	const preview = await refreshPreview(coordinator, input);
	if (typeof preview === "string") return { kind: "rejected", error: preview };
	if (!matchesExpectedEnrollment(preview, input.deviceIds[0], options.expectedEnrollment))
		return { kind: "rejected", error: "removal_preview_stale" };
	if (
		preview.key_id === local.keyId ||
		preview.enrollments.some((row) => row.device_id === local.deviceId)
	)
		return { kind: "rejected", error: "cannot_remove_this_device" };
	if (!sameContext(options, context)) return { kind: "rejected", error: "removal_preview_stale" };
	const generation = readPeerRemovalCheckState(options.db)?.generation;
	if (!Number.isSafeInteger(generation) || generation === undefined)
		return { kind: "rejected", error: "device_removal_unavailable" };
	const result = await dispatchRemoval(coordinator, preview);
	if (result.kind === "rejected") return result;
	const evidence = result.evidence ?? (await readRecovery(coordinator, preview));
	if (!evidence) return { kind: "unknown", error: "removal_outcome_unknown" };
	const localCleanup = await cleanupAfterVerification(options, preview, context, {
		generation,
		deviceId: local.deviceId,
	});
	const refreshPending = await refreshAfterVerification(options);
	return { kind: "removed", evidence, localCleanup, refreshPending };
}

/** Internal Viewer backend for a confirmed coordinator-managed Remove. No route mounts it yet. */
export async function commitViewerDeviceRemoval(
	confirmed: ConfirmedInput,
	options: ViewerRemovalOptions,
): Promise<Outcome> {
	let input: CapturedInput;
	try {
		const coordinatorOrigin = normalizeCoordinatorAccountLinkOrigin(confirmed.coordinatorOrigin);
		if (!coordinatorOrigin) return { kind: "rejected", error: "invalid_input" };
		input = { ...captureRemovalCommit(confirmed), coordinatorOrigin };
	} catch {
		return { kind: "rejected", error: "invalid_input" };
	}
	try {
		return await commitConfirmed(input, options);
	} catch {
		return { kind: "rejected", error: "device_removal_unavailable" };
	}
}
