import { randomUUID } from "node:crypto";
import type {
	CoordinatorDeviceRevocationCommit,
	CoordinatorDeviceRevocationPreview,
	commitViewerDeviceRemoval,
	coordinatorRevokeDeviceAction,
} from "@codemem/core";

type RemovalInput = Parameters<typeof commitViewerDeviceRemoval>[0];
type RemovalContext = ReturnType<Parameters<typeof commitViewerDeviceRemoval>[1]["readContext"]>;
type RemovalOutcome = Awaited<ReturnType<typeof commitViewerDeviceRemoval>>;
type Removed = Extract<RemovalOutcome, { kind: "removed" }>;
type BlockRequest = Parameters<typeof coordinatorRevokeDeviceAction>[0];

export interface ViewerDeviceBlockInput {
	groupId: string;
	deviceId: string;
	/** The coordinator and canonical key shown in the confirmed Block review. */
	expectedContext: { coordinatorId: string; keyId: string };
	removal: RemovalInput;
}

export interface ViewerDeviceBlockDependencies {
	/** The caller adapts the existing verified identity/config reader. */
	readContext(): RemovalContext;
	revoke: typeof coordinatorRevokeDeviceAction;
	/** Adapt commitViewerDeviceRemoval with its existing database and refresh hooks. */
	remove(input: RemovalInput): ReturnType<typeof commitViewerDeviceRemoval>;
}

export type ViewerDeviceBlockOutcome =
	| {
			kind: "refused";
			error: "invalid_input" | "block_preflight_refused" | "block_context_changed";
	  }
	| Extract<RemovalOutcome, { kind: "rejected" | "unknown" }>
	| { kind: "blocked"; removal: Removed; block: CoordinatorDeviceRevocationCommit }
	| {
			kind: "removed-but-block-refused";
			removal: Removed;
			error: "block_context_changed" | "block_preview_refused" | "block_commit_refused";
	  }
	| { kind: "removed-block-unknown"; removal: Removed; error: "block_outcome_unknown" };

function snapshot(deps: ViewerDeviceBlockDependencies): RemovalContext {
	const context = deps.readContext();
	return {
		local: context.local ? { ...context.local } : null,
		coordinator: context.coordinator ? { ...context.coordinator } : null,
	};
}

function sameContext(deps: ViewerDeviceBlockDependencies, before: RemovalContext): boolean {
	try {
		const after = snapshot(deps);
		return (
			after.local?.deviceId === before.local?.deviceId &&
			after.local?.keyId === before.local?.keyId &&
			after.coordinator?.url === before.coordinator?.url &&
			after.coordinator?.adminSecret === before.coordinator?.adminSecret
		);
	} catch {
		return false;
	}
}

function matchesPreview(
	preview: CoordinatorDeviceRevocationPreview | CoordinatorDeviceRevocationCommit,
	input: ViewerDeviceBlockInput,
): preview is CoordinatorDeviceRevocationPreview {
	return (
		preview.state === "ready" &&
		preview.device_id === input.deviceId &&
		preview.group_id === input.groupId &&
		preview.coordinator_id === input.expectedContext.coordinatorId &&
		preview.key_id === input.expectedContext.keyId
	);
}

function remoteError(error: unknown): { status: number; code: unknown } | null {
	if (
		error instanceof Error &&
		"status" in error &&
		typeof error.status === "number" &&
		"code" in error
	)
		return { status: error.status, code: error.code };
	return null;
}

async function supportsPin(
	request: BlockRequest,
	deps: ViewerDeviceBlockDependencies,
): Promise<boolean> {
	try {
		// This selector cannot name a prior Remove from this action. Success means the
		// coordinator ignored the selector, so it is unsafe to remove an enrollment.
		await deps.revoke({ ...request, requiredRemovalId: randomUUID() });
		return false;
	} catch (error) {
		const remote = remoteError(error);
		return remote?.status === 409 && remote.code === "revocation_target_unavailable";
	}
}

async function preflight(
	input: ViewerDeviceBlockInput,
	request: BlockRequest,
	deps: ViewerDeviceBlockDependencies,
): Promise<boolean> {
	try {
		const preview = await deps.revoke(request);
		return matchesPreview(preview, input) && (await supportsPin(request, deps));
	} catch {
		return false;
	}
}

function commitRefused(error: unknown): boolean {
	const remote = remoteError(error);
	if (!remote) return false;
	if ([400, 401, 403, 404, 413, 429].includes(remote.status)) return true;
	return (
		remote.status === 409 &&
		(remote.code === "revocation_target_unavailable" || remote.code === "revocation_preview_stale")
	);
}

async function blockRemoved(
	input: ViewerDeviceBlockInput,
	request: BlockRequest,
	context: RemovalContext,
	removal: Removed,
	deps: ViewerDeviceBlockDependencies,
): Promise<ViewerDeviceBlockOutcome> {
	const pinned = { ...request, requiredRemovalId: removal.evidence.removalId };
	if (!sameContext(deps, context))
		return { kind: "removed-but-block-refused", removal, error: "block_context_changed" };
	let preview: CoordinatorDeviceRevocationPreview;
	try {
		const result = await deps.revoke(pinned);
		if (!matchesPreview(result, input))
			return { kind: "removed-but-block-refused", removal, error: "block_preview_refused" };
		preview = result;
	} catch {
		return { kind: "removed-but-block-refused", removal, error: "block_preview_refused" };
	}
	if (!sameContext(deps, context))
		return { kind: "removed-but-block-refused", removal, error: "block_context_changed" };
	let dispatched = false;
	try {
		const block = await deps.revoke({
			...pinned,
			expectedDigest: preview.expected_digest,
			expectedContext: { ...input.expectedContext },
			onDispatch: () => {
				dispatched = true;
			},
		});
		if (
			block.state === "revoked" &&
			block.coordinator_id === input.expectedContext.coordinatorId &&
			block.key_id === input.expectedContext.keyId &&
			block.device_id === input.deviceId &&
			block.group_id === input.groupId
		)
			return { kind: "blocked", removal, block };
		// A malformed success cannot prove that the commit was refused.
		return { kind: "removed-block-unknown", removal, error: "block_outcome_unknown" };
	} catch (error) {
		if (!dispatched || commitRefused(error))
			return { kind: "removed-but-block-refused", removal, error: "block_commit_refused" };
		return { kind: "removed-block-unknown", removal, error: "block_outcome_unknown" };
	}
}

async function run(
	input: ViewerDeviceBlockInput,
	deps: ViewerDeviceBlockDependencies,
): Promise<ViewerDeviceBlockOutcome> {
	const context = snapshot(deps);
	const coordinator = context.coordinator;
	if (
		!coordinator ||
		!context.local?.keyId ||
		context.local.deviceId === input.deviceId ||
		context.local.keyId === input.expectedContext.keyId ||
		coordinator.url !== input.removal.coordinatorOrigin ||
		input.removal.deviceIds.length !== 1 ||
		input.removal.deviceIds[0] !== input.deviceId
	)
		return { kind: "refused", error: "invalid_input" };
	const request: BlockRequest = {
		remoteUrl: coordinator.url,
		adminSecret: coordinator.adminSecret,
		timeoutS: coordinator.timeoutS,
		groupId: input.groupId,
		deviceId: input.deviceId,
	};
	if (!(await preflight(input, request, deps)))
		return { kind: "refused", error: "block_preflight_refused" };
	if (!sameContext(deps, context)) return { kind: "refused", error: "block_context_changed" };
	let removal: RemovalOutcome;
	try {
		removal = await deps.remove(input.removal);
	} catch {
		// An adapter exception can occur after dispatch. Never infer refusal or retry.
		return { kind: "unknown", error: "removal_outcome_unknown" };
	}
	if (removal.kind !== "removed") return removal;
	return blockRemoved(input, request, context, removal, deps);
}

/**
 * In-process composition for the existing admin-authorized Viewer transport.
 * No routes, credentials, authorization defaults, retries or local-only fallback.
 * A removed result from the existing Remove helper includes verified receipt or
 * listing evidence. Only that result admits the pinned second Block preview.
 */
export async function commitViewerDeviceBlock(
	confirmed: ViewerDeviceBlockInput,
	deps: ViewerDeviceBlockDependencies,
): Promise<ViewerDeviceBlockOutcome> {
	try {
		// Caller-owned review state must not change across an await.
		const input = {
			...confirmed,
			expectedContext: { ...confirmed.expectedContext },
			removal: { ...confirmed.removal, deviceIds: [...confirmed.removal.deviceIds] },
		};
		return await run(input, deps);
	} catch {
		return { kind: "refused", error: "invalid_input" };
	}
}
