/**
 * Viewer side of "Sign in with Google" when the account belongs to another
 * Identity (ADR 0005 Section 8): run the coordinator rebind, then switch this
 * device's local Identity. An unclear outcome stays recorded and resumes.
 */
import { createHash } from "node:crypto";
import {
	applyLocalIdentitySwitch,
	assertNoLocalIdentityOverride,
	completeLocalIdentitySwitch,
	type DeviceRebindClientRefusal,
	type DeviceRebindReceiptV1,
	loadPublicKey,
	type MemoryStore,
	markLocalIdentitySwitchBound,
	markLocalIdentitySwitchNotCommitted,
	readOpenLocalIdentitySwitch,
	recordLocalIdentitySwitch,
	resumeDeviceRebind,
	runDeviceRebind,
} from "@codemem/core";
import type { AccountContext } from "./context.js";

export type AccountRebindResult =
	| { kind: "switched"; targetIdentityId: string }
	/** Self-bind: the account is this Identity's, and the device now holds its own binding. */
	| { kind: "bound" }
	/** A self-bind may have committed; nothing local changes, so status tells. */
	| { kind: "bind_unknown" }
	| { kind: "refused"; reason: DeviceRebindClientRefusal; beforeBrowser?: true }
	| { kind: "failed" }
	/** The coordinator may have committed, or did and the local switch is unfinished. */
	| { kind: "pending" };

export type AccountRebindRunner = (input: {
	context: AccountContext;
	signal: AbortSignal;
	onBrowserStart: (url: string) => void;
	/** The registry's live account-context check; false stops the switch before finalize. */
	isCurrent?: () => boolean;
}) => Promise<AccountRebindResult>;

/** Pins the local facts the person reviewed; the coordinator stores and signs it. */
function reviewDigest(store: MemoryStore, context: AccountContext): string {
	const binding = store.db
		.prepare("SELECT identity_id, assignment_version FROM identity_devices WHERE device_id = ?")
		.get(context.deviceId);
	const localActors = store.db
		.prepare("SELECT actor_id FROM actors WHERE is_local = 1 ORDER BY actor_id")
		.pluck()
		.all();
	return createHash("sha256")
		.update(
			JSON.stringify([
				"codemem-device-rebind-review-v1",
				context.deviceId,
				context.fingerprint,
				context.identityId,
				binding ?? null,
				localActors,
			]),
		)
		.digest("hex");
}

/**
 * Finishes the local half from a coordinator receipt. Each step is
 * idempotent, so a later resume can repeat it.
 */
function finishLocalSwitch(
	store: MemoryStore,
	paths: { keysDir?: string; configPath?: string },
	attemptId: string,
	receipt?: DeviceRebindReceiptV1,
): AccountRebindResult {
	try {
		if (receipt) markLocalIdentitySwitchBound(store.db, receipt);
		const context = { configPath: paths.configPath };
		applyLocalIdentitySwitch(
			store.db,
			{
				attemptId,
				// Same person, so the current display name carries over.
				displayName: store.actorDisplayName,
				expectedPublicKey: loadPublicKey(paths.keysDir) ?? "",
			},
			context,
		);
		completeLocalIdentitySwitch(store.db, { attemptId, configPath: paths.configPath });
		const target = readTarget(store, attemptId);
		if (!target || !store.refreshPersistedLocalIdentity(target)) return { kind: "pending" };
		return { kind: "switched", targetIdentityId: target };
	} catch {
		return { kind: "pending" };
	}
}

function readTarget(store: MemoryStore, attemptId: string): string | null {
	const row = store.db
		.prepare(
			"SELECT target_identity_id FROM local_identity_switches WHERE attempt_id = ? AND state = 'completed'",
		)
		.pluck()
		.get(attemptId);
	return typeof row === "string" ? row : null;
}

export function createAccountRebindRunner(store: MemoryStore): AccountRebindRunner {
	return async ({ context, signal, onBrowserStart, isCurrent = () => true }) => {
		try {
			assertNoLocalIdentityOverride();
		} catch {
			return { kind: "failed" };
		}
		const earlier = await resolveOpenSwitch(store, context);
		if (earlier) return earlier;
		const recorded: { attemptId?: string } = {};
		const outcome = await runRebind(store, context, {
			signal,
			onBrowserStart,
			recorded,
			isCurrent,
		});
		return settleOutcome(store, context, outcome, recorded.attemptId);
	};
}

/** An earlier switch left open is resolved first; no new Google trip until it is. */
async function resolveOpenSwitch(
	store: MemoryStore,
	context: AccountContext,
): Promise<AccountRebindResult | null> {
	if (!readOpenLocalIdentitySwitch(store.db)) return null;
	const resumed = await resumeAccountRebind(store, context);
	if (resumed?.kind === "switched") return resumed;
	return readOpenLocalIdentitySwitch(store.db) ? { kind: "pending" } : null;
}

/**
 * A refusal or failure means this run's finalize did not commit, and nothing
 * else sends it, so the attempt this run recorded can close at once.
 */
function settleOutcome(
	store: MemoryStore,
	context: AccountContext,
	outcome: Awaited<ReturnType<typeof runDeviceRebind>>,
	recordedAttemptId: string | undefined,
): AccountRebindResult {
	if ((outcome.kind === "refused" || outcome.kind === "failed") && recordedAttemptId)
		markLocalIdentitySwitchNotCommitted(store.db, recordedAttemptId);
	if (outcome.kind === "refused")
		return {
			kind: "refused",
			reason: outcome.reason,
			...(outcome.beforeBrowser ? { beforeBrowser: true as const } : {}),
		};
	if (outcome.kind === "failed") return { kind: "failed" };
	if (outcome.kind === "unknown")
		return isSelfBind(outcome.pending) ? { kind: "bind_unknown" } : { kind: "pending" };
	if (isSelfBind(outcome.receipt)) return { kind: "bound" };
	return finishLocalSwitch(store, context, outcome.receipt.attemptId, outcome.receipt);
}

/** A self-bind keeps this device's Identity, so it has no local switch. */
function isSelfBind(attempt: { previousIdentityId: string; targetIdentityId: string }): boolean {
	return attempt.targetIdentityId === attempt.previousIdentityId;
}

function runRebind(
	store: MemoryStore,
	context: AccountContext,
	run: {
		signal: AbortSignal;
		onBrowserStart: (url: string) => void;
		recorded: { attemptId?: string };
		isCurrent: () => boolean;
	},
) {
	return runDeviceRebind({
		dbPath: context.dbPath,
		keysDir: context.keysDir,
		coordinatorUrl: context.coordinatorUrl,
		groupId: context.groupId,
		currentIdentityId: context.identityId,
		reviewDigest: reviewDigest(store, context),
		openBrowser: run.onBrowserStart,
		recordPending: (pending) => {
			// The account context and the local facts the person reviewed must still hold.
			if (!run.isCurrent()) throw new Error("device_rebind_context_changed");
			if (reviewDigest(store, context) !== pending.reviewDigest)
				throw new Error("device_rebind_review_changed");
			if (isSelfBind(pending)) return;
			recordLocalIdentitySwitch(store.db, pending, { configPath: context.configPath });
			run.recorded.attemptId = pending.attemptId;
		},
		signal: run.signal,
	});
}

/**
 * Picks up a switch an earlier run left open. A recorded attempt is resolved
 * by reading coordinator status, never by sending finalize again.
 */
export async function resumeAccountRebind(
	store: MemoryStore,
	paths: { keysDir?: string; configPath?: string },
): Promise<AccountRebindResult | null> {
	const open = readOpenLocalIdentitySwitch(store.db);
	if (!open) return null;
	if (open.state !== "pending") return finishLocalSwitch(store, paths, open.attemptId);
	const resumed = await resumeDeviceRebind({
		dbPath: store.dbPath,
		keysDir: paths.keysDir,
		coordinatorUrl: open.coordinatorOrigin,
		groupId: open.groupId,
		pending: open,
	});
	if (resumed.kind === "finalized")
		return finishLocalSwitch(store, paths, open.attemptId, resumed.receipt);
	if (resumed.kind === "not_committed") {
		markLocalIdentitySwitchNotCommitted(store.db, open.attemptId);
		return { kind: "failed" };
	}
	return { kind: "pending" };
}
