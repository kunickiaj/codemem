import {
	type CoordinatorLegacyTeamCompletionManifestV1,
	type MemoryStore,
	readCoordinatorSyncConfig,
	type TeamRecoveryEvidenceActions,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CANDIDATE,
	COORDINATOR_ID,
	DESKTOP,
	GROUP_ID,
	LAPTOP_REMOVAL,
	NOW,
	quarantinedTeam,
	TABLET,
} from "../../../core/src/team-recovery-test-fixtures.js";
import { teamRecoveryRoutes } from "./team-recovery.js";
import { claimCandidateMutation } from "./team-setup.js";

let db: InstanceType<typeof Database>;
let manifest: CoordinatorLegacyTeamCompletionManifestV1;

beforeEach(async () => {
	db = new Database(":memory:");
	manifest = await quarantinedTeam(db);
});

afterEach(() => db.close());

const teamState = () =>
	db.prepare("SELECT status || ':' || migration_state FROM policy_teams").pluck().get();

/** The coordinator once the Laptop has been removed from the group. Each read can be replaced. */
function coordinator(overrides: Partial<TeamRecoveryEvidenceActions> = {}) {
	const listed = [DESKTOP, TABLET].map((device) => ({
		group_id: GROUP_ID,
		device_id: device.deviceId,
		public_key: device.publicKey,
		fingerprint: device.fingerprint,
		identity_id: null,
		display_name: device.displayName,
		enabled: 1,
		created_at: NOW,
	}));
	const actions: TeamRecoveryEvidenceActions = {
		listDevices: async () => listed,
		listDeviceRemovals: async () => [LAPTOP_REMOVAL],
		blockedDeviceIds: async () => [],
		getCompletion: async () => manifest,
		listMemberRemovals: async () => [],
		readGroupBinding: async (teamId) => ({ team_id: teamId, state: "unbound" }),
		...overrides,
	};
	return actions;
}

interface AppOptions {
	adminSecret?: string;
	coordinatorUrl?: string;
	groups?: string[];
	actions?: TeamRecoveryEvidenceActions;
	teamId?: string;
	nowMs?: () => number;
}

function app(options: AppOptions = {}) {
	const store = {
		db,
		actorId: "identity-local",
		deviceId: "device-local",
	} as unknown as MemoryStore;
	const routes = teamRecoveryRoutes(() => store, {
		readCoordinatorConfig: () => ({
			...readCoordinatorSyncConfig({}),
			syncCoordinatorUrl: options.coordinatorUrl ?? COORDINATOR_ID,
			syncCoordinatorGroups: options.groups ?? [GROUP_ID],
			syncCoordinatorAdminSecret: options.adminSecret ?? "synthetic-admin",
		}),
		actions: options.actions ?? coordinator(),
		nowMs: options.nowMs ?? (() => Date.parse(NOW)),
	});
	const post = async (path: string, body: unknown) => {
		const teamId = options.teamId ?? manifest.team_id;
		const response = await routes.request(
			`/api/sync/recipient-policy/v1/teams/${teamId}/recovery/${path}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		return [response.status, await response.json()] as const;
	};
	return { post };
}

const failing = () => Promise.reject(new Error("coordinator_unavailable"));

describe("Team recovery routes", () => {
	it("previews, then commits the reviewed recovery", async () => {
		const { post } = app();

		const [previewStatus, preview] = await post("preview", {});
		const [commitStatus, commit] = await post("commit", {
			expectedDigest: preview.expectedDigest,
		});

		expect(previewStatus).toBe(200);
		expect(preview).toMatchObject({ state: "ready", teamId: manifest.team_id });
		expect([commitStatus, commit.state]).toEqual([200, "recovered"]);
		expect(teamState()).toBe("active:completed");
		expect(db.prepare("SELECT COUNT(*) FROM policy_team_recovery_holds").pluck().get()).toBe(0);
	});

	it.each(["preview", "commit"])(
		"refuses %s from a device without the coordinator admin secret",
		async (path) => {
			const [status, body] = await app({ adminSecret: "" }).post(path, { expectedDigest: "d" });

			expect([status, body]).toEqual([403, { error: "coordinator_admin_required" }]);
			expect(teamState()).toBe("inactive:needs_setup");
		},
	);

	it.each([
		["preview", { extra: 1 }],
		["commit", {}],
		["commit", { expectedDigest: "" }],
		["commit", { expectedDigest: "d", extra: 1 }],
		["commit", { expectedDigest: "d".repeat(257) }],
	])("refuses a malformed %s body", async (path, body) => {
		expect(await app().post(path, body)).toEqual([400, { error: "invalid_input" }]);
	});

	it("answers 404 for a Team no setup here completed", async () => {
		const [status, body] = await app({ teamId: "team-unknown" }).post("preview", {});

		expect([status, body]).toEqual([404, { error: "team_not_found" }]);
	});

	it.each([
		["another coordinator", { coordinatorUrl: "https://elsewhere.example.invalid" }],
		["other groups only", { groups: ["group-other"] }],
	])("answers 409 when this device is configured for %s", async (_case, options) => {
		const [status, body] = await app(options).post("preview", {});

		expect([status, body]).toEqual([409, { error: "team_coordinator_not_configured" }]);
	});
});

describe("Team recovery route statuses", () => {
	it.each([
		["listDevices", "roster_unavailable"],
		["listDeviceRemovals", "device_removals_unavailable"],
		["blockedDeviceIds", "device_blocks_unavailable"],
		["getCompletion", "completion_unavailable"],
		["listMemberRemovals", "member_removals_unavailable"],
		["readGroupBinding", "team_group_unavailable"],
	] as const)("answers 503 and changes nothing when %s fails", async (action, error) => {
		const actions = coordinator({ [action]: failing });
		const digest = (await app().post("preview", {}))[1].expectedDigest;

		expect(await app({ actions }).post("preview", {})).toEqual([503, { error }]);
		expect(await app({ actions }).post("commit", { expectedDigest: digest })).toEqual([
			503,
			{ error },
		]);
		expect(teamState()).toBe("inactive:needs_setup");
	});

	it("answers 409 for a Team that is not disabled", async () => {
		db.prepare("UPDATE policy_teams SET status = 'active', migration_state = 'completed'").run();

		expect(await app().post("preview", {})).toEqual([409, { error: "team_not_quarantined" }]);
	});

	it("answers 409 with the devices when a device stops the recovery", async () => {
		// Arrange: the Laptop is gone from the roster and no removal record explains it.
		const actions = coordinator({ listDeviceRemovals: async () => [] });

		const [status, body] = await app({ actions }).post("preview", {});

		expect(status).toBe(409);
		expect(body).toEqual({ error: "device_missing_without_removal", deviceIds: ["device-a"] });
	});

	it("answers 409 for a digest from another preview, and 503 for evidence that is too old", async () => {
		const { post } = app();
		const digest = (await post("preview", {}))[1].expectedDigest;
		// The reads start now and the commit's transaction starts a minute later.
		let reads = 0;
		const slow = app({ nowMs: () => Date.parse(NOW) + (reads++ === 0 ? 0 : 60_000) });

		expect(await post("commit", { expectedDigest: "team-recovery-preview-v1:other" })).toEqual([
			409,
			{ error: "recovery_preview_stale" },
		]);
		expect(await slow.post("commit", { expectedDigest: digest })).toEqual([
			503,
			{ error: "evidence_stale" },
		]);
		expect(teamState()).toBe("inactive:needs_setup");
	});
});

describe("Team recovery commit route after its first transaction", () => {
	/** A coordinator whose reads after the first full set are answered by `later`. */
	function changing(later: Partial<TeamRecoveryEvidenceActions>) {
		let rosterReads = 0;
		const first = coordinator();
		const second = coordinator(later);
		const pick = () => (rosterReads > 1 ? second : first);
		return coordinator({
			listDevices: (groupId) => {
				rosterReads += 1;
				return pick().listDevices(groupId);
			},
			blockedDeviceIds: (groupId, peers) => pick().blockedDeviceIds(groupId, peers),
			listMemberRemovals: (groupId) => pick().listMemberRemovals(groupId),
		});
	}

	it.each([
		[
			"409 when the read after the commit shows a newly blocked device",
			{ blockedDeviceIds: async () => ["device-b"] },
			[409, { error: "recovery_quarantined_again", reason: "evidence_changed" }],
		],
		[
			"503 when the read after the commit fails",
			{ blockedDeviceIds: failing },
			[503, { error: "recovery_quarantined_again", reason: "evidence_unavailable" }],
		],
	] as const)(
		"answers %s, and leaves the Team disabled and held",
		async (_case, later, expected) => {
			const digest = (await app().post("preview", {}))[1].expectedDigest;

			const response = await app({ actions: changing(later) }).post("commit", {
				expectedDigest: digest,
			});

			expect(response).toEqual(expected);
			expect(teamState()).toBe("inactive:needs_setup");
			expect(db.prepare("SELECT COUNT(*) FROM policy_team_recovery_holds").pluck().get()).toBe(1);
		},
	);

	it("holds the Team setup claim from before its first read until the recovery is settled", async () => {
		// Arrange: reconciliation takes the same claim, so it skips the group while this holds.
		const digest = (await app().post("preview", {}))[1].expectedDigest;
		const claimedDuring: boolean[] = [];
		const actions = coordinator({
			listDevices: (groupId) => {
				claimedDuring.push(claimCandidateMutation(db, CANDIDATE) === null);
				return coordinator().listDevices(groupId);
			},
		});

		const [status] = await app({ actions }).post("commit", { expectedDigest: digest });

		expect(status).toBe(200);
		expect(claimedDuring).toEqual([true, true]);
		const release = claimCandidateMutation(db, CANDIDATE);
		expect(release).not.toBeNull();
		release?.();
	});

	it("answers 409 and reads nothing while Team setup holds the claim", async () => {
		const release = claimCandidateMutation(db, CANDIDATE);
		let reads = 0;
		const actions = coordinator({
			listDevices: (groupId) => {
				reads += 1;
				return coordinator().listDevices(groupId);
			},
		});
		try {
			const response = await app({ actions }).post("commit", { expectedDigest: "d" });

			expect(response).toEqual([409, { error: "team_setup_busy" }]);
			expect(reads).toBe(0);
		} finally {
			release?.();
		}
	});
});
