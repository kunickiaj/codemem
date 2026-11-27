import {
	commitTeamRecovery,
	coordinatorTeamRecoveryEvidenceActions,
	isCoordinatorAdminDevice,
	isStrictRecipientPolicyId,
	isTeamRecoveryEvidenceStale,
	previewTeamRecovery,
	readCoordinatorSyncConfig,
	readTeamRecoveryEvidence,
	type TeamRecoveryCommitRefusal,
	type TeamRecoveryCommitResult,
	type TeamRecoveryEvidenceActions,
	type TeamRecoveryEvidenceTarget,
	teamRecoveryTarget,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import { parseViewerJsonBody, type StoreFactory } from "./sync.js";
import {
	claimCandidateMutation,
	daemonSigningIdentity,
	normalizedCoordinatorId,
} from "./team-setup.js";

/*
 * Viewer routes for recovering a Team that was disabled after device removals:
 * a preview that lists what a recovery would restore and leave out, and a
 * commit bound to that preview's digest. Only an admin device can recover a
 * Team, because the evidence comes from the coordinator's admin reads.
 *
 * Both routes read the evidence themselves, from the configured coordinator,
 * for each request. Those reads take a while, so the configuration is read
 * again after them: inside the transaction that writes the recovery and inside
 * the one that settles it. A device that is no longer an admin of the setup's
 * group by then recovers nothing.
 *
 * The commit holds the Team setup claim for its candidate from before its
 * first read until its recovery is settled, so background reconciliation skips
 * the group meanwhile and retries it afterwards.
 */

const BASE = "/api/sync/recipient-policy/v1/teams/:teamId/recovery";

type Status = 400 | 403 | 404 | 409 | 503;

// 503: a read of the coordinator failed or was too old, and the same request can be tried again.
// 409: the Team, its setup or its evidence is in a state recovery does not accept.
// 403: this device stopped being an admin of the setup's group while the request ran.
const REFUSAL_STATUS: Record<TeamRecoveryCommitRefusal, Status> = {
	invalid_input: 400,
	team_not_found: 404,
	team_not_quarantined: 409,
	setup_record_missing: 409,
	roster_unavailable: 503,
	device_removals_unavailable: 503,
	device_blocks_unavailable: 503,
	completion_unavailable: 503,
	member_removals_unavailable: 503,
	team_group_unavailable: 503,
	completion_missing: 409,
	completion_invalid: 409,
	setup_differs_from_completion: 409,
	team_group_conflict: 409,
	team_group_mismatch: 409,
	team_policy_blocked: 409,
	device_blocked: 409,
	device_evidence_contradictory: 409,
	device_key_unverified: 409,
	device_key_changed: 409,
	device_disabled: 409,
	device_block_unchecked: 503,
	device_missing_without_removal: 409,
	device_decision_changed: 409,
	evidence_stale: 503,
	admin_authority_changed: 403,
	recovery_preview_stale: 409,
	recovery_state_changed: 409,
};

export interface TeamRecoveryRouteOptions {
	readCoordinatorConfig?: typeof readCoordinatorSyncConfig;
	/** Coordinator reads, replaced in tests. */
	actions?: TeamRecoveryEvidenceActions;
	/** This machine's clock, replaced in tests. */
	nowMs?: () => number;
}

interface Request {
	db: ReturnType<StoreFactory>["db"];
	target: TeamRecoveryEvidenceTarget;
	actions: TeamRecoveryEvidenceActions;
	/**
	 * Whether the configuration, read again now, still makes this device an admin
	 * of the setup's coordinator and group with the secret the request started with.
	 */
	stillAuthorized: () => boolean;
}

type Refused = { error: string; status: Status };
type Config = ReturnType<typeof readCoordinatorSyncConfig>;

/** Whether the configuration is for the setup's coordinator and one of its groups. */
function configuredFor(config: Config, target: TeamRecoveryEvidenceTarget): boolean {
	// The setup keeps the coordinator URL as it was spelled then, so both sides are normalized.
	const configured = normalizedCoordinatorId(config.syncCoordinatorUrl);
	return (
		configured !== null &&
		configured === normalizedCoordinatorId(target.coordinatorId) &&
		config.syncCoordinatorGroups.includes(target.groupId)
	);
}

/**
 * The coordinator reads for this device. The block check is signed with the
 * identity the sync daemon signs with, keys directory included. Without a
 * usable one the check fails, and the recovery reads it as unavailable.
 */
function evidenceActions(store: ReturnType<StoreFactory>, config: Config) {
	const identity = daemonSigningIdentity(store);
	const actions = coordinatorTeamRecoveryEvidenceActions(
		store,
		config,
		identity ?? { localDeviceId: "" },
	);
	if (identity) return actions;
	const unsigned = () => Promise.reject(new Error("signing_identity_unavailable"));
	return { ...actions, deviceBlocksAndRemovals: unsigned };
}

/**
 * What a request acts on, or why it cannot: the device is no admin, the Team
 * has no completed setup here, or its setup belongs to a coordinator or group
 * this device is not configured for.
 */
function recoveryRequest(
	teamId: string,
	getStore: StoreFactory,
	options: TeamRecoveryRouteOptions,
): Request | Refused {
	const readConfig = options.readCoordinatorConfig ?? readCoordinatorSyncConfig;
	const config = readConfig();
	if (!isCoordinatorAdminDevice(config))
		return { error: "coordinator_admin_required", status: 403 };
	if (!isStrictRecipientPolicyId(teamId)) return { error: "invalid_input", status: 400 };
	const store = getStore();
	const target = teamRecoveryTarget(store.db, teamId);
	if (!target) return { error: "team_not_found", status: 404 };
	// Every read goes to the configured coordinator, so the setup must be one of its groups.
	if (!configuredFor(config, target))
		return { error: "team_coordinator_not_configured", status: 409 };
	const stillAuthorized = () => {
		const current = readConfig();
		return (
			isCoordinatorAdminDevice(current) &&
			configuredFor(current, target) &&
			current.syncCoordinatorAdminSecret === config.syncCoordinatorAdminSecret
		);
	};
	const actions = options.actions ?? evidenceActions(store, config);
	return { db: store.db, target, actions, stillAuthorized };
}

/** The response for a commit that did not leave the Team recovered. */
function commitFailure(result: Exclude<TeamRecoveryCommitResult, { state: "recovered" }>): {
	body: Record<string, unknown>;
	status: Status;
} {
	if (result.state === "refused") {
		const { reason, deviceIds } = result;
		return {
			body: deviceIds ? { error: reason, deviceIds } : { error: reason },
			status: REFUSAL_STATUS[reason],
		};
	}
	if (result.state === "superseded") return { body: { error: "recovery_superseded" }, status: 409 };
	// The Team is still held and serves nothing. Trying the recovery again takes the hold over.
	if (result.state === "unverified") {
		const status = result.reason === "admin_authority_changed" ? 403 : 503;
		return { body: { error: "recovery_unverified", reason: result.reason }, status };
	}
	// The Team is disabled again. A read that failed can be tried again as it is.
	return {
		body: { error: "recovery_quarantined_again", reason: result.reason },
		status: result.reason === "evidence_unavailable" ? 503 : 409,
	};
}

function isEmptyObject(body: unknown): boolean {
	return Boolean(body) && typeof body === "object" && Object.keys(body as object).length === 0;
}

function commitBody(body: unknown): { expectedDigest: string } | null {
	const data = body as Record<string, unknown> | null;
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	if (Object.keys(data).length !== 1) return null;
	const { expectedDigest } = data;
	if (typeof expectedDigest !== "string" || !expectedDigest || expectedDigest.length > 256)
		return null;
	return { expectedDigest };
}

export function teamRecoveryRoutes(getStore: StoreFactory, options: TeamRecoveryRouteOptions = {}) {
	const app = new Hono();
	const read = (request: Request) =>
		readTeamRecoveryEvidence(request.target, request.actions, options.nowMs);

	app.post(`${BASE}/preview`, async (c: Context) => {
		const request = recoveryRequest(c.req.param("teamId") ?? "", getStore, options);
		if ("error" in request) return c.json({ error: request.error }, request.status);
		if (!isEmptyObject(await parseViewerJsonBody(c, { allowEmpty: true })))
			return c.json({ error: "invalid_input" }, 400);
		const { evidence, startedAtMs } = await read(request);
		// The reads take a while. A device that is no admin by now gets no preview.
		if (!request.stillAuthorized()) return c.json({ error: "coordinator_admin_required" }, 403);
		const nowMs = (options.nowMs ?? Date.now)();
		// The commit refuses evidence this old, so no plan is offered on it.
		if (isTeamRecoveryEvidenceStale(startedAtMs, nowMs))
			return c.json({ error: "evidence_stale" }, REFUSAL_STATUS.evidence_stale);
		const preview = previewTeamRecovery(request.db, request.target, evidence, { nowMs });
		if (preview.state === "ready") return c.json(preview);
		const failure = commitFailure(preview);
		return c.json(failure.body, failure.status);
	});

	app.post(`${BASE}/commit`, async (c: Context) => {
		const request = recoveryRequest(c.req.param("teamId") ?? "", getStore, options);
		if ("error" in request) return c.json({ error: request.error }, request.status);
		const input = commitBody(await parseViewerJsonBody(c));
		if (!input) return c.json({ error: "invalid_input" }, 400);
		// Held until the recovery is settled: reconciliation must not reach a held Team in between.
		const release = claimCandidateMutation(request.db, request.target.candidateRef);
		if (!release) return c.json({ error: "team_setup_busy" }, 409);
		try {
			const result = await commitTeamRecovery(
				request.db,
				{ ...request.target, ...input },
				{
					readEvidence: () => read(request),
					nowMs: options.nowMs,
					stillAuthorized: request.stillAuthorized,
				},
			);
			if (result.state === "recovered") return c.json(result);
			const failure = commitFailure(result);
			return c.json(failure.body, failure.status);
		} finally {
			release();
		}
	});

	return app;
}
