import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { fetchBlockedDeviceIdsForGroup } from "./coordinator-peer-revocation.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
import {
	coordinatorTeamRecoveryEvidenceActions,
	readTeamRecoveryEvidence,
	type TeamRecoveryEvidenceActions,
	teamRecoveryTarget,
} from "./team-recovery-evidence-reader.js";
import {
	CANDIDATE,
	quarantinedTeam,
	TARGET as RECOVERY_TARGET,
} from "./team-recovery-test-fixtures.js";
import { initTestSchema } from "./test-utils.js";

const TARGET = {
	coordinatorId: "https://coordinator.example.invalid",
	groupId: "group-engineering",
	teamId: "team-engineering",
	candidateRef: "legacy-team-candidate:engineering",
};
const HERE = { coordinatorId: TARGET.coordinatorId };
const GROUP = { ...HERE, groupId: TARGET.groupId };

const enrolled = (deviceId: string, enabled = 1): CoordinatorEnrollment => ({
	group_id: TARGET.groupId,
	device_id: deviceId,
	public_key: `key-of-${deviceId}`,
	fingerprint: `fingerprint-of-${deviceId}`,
	identity_id: null,
	display_name: null,
	enabled,
	created_at: "2026-09-01T12:00:00.000Z",
});

/** A coordinator that answers every read, with the Desktop blocked. */
function coordinator(overrides: Partial<TeamRecoveryEvidenceActions> = {}) {
	const asked: unknown[] = [];
	const actions: TeamRecoveryEvidenceActions = {
		listDevices: async (groupId) => {
			asked.push(["devices", groupId]);
			return [enrolled("device-a"), enrolled("device-b", 0)];
		},
		listDeviceRemovals: async () => [
			{ group_id: "group-other", device_id: "device-z", fingerprint: "fingerprint-z" },
		],
		blockedDeviceIds: async (groupId, peers) => {
			asked.push(["blocks", groupId, peers]);
			// A reply can name anything. Only the devices that were asked about count.
			return ["device-b", "device-never-asked"];
		},
		getCompletion: async (groupId, candidateRef) => ({ groupId, candidateRef }),
		listMemberRemovals: async () => [],
		readGroupBinding: async (teamId) => ({ team_id: teamId, state: "unbound" }),
		...overrides,
	};
	return { actions, asked };
}

const failing = () => Promise.reject(new Error("coordinator_unavailable"));

describe("Team recovery evidence reader", () => {
	it("stamps each part with the coordinator and group it asked, and each block answer with the device and key it sent", async () => {
		const { actions, asked } = coordinator();

		const { evidence } = await readTeamRecoveryEvidence(TARGET, actions);

		expect(evidence.roster).toEqual({
			status: "read",
			source: GROUP,
			devices: [
				{
					deviceId: "device-a",
					fingerprint: "fingerprint-of-device-a",
					displayName: "Device",
					enabled: true,
				},
				{
					deviceId: "device-b",
					fingerprint: "fingerprint-of-device-b",
					displayName: "Device",
					enabled: false,
				},
			],
		});
		expect(evidence.deviceBlocks).toEqual({
			status: "read",
			source: GROUP,
			checks: [
				{ deviceId: "device-a", publicKey: "key-of-device-a", blocked: false },
				{ deviceId: "device-b", publicKey: "key-of-device-b", blocked: true },
			],
		});
		expect(evidence.deviceRemovals).toMatchObject({ status: "read", source: HERE });
		expect(evidence.completion).toEqual({
			status: "read",
			source: GROUP,
			manifest: { groupId: TARGET.groupId, candidateRef: TARGET.candidateRef },
		});
		expect(evidence.memberRemovals).toEqual({ status: "read", source: GROUP, removals: [] });
		expect(evidence.groupBinding).toEqual({
			status: "read",
			source: HERE,
			binding: { team_id: TARGET.teamId, state: "unbound" },
		});
		expect(asked).toContainEqual([
			"blocks",
			TARGET.groupId,
			[
				{ device_id: "device-a", public_key: "key-of-device-a" },
				{ device_id: "device-b", public_key: "key-of-device-b" },
			],
		]);
	});

	it.each([
		["listDeviceRemovals", "deviceRemovals"],
		["blockedDeviceIds", "deviceBlocks"],
		["getCompletion", "completion"],
		["listMemberRemovals", "memberRemovals"],
		["readGroupBinding", "groupBinding"],
	] as const)(
		"reads a failed %s as that part unavailable and still reads the rest",
		async (action, part) => {
			const { actions } = coordinator({ [action]: failing });

			const { evidence } = await readTeamRecoveryEvidence(TARGET, actions);

			const statuses = Object.entries(evidence).map(([name, read]) => [name, read.status]);
			expect(statuses.filter(([, status]) => status === "unavailable")).toEqual([
				[part, "unavailable"],
			]);
		},
	);

	it("reads neither the roster nor the block checks when the device list fails", async () => {
		const { actions, asked } = coordinator({ listDevices: failing });

		const { evidence } = await readTeamRecoveryEvidence(TARGET, actions);

		expect(evidence.roster).toEqual({ status: "unavailable" });
		expect(evidence.deviceBlocks).toEqual({ status: "unavailable" });
		expect(asked).toEqual([]);
	});

	it("takes the start of the reading from this machine's clock before any read is sent", async () => {
		let clock = 1_000;
		const { actions } = coordinator({
			listDevices: async () => {
				clock += 5_000;
				return [];
			},
		});

		const reading = await readTeamRecoveryEvidence(TARGET, actions, () => clock);

		expect(reading.startedAtMs).toBe(1_000);
	});
});

const GROUP_ID = "group-a";
const peer = { device_id: "device-peer", public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPeer" };

/** This device with its keys in a temporary directory, set up and removed around each test. */
function useLocalDevice() {
	const local = {} as { root: string; db: Database.Database; keysDir: string; deviceId: string };
	beforeEach(() => {
		local.root = mkdtempSync(join(tmpdir(), "codemem-recovery-blocks-"));
		local.keysDir = join(local.root, "keys");
		local.db = new Database(":memory:");
		initTestSchema(local.db);
		[local.deviceId] = ensureDeviceIdentity(local.db, { keysDir: local.keysDir });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		local.db.close();
		rmSync(local.root, { recursive: true, force: true });
	});
	return local;
}

describe("the block check a Team recovery sends", () => {
	const local = useLocalDevice();
	let servers: Server[];

	beforeEach(() => {
		servers = [];
	});

	afterEach(async () => {
		await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
	});

	const check = (url: string, groups: string[], peers = [peer]) =>
		fetchBlockedDeviceIdsForGroup(
			{ db: local.db, dbPath: ":memory:" },
			readCoordinatorSyncConfig({ sync_coordinator_url: url, sync_coordinator_groups: groups }),
			{ localDeviceId: local.deviceId, keysDir: local.keysDir, groupId: GROUP_ID },
			peers,
		);

	/** A local HTTP server, and the URL it listens on. */
	async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
		const server = createServer(handler);
		servers.push(server);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	it("refuses an answer that arrives through a redirect", async () => {
		// Arrange: another server would answer that nothing is blocked.
		const elsewhere = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ version: 1, revoked: [], removed: [], enrolled: [], removal_seq: 0 }),
			);
		});
		const coordinatorUrl = await serve((request, response) => {
			response.writeHead(307, { location: `${elsewhere}${request.url}` });
			response.end();
		});

		await expect(check(coordinatorUrl, [GROUP_ID])).rejects.toThrow();
		// The same answer given directly is accepted, so the redirect is what was refused.
		await expect(check(elsewhere, [GROUP_ID])).resolves.toEqual([]);
	});

	it("asks exactly the group it was given, and fails when that group refuses", async () => {
		// Arrange: this device is enrolled in another configured group only.
		const coordinatorDbPath = join(local.root, "coordinator.sqlite");
		const store = new BetterSqliteCoordinatorStore(coordinatorDbPath);
		try {
			await store.createGroup("group-other");
			await store.createGroup(GROUP_ID);
			await store.enrollDevice("group-other", {
				deviceId: local.deviceId,
				fingerprint: "unused",
				publicKey: loadPublicKey(local.keysDir) ?? "",
			});
		} finally {
			await store.close();
		}
		const app = createBetterSqliteCoordinatorApp({ dbPath: coordinatorDbPath });
		const urls: string[] = [];
		vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
			urls.push(String(input));
			return app.request(String(input), init);
		});

		const result = check("https://coordinator.example.test", ["group-other", GROUP_ID]);

		await expect(result).rejects.toThrow();
		expect(urls).toHaveLength(1);
		expect(new URL(urls[0] as string).searchParams.get("group_id")).toBe(GROUP_ID);
	});

	it("fails for a device it cannot ask about by key", async () => {
		const fetched = vi.fn();
		vi.stubGlobal("fetch", fetched);

		const result = check(
			"https://coordinator.example.test",
			[GROUP_ID],
			[{ device_id: "device-peer", public_key: "" }],
		);

		await expect(result).rejects.toThrow("peer_block_check_unaskable");
		expect(fetched).not.toHaveBeenCalled();
	});
});

describe("the Team recovery reads against a coordinator", () => {
	const local = useLocalDevice();

	it("reads every part from a coordinator through its own routes, as an admin device of the group", async () => {
		// Arrange: a coordinator with this device and one other enrolled in the group.
		const coordinatorDbPath = join(local.root, "coordinator.sqlite");
		const store = new BetterSqliteCoordinatorStore(coordinatorDbPath);
		const self = { deviceId: local.deviceId, publicKey: loadPublicKey(local.keysDir) ?? "" };
		try {
			await store.createGroup(GROUP_ID);
			await store.enrollDevice(GROUP_ID, { ...self, fingerprint: "fingerprint-local" });
			await store.enrollDevice(GROUP_ID, {
				deviceId: peer.device_id,
				fingerprint: "fingerprint-peer",
				publicKey: peer.public_key,
			});
		} finally {
			await store.close();
		}
		const app = createBetterSqliteCoordinatorApp({
			dbPath: coordinatorDbPath,
			runtime: { adminSecret: () => "synthetic-admin", now: () => new Date().toISOString() },
		});
		vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
			app.request(String(input), init),
		);
		const url = "https://coordinator.example.test";
		const config = {
			...readCoordinatorSyncConfig({
				sync_coordinator_url: url,
				sync_coordinator_groups: [GROUP_ID],
			}),
			syncCoordinatorAdminSecret: "synthetic-admin",
		};
		const actions = coordinatorTeamRecoveryEvidenceActions(
			{ db: local.db, dbPath: ":memory:" },
			config,
			{
				localDeviceId: local.deviceId,
				keysDir: local.keysDir,
			},
		);
		const target = {
			coordinatorId: url,
			groupId: GROUP_ID,
			teamId: "team-engineering",
			candidateRef: legacyTeamCandidateId(url, GROUP_ID),
		};

		const { evidence } = await readTeamRecoveryEvidence(target, actions);

		const statuses = Object.fromEntries(
			Object.entries(evidence).map(([name, read]) => [name, read.status]),
		);
		expect(statuses).toEqual({
			roster: "read",
			deviceBlocks: "read",
			deviceRemovals: "read",
			completion: "read",
			memberRemovals: "read",
			groupBinding: "read",
		});
		expect(evidence).toMatchObject({
			roster: { devices: [{ deviceId: local.deviceId }, { deviceId: peer.device_id }] },
			deviceBlocks: {
				checks: [
					{ ...self, blocked: false },
					{ deviceId: peer.device_id, publicKey: peer.public_key, blocked: false },
				],
			},
			deviceRemovals: { removals: [] },
			completion: { manifest: null },
			memberRemovals: { removals: [] },
			groupBinding: { binding: { team_id: "team-engineering", state: "unbound" } },
		});
	});
});

describe("the setup a Team recovery asks about", () => {
	it("is the one that completed the Team, and none for a Team no setup here completed", async () => {
		const db = new Database(":memory:");
		try {
			const manifest = await quarantinedTeam(db);

			expect(teamRecoveryTarget(db, manifest.team_id)).toEqual({
				...RECOVERY_TARGET,
				teamId: manifest.team_id,
				candidateRef: CANDIDATE,
			});
			expect(teamRecoveryTarget(db, "team-unknown")).toBeNull();
		} finally {
			db.close();
		}
	});
});
