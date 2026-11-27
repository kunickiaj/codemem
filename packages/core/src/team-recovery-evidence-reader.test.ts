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
import { TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS } from "./team-recovery-holds.js";
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
			return { blocked: ["device-b", "device-never-asked"], removed: ["device-never-asked"] };
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
				{ deviceId: "device-a", publicKey: "key-of-device-a", blocked: false, removed: false },
				{ deviceId: "device-b", publicKey: "key-of-device-b", blocked: true, removed: false },
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

	it("gives every read the same deadline: the evidence limit after the reading started", async () => {
		const deadlines: number[] = [];
		const seen = <T>(deadlineMs: number, answer: T): Promise<T> => {
			deadlines.push(deadlineMs);
			return Promise.resolve(answer);
		};
		const actions: TeamRecoveryEvidenceActions = {
			listDevices: (_groupId, deadlineMs) => seen(deadlineMs, [enrolled("device-a")]),
			listDeviceRemovals: (deadlineMs) => seen(deadlineMs, []),
			blockedDeviceIds: (_groupId, _peers, deadlineMs) =>
				seen(deadlineMs, { blocked: [], removed: [] }),
			getCompletion: (_groupId, _candidateRef, deadlineMs) => seen(deadlineMs, null),
			listMemberRemovals: (_groupId, deadlineMs) => seen(deadlineMs, []),
			readGroupBinding: (teamId, deadlineMs) =>
				seen(deadlineMs, { team_id: teamId, state: "unbound" as const }),
		};

		await readTeamRecoveryEvidence(TARGET, actions, () => 1_000);

		expect(deadlines).toEqual(new Array(6).fill(1_000 + TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS));
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

/** Starts local HTTP servers for a test and closes them after it. Returns the URL of each. */
function useHttpServers() {
	let servers: Server[] = [];
	afterEach(async () => {
		await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
		servers = [];
	});
	return async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
		const server = createServer(handler);
		servers.push(server);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	};
}

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
	const serve = useHttpServers();

	const check = (url: string, groups: string[], peers = [peer]) =>
		fetchBlockedDeviceIdsForGroup(
			{ db: local.db, dbPath: ":memory:" },
			readCoordinatorSyncConfig({ sync_coordinator_url: url, sync_coordinator_groups: groups }),
			{ localDeviceId: local.deviceId, keysDir: local.keysDir, groupId: GROUP_ID },
			peers,
		);

	/** A coordinator that answers every block check with this body. */
	const answering = (body: unknown) =>
		serve((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		});
	const NOTHING_BLOCKED = {
		version: 1,
		revoked: [],
		removed: [],
		enrolled: [peer.device_id],
		removal_seq: 0,
	};

	it("refuses an answer that arrives through a redirect", async () => {
		// Arrange: another server would answer that nothing is blocked.
		const elsewhere = await answering(NOTHING_BLOCKED);
		const coordinatorUrl = await serve((request, response) => {
			response.writeHead(307, { location: `${elsewhere}${request.url}` });
			response.end();
		});

		await expect(check(coordinatorUrl, [GROUP_ID])).rejects.toThrow();
		// The same answer given directly is accepted, so the redirect is what was refused.
		await expect(check(elsewhere, [GROUP_ID])).resolves.toEqual({ blocked: [], removed: [] });
	});

	it.each([
		["an entry that is not a device ID", { revoked: [42] }],
		["a device that was never asked about", { revoked: ["device-other"] }],
		["a device listed twice", { enrolled: [peer.device_id, peer.device_id] }],
		["a device both removed and blocked", { revoked: [peer.device_id], removed: [peer.device_id] }],
		["nothing about a device that was asked about", { enrolled: [] }],
	])(
		"refuses a reply with %s, where the daemon's lookup would drop the entry",
		async (_case, broken) => {
			const url = await answering({ ...NOTHING_BLOCKED, ...broken });

			await expect(check(url, [GROUP_ID])).rejects.toThrow("peer_revocation_response");
		},
	);

	it("stops asking once its deadline has passed", async () => {
		let requests = 0;
		const url = await serve((_request, response) => {
			requests += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(NOTHING_BLOCKED));
		});
		const config = readCoordinatorSyncConfig({
			sync_coordinator_url: url,
			sync_coordinator_groups: [GROUP_ID],
		});
		const request = { localDeviceId: local.deviceId, keysDir: local.keysDir, groupId: GROUP_ID };

		const late = fetchBlockedDeviceIdsForGroup(
			{ db: local.db, dbPath: ":memory:" },
			config,
			{ ...request, deadlineMs: Date.now() - 1 },
			[peer],
		);

		await expect(late).rejects.toThrow("peer_revocation_deadline_passed");
		expect(requests).toBe(0);
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

/**
 * A coordinator with this device and one other enrolled in the group, reached
 * through its own routes. `beforeBlockCheck` runs on the coordinator's store
 * once the roster has been read, just before the block check is answered.
 */
async function enrolledCoordinator(
	local: ReturnType<typeof useLocalDevice>,
	beforeBlockCheck?: (store: BetterSqliteCoordinatorStore) => Promise<unknown>,
) {
	const coordinatorDbPath = join(local.root, "coordinator.sqlite");
	const onStore = async (act: (store: BetterSqliteCoordinatorStore) => Promise<unknown>) => {
		const store = new BetterSqliteCoordinatorStore(coordinatorDbPath);
		await act(store).finally(() => store.close());
	};
	const self = { deviceId: local.deviceId, publicKey: loadPublicKey(local.keysDir) ?? "" };
	await onStore(async (store) => {
		await store.createGroup(GROUP_ID);
		await store.enrollDevice(GROUP_ID, { ...self, fingerprint: "fingerprint-local" });
		await store.enrollDevice(GROUP_ID, {
			deviceId: peer.device_id,
			fingerprint: "fingerprint-peer",
			publicKey: peer.public_key,
		});
	});
	const app = createBetterSqliteCoordinatorApp({
		dbPath: coordinatorDbPath,
		runtime: { adminSecret: () => "synthetic-admin", now: () => new Date().toISOString() },
	});
	vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
		if (beforeBlockCheck && String(input).includes("/v1/peers/revocations"))
			await onStore(beforeBlockCheck);
		return app.request(String(input), init);
	});
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
		{ localDeviceId: local.deviceId, keysDir: local.keysDir },
	);
	const target = {
		coordinatorId: url,
		groupId: GROUP_ID,
		teamId: "team-engineering",
		candidateRef: legacyTeamCandidateId(url, GROUP_ID),
	};
	return { self, read: () => readTeamRecoveryEvidence(target, actions) };
}

/** Exactly these entries. This device's ID is random, so where it sorts in a list is too. */
const inAnyOrder = (...entries: object[]) => {
	const matching = entries.map((entry) => expect.objectContaining(entry));
	return expect.toSatisfy(
		(list: unknown[]) =>
			list.length === entries.length &&
			matching.every((entry) => list.some((item) => entry.asymmetricMatch(item))),
	);
};

describe("the Team recovery reads against a coordinator", () => {
	const local = useLocalDevice();
	const serve = useHttpServers();

	it("stops reading device removals at the deadline, however many pages the coordinator offers", async () => {
		// Arrange: every page is valid and names another, so the list never ends.
		let pages = 0;
		const url = await serve((request, response) => {
			pages += 1;
			const before = Number(new URL(request.url ?? "", "http://x").searchParams.get("before_seq"));
			const seq = (before || 1_000_000) - 1;
			const item = {
				removal_id: `removal-${seq}`,
				removal_seq: seq,
				group_id: GROUP_ID,
				device_id: `device-${seq}`,
				fingerprint: `fingerprint-${seq}`,
				key_id: null,
				display_name: null,
				identity_id: null,
				removed_at: "2026-09-01T12:00:00.000Z",
			};
			setTimeout(() => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ version: 1, items: [item], next_before_seq: seq }));
			}, 10);
		});
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
			{ localDeviceId: local.deviceId, keysDir: local.keysDir },
		);

		const stalled = actions.listDeviceRemovals(Date.now() + 200);

		await expect(stalled).rejects.toThrow();
		const pagesAtDeadline = pages;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(pages).toBe(pagesAtDeadline);
	}, 5_000);

	it("reports a device removed between the roster read and the block check as removed in its answer", async () => {
		const { read } = await enrolledCoordinator(local, (store) =>
			store.removeEnrollment({ groupId: GROUP_ID, deviceId: peer.device_id }),
		);

		const { evidence } = await read();

		// Assert: the roster was read first and still lists the device. Only the check shows the removal.
		expect(evidence).toMatchObject({
			roster: { devices: inAnyOrder({ deviceId: local.deviceId }, { deviceId: peer.device_id }) },
			deviceBlocks: {
				status: "read",
				checks: inAnyOrder(
					{ deviceId: local.deviceId, blocked: false, removed: false },
					{ deviceId: peer.device_id, blocked: false, removed: true },
				),
			},
		});
	});

	it("reads every part from a coordinator through its own routes, as an admin device of the group", async () => {
		const { self, read } = await enrolledCoordinator(local);

		const { evidence } = await read();

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
			roster: { devices: inAnyOrder({ deviceId: local.deviceId }, { deviceId: peer.device_id }) },
			deviceBlocks: {
				checks: inAnyOrder(
					{ ...self, blocked: false, removed: false },
					{ deviceId: peer.device_id, publicKey: peer.public_key, blocked: false, removed: false },
				),
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
