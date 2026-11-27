import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BetterSqliteCoordinatorStore,
	type CoordinatorLegacyTeamCompletionManifestV1,
	coordinatorTeamRecoveryEvidenceActions,
	createBetterSqliteCoordinatorApp,
	ensureDeviceIdentity,
	loadPublicKey,
	type MemoryStore,
	readCoordinatorSyncConfig,
	TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS,
	type TeamRecoveryEvidenceActions,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isScopeDeviceAdmissionRefused } from "../../../core/src/scope-device-admission.js";
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

/**
 * The coordinator once the Laptop has been removed from the group. Each read can be replaced.
 * A reading lists the roster twice, once before the block check and once after it.
 */
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
		coordinatorUrl: COORDINATOR_ID,
		listDevices: async () => listed,
		listDeviceRemovals: async () => [LAPTOP_REMOVAL],
		deviceBlocksAndRemovals: async () => NOTHING_REPORTED,
		getCompletion: async () => manifest,
		listMemberRemovals: async () => [],
		readGroupBinding: async (teamId) => ({ team_id: teamId, state: "unbound" }),
		...overrides,
	};
	return actions;
}

type Config = ReturnType<typeof readCoordinatorSyncConfig>;

interface AppOptions {
	adminSecret?: string;
	coordinatorUrl?: string;
	groups?: string[];
	actions?: TeamRecoveryEvidenceActions;
	teamId?: string;
	nowMs?: () => number;
	/** What the configuration has become by the time it is read again. */
	changedConfig?: () => Partial<Config>;
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
			...options.changedConfig?.(),
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
const NOTHING_REPORTED = { blocked: [], keyRemoved: [], removedUnattributed: [] };

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
		["deviceBlocksAndRemovals", "device_blocks_unavailable"],
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

	it.each([
		[
			"409 when the block check reports the key it sent for an enrolled device removed",
			{ keyRemoved: ["device-b"] },
			[409, { error: "device_evidence_contradictory", deviceIds: ["device-b"] }],
		],
		[
			"503, to be tried again, when the block check reports a removal without saying which key",
			{ removedUnattributed: ["device-b"] },
			[503, { error: "device_block_unchecked", deviceIds: ["device-b"] }],
		],
	] as const)("answers %s", async (_case, reported, expected) => {
		const actions = coordinator({
			deviceBlocksAndRemovals: async () => ({ ...NOTHING_REPORTED, ...reported }),
		});

		expect(await app({ actions }).post("preview", {})).toEqual(expected);
		expect(teamState()).toBe("inactive:needs_setup");
	});

	it("recovers a Team whose setup kept another spelling of the configured coordinator URL", async () => {
		// Arrange: the Team was set up while the coordinator URL was spelled in capitals.
		db.close();
		db = new Database(":memory:");
		manifest = await quarantinedTeam(db, { coordinatorId: "HTTPS://COORDINATOR.EXAMPLE.INVALID" });

		const [status, body] = await app().post("preview", {});

		expect([status, body.state]).toEqual([200, "ready"]);
	});

	it("does not take two coordinator settings that are not URLs for the same coordinator", async () => {
		db.close();
		db = new Database(":memory:");
		manifest = await quarantinedTeam(db, { coordinatorId: "not a url" });

		const response = await app({ coordinatorUrl: "not a url either" }).post("preview", {});

		expect(response).toEqual([409, { error: "team_coordinator_not_configured" }]);
	});

	it("answers 503, and offers no plan, when the evidence is too old by the time it is read", async () => {
		// Arrange: this machine's clock passes the evidence limit while the reads are out.
		let calls = 0;
		const nowMs = () => {
			calls += 1;
			return Date.parse(NOW) + (calls === 1 ? 0 : TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS + 1);
		};

		expect(await app({ nowMs }).post("preview", {})).toEqual([503, { error: "evidence_stale" }]);
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
		// A reading lists the roster twice, and its first listing comes before any of its other reads.
		const pick = () => (rosterReads > 2 ? second : first);
		return coordinator({
			listDevices: (groupId) => {
				rosterReads += 1;
				return pick().listDevices(groupId);
			},
			deviceBlocksAndRemovals: (groupId, peers, deadlineMs) =>
				pick().deviceBlocksAndRemovals(groupId, peers, deadlineMs),
			listMemberRemovals: (groupId) => pick().listMemberRemovals(groupId),
		});
	}

	it.each([
		[
			"409 when the read after the commit shows a newly blocked device",
			{ deviceBlocksAndRemovals: async () => ({ ...NOTHING_REPORTED, blocked: ["device-b"] }) },
			[409, { error: "recovery_quarantined_again", reason: "evidence_changed" }],
		],
		[
			"409 when the block check after the commit reports a device's key removed since the roster was read",
			{ deviceBlocksAndRemovals: async () => ({ ...NOTHING_REPORTED, keyRemoved: ["device-b"] }) },
			[409, { error: "recovery_quarantined_again", reason: "evidence_changed" }],
		],
		[
			"409 when the block check after the commit reports a removal without saying which key",
			{
				deviceBlocksAndRemovals: async () => ({
					...NOTHING_REPORTED,
					removedUnattributed: ["device-b"],
				}),
			},
			[409, { error: "recovery_quarantined_again", reason: "evidence_changed" }],
		],
		[
			"503 when the read after the commit fails",
			{ deviceBlocksAndRemovals: failing },
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
		// Both readings, each listing the roster twice.
		expect(claimedDuring).toEqual([true, true, true, true]);
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

describe("Team recovery routes when the device stops being an admin mid-request", () => {
	const CHANGES: Array<[string, Partial<Config>]> = [
		["the admin secret is cleared", { syncCoordinatorAdminSecret: "" }],
		["the admin secret is replaced", { syncCoordinatorAdminSecret: "another-secret" }],
		["the setup's group is removed", { syncCoordinatorGroups: ["group-other"] }],
		[
			"another coordinator is configured",
			{ syncCoordinatorUrl: "https://elsewhere.example.invalid" },
		],
	];
	const count = (table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

	/** A request whose configuration changes while its `during`th reading is out. */
	function changingDuringRead(during: number, change: Partial<Config>) {
		let rosterReads = 0;
		let changed: Partial<Config> = {};
		const actions = coordinator({
			listDevices: (groupId, deadlineMs) => {
				rosterReads += 1;
				// Each reading lists the roster twice: change it on that reading's first listing.
				if (rosterReads === 2 * during - 1) changed = change;
				return coordinator().listDevices(groupId, deadlineMs);
			},
		});
		return app({ actions, changedConfig: () => changed });
	}

	it.each(CHANGES)(
		"refuses the commit and writes nothing when %s during its first read",
		async (_case, change) => {
			const digest = (await app().post("preview", {}))[1].expectedDigest;

			const response = await changingDuringRead(1, change).post("commit", {
				expectedDigest: digest,
			});

			expect(response).toEqual([403, { error: "admin_authority_changed" }]);
			expect(teamState()).toBe("inactive:needs_setup");
			expect(count("policy_team_recovery_holds")).toBe(0);
			expect(count("policy_team_recovery_exclusions")).toBe(0);
		},
	);

	it.each(CHANGES)(
		"keeps the Team held and serving nothing when %s during the read after the commit",
		async (_case, change) => {
			const digest = (await app().post("preview", {}))[1].expectedDigest;

			const response = await changingDuringRead(2, change).post("commit", {
				expectedDigest: digest,
			});

			expect(response).toEqual([
				403,
				{ error: "recovery_unverified", reason: "admin_authority_changed" },
			]);
			expect(teamState()).toBe("active:completed");
			expect(count("policy_team_recovery_holds")).toBe(1);
			expect(
				isScopeDeviceAdmissionRefused(db, { scopeId: "scope-engineering", deviceId: "device-b" }),
			).toBe(true);
		},
	);

	it("answers 403 and leaves the Team as it is when the read after the commit also fails", async () => {
		// Arrange: the admin secret is cleared while the read after the commit is out, and that read fails.
		const digest = (await app().post("preview", {}))[1].expectedDigest;
		let rosterReads = 0;
		let changed: Partial<Config> = {};
		const actions = coordinator({
			listDevices: (groupId, deadlineMs) => {
				rosterReads += 1;
				if (rosterReads <= 2) return coordinator().listDevices(groupId, deadlineMs);
				changed = { syncCoordinatorAdminSecret: "" };
				return Promise.reject(new Error("coordinator_unavailable"));
			},
		});

		const response = await app({ actions, changedConfig: () => changed }).post("commit", {
			expectedDigest: digest,
		});

		expect(response).toEqual([
			403,
			{ error: "recovery_unverified", reason: "admin_authority_changed" },
		]);
		expect(teamState()).toBe("active:completed");
		expect(count("policy_team_recovery_holds")).toBe(1);
	});

	it("gives no preview when the admin secret is cleared during its read", async () => {
		const response = await changingDuringRead(1, { syncCoordinatorAdminSecret: "" }).post(
			"preview",
			{},
		);

		expect(response).toEqual([403, { error: "coordinator_admin_required" }]);
	});
});

describe("Team recovery routes against a coordinator, with this device's own reads", () => {
	let root: string;
	let keysDir: string;
	let localDeviceId: string;
	const CONFIG = {
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: COORDINATOR_ID,
		syncCoordinatorGroups: [GROUP_ID],
		syncCoordinatorAdminSecret: "synthetic-admin",
	};

	/** A coordinator that holds the setup's group with this device, the Desktop and the Tablet enrolled. */
	async function coordinatorApp() {
		root = mkdtempSync(join(tmpdir(), "codemem-recovery-routes-"));
		// This device signs with keys in a directory that is not the default one.
		keysDir = join(root, "elsewhere", "keys");
		vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
		db.prepare("DELETE FROM sync_device").run();
		const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
		localDeviceId = deviceId;
		const coordinatorDbPath = join(root, "coordinator.sqlite");
		const store = new BetterSqliteCoordinatorStore(coordinatorDbPath);
		try {
			await store.createGroup(GROUP_ID);
			const publicKey = loadPublicKey(keysDir) ?? "";
			for (const device of [{ deviceId, fingerprint, publicKey }, DESKTOP, TABLET])
				await store.enrollDevice(GROUP_ID, device);
		} finally {
			await store.close();
		}
		return createBetterSqliteCoordinatorApp({
			dbPath: coordinatorDbPath,
			runtime: { adminSecret: () => "synthetic-admin", now: () => new Date().toISOString() },
		});
	}

	const store = () => ({ db, dbPath: ":memory:", deviceId: "unused" }) as unknown as MemoryStore;

	/** The real routes for a store on this test's database, with no read replaced unless given. */
	function realRoutes(actions?: TeamRecoveryEvidenceActions) {
		const routes = teamRecoveryRoutes(store, { readCoordinatorConfig: () => CONFIG, actions });
		return async () => {
			const response = await routes.request(
				`/api/sync/recipient-policy/v1/teams/${manifest.team_id}/recovery/preview`,
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
			);
			return [response.status, await response.json()];
		};
	}

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("signs the block check with the keys in the directory CODEMEM_KEYS_DIR names", async () => {
		const coordinatorRoutes = await coordinatorApp();
		vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
			coordinatorRoutes.request(String(input), init),
		);

		// Assert: every device read was accepted, so the first thing missing is the setup's copy.
		expect(await realRoutes()()).toEqual([409, { error: "completion_missing" }]);
	});

	it("answers 503 when the coordinator's block reply says nothing about the devices asked about", async () => {
		// Arrange: the coordinator's own reads, signed with this device's keys wherever they are.
		const coordinatorRoutes = await coordinatorApp();
		const malformed = { version: 1, revoked: [], removed: [], enrolled: [], removal_seq: 0 };
		vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
			String(input).includes("/v1/peers/revocations")
				? Promise.resolve(Response.json(malformed))
				: coordinatorRoutes.request(String(input), init),
		);
		const actions = coordinatorTeamRecoveryEvidenceActions(store(), CONFIG, {
			localDeviceId,
			keysDir,
		});

		expect(await realRoutes(actions)()).toEqual([503, { error: "device_blocks_unavailable" }]);
	});
});
