import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { fetchDeviceBlocksAndRemovalsForGroup } from "./coordinator-peer-revocation.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
import { planTeamRecoveryDevices } from "./team-recovery-devices.js";
import {
	coordinatorTeamRecoveryEvidenceActions,
	readTeamRecoveryEvidence,
	type TeamRecoveryEvidenceActions,
	teamRecoveryTarget,
} from "./team-recovery-evidence-reader.js";
import { TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS } from "./team-recovery-holds.js";
import {
	CANDIDATE,
	DESKTOP,
	LAPTOP,
	PHONE,
	quarantinedTeam,
	TARGET as RECOVERY_TARGET,
	TABLET,
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
		coordinatorUrl: TARGET.coordinatorId,
		listDevices: async (groupId) => {
			asked.push(["devices", groupId]);
			return [enrolled("device-a"), enrolled("device-b", 0)];
		},
		listDeviceRemovals: async () => [
			{ group_id: "group-other", device_id: "device-z", fingerprint: "fingerprint-z" },
		],
		deviceBlocksAndRemovals: async (groupId, peers) => {
			asked.push(["blocks", groupId, peers]);
			// A reply can name anything. Only the devices that were asked about count.
			return {
				blocked: ["device-b", "device-never-asked"],
				keyRemoved: ["device-never-asked"],
				removedUnattributed: ["device-never-asked"],
			};
		},
		getCompletion: async (groupId, candidateRef) => ({ groupId, candidateRef }),
		listMemberRemovals: async () => [],
		readGroupBinding: async (teamId) => ({ team_id: teamId, state: "unbound" }),
		...overrides,
	};
	return { actions, asked };
}

const failing = () => Promise.reject(new Error("coordinator_unavailable"));
const NOTHING_REPORTED = { blocked: [], keyRemoved: [], removedUnattributed: [] };

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
				{ deviceId: "device-a", publicKey: "key-of-device-a", blocked: false, removal: "none" },
				{ deviceId: "device-b", publicKey: "key-of-device-b", blocked: true, removal: "none" },
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
		["deviceBlocksAndRemovals", "deviceBlocks"],
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
			coordinatorUrl: TARGET.coordinatorId,
			listDevices: (_groupId, deadlineMs) => seen(deadlineMs, [enrolled("device-a")]),
			listDeviceRemovals: (deadlineMs) => seen(deadlineMs, []),
			deviceBlocksAndRemovals: (_groupId, _peers, deadlineMs) => seen(deadlineMs, NOTHING_REPORTED),
			getCompletion: (_groupId, _candidateRef, deadlineMs) => seen(deadlineMs, null),
			listMemberRemovals: (_groupId, deadlineMs) => seen(deadlineMs, []),
			readGroupBinding: (teamId, deadlineMs) =>
				seen(deadlineMs, { team_id: teamId, state: "unbound" as const }),
		};

		await readTeamRecoveryEvidence(TARGET, actions, () => 1_000);

		// Seven reads: the roster is read before the block check and again after it.
		expect(deadlines).toEqual(new Array(7).fill(1_000 + TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS));
	});

	it("carries what the block check says about a removal into each answer", async () => {
		const { actions } = coordinator({
			listDevices: async () => ["device-a", "device-b", "device-c"].map((id) => enrolled(id)),
			deviceBlocksAndRemovals: async () => ({
				blocked: [],
				keyRemoved: ["device-a"],
				removedUnattributed: ["device-b"],
			}),
		});

		const { evidence } = await readTeamRecoveryEvidence(TARGET, actions);

		expect(evidence.deviceBlocks).toMatchObject({
			checks: [
				{ deviceId: "device-a", removal: "of_this_key" },
				{ deviceId: "device-b", removal: "unattributed" },
				{ deviceId: "device-c", removal: "none" },
			],
		});
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

describe("the roster and the coordinator a Team recovery reads", () => {
	it("decides on the roster as it is after the block check, not the one the check was asked with", async () => {
		// Arrange: device-b leaves the group, and device-c joins it, while the block check is out.
		let rosterReads = 0;
		const { actions } = coordinator({
			listDevices: async () => {
				rosterReads += 1;
				return rosterReads === 1
					? [enrolled("device-a"), enrolled("device-b")]
					: [enrolled("device-a"), enrolled("device-c")];
			},
			deviceBlocksAndRemovals: async () => NOTHING_REPORTED,
		});

		const { evidence } = await readTeamRecoveryEvidence(TARGET, actions);

		// Assert: device-b is off the roster, and device-c is on it with no check that clears it.
		expect(evidence.roster).toMatchObject({
			devices: [{ deviceId: "device-a" }, { deviceId: "device-c" }],
		});
		expect(evidence.deviceBlocks).toMatchObject({
			checks: [{ deviceId: "device-a" }, { deviceId: "device-b" }],
		});
	});

	it("reads neither the roster nor the block checks when the roster cannot be read again after the check", async () => {
		let rosterReads = 0;
		const { actions } = coordinator({
			listDevices: async () => {
				rosterReads += 1;
				if (rosterReads > 1) throw new Error("coordinator_unavailable");
				return [enrolled("device-a")];
			},
		});

		const { evidence } = await readTeamRecoveryEvidence(TARGET, actions);

		expect(evidence.roster).toEqual({ status: "unavailable" });
		expect(evidence.deviceBlocks).toEqual({ status: "unavailable" });
	});

	it.each([
		["another coordinator", "https://elsewhere.example.invalid"],
		["something that is not a coordinator URL", "not a url"],
	])("reads nothing when the reads would go to %s", async (_case, coordinatorUrl) => {
		const { actions, asked } = coordinator({ coordinatorUrl });
		const unavailable = { status: "unavailable" };

		const { evidence } = await readTeamRecoveryEvidence(TARGET, actions);

		expect(evidence).toEqual({
			roster: unavailable,
			deviceRemovals: unavailable,
			deviceBlocks: unavailable,
			completion: unavailable,
			memberRemovals: unavailable,
			groupBinding: unavailable,
		});
		expect(asked).toEqual([]);
	});

	it("reads from a coordinator whose configured URL is another spelling of the setup's", async () => {
		const { actions } = coordinator({ coordinatorUrl: "HTTPS://COORDINATOR.EXAMPLE.INVALID/" });

		const { evidence } = await readTeamRecoveryEvidence(TARGET, actions);

		expect(evidence.roster).toMatchObject({ status: "read", source: GROUP });
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

const NOTHING_BLOCKED = {
	version: 1,
	revoked: [],
	removed: [],
	enrolled: [peer.device_id],
	removal_seq: 0,
};

/** The block check as this device sends it, and coordinators that answer it with a fixed body. */
function useBlockCheck() {
	const local = useLocalDevice();
	const serve = useHttpServers();
	const check = (url: string, groups: string[], peers = [peer]) =>
		fetchDeviceBlocksAndRemovalsForGroup(
			{ db: local.db, dbPath: ":memory:" },
			readCoordinatorSyncConfig({ sync_coordinator_url: url, sync_coordinator_groups: groups }),
			{ localDeviceId: local.deviceId, keysDir: local.keysDir, groupId: GROUP_ID },
			peers,
		);
	const answering = (body: unknown) =>
		serve((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		});
	return { local, serve, check, answering };
}

describe("what the block check reports about a removal", () => {
	const { check, answering } = useBlockCheck();

	it.each([
		[
			"the key it sent removed, as removed under that key",
			{ enrolled: [], key_evidence: { removed: [peer.device_id], enrolled: [] } },
			{ keyRemoved: [peer.device_id] },
		],
		[
			"a removal under another key and the key it sent still enrolled, as no removal",
			{ key_evidence: { removed: [], enrolled: [peer.device_id] } },
			{},
		],
		[
			"a removal and no key evidence, as a removal of an unknown key",
			{},
			{ removedUnattributed: [peer.device_id] },
		],
		[
			"a removal and key evidence that says nothing about the device, as a removal of an unknown key",
			{ key_evidence: { removed: [], enrolled: [] } },
			{ removedUnattributed: [peer.device_id] },
		],
	])(
		"reads a reply that lists the device as removed and reports %s",
		async (_case, reply, reported) => {
			// Arrange: the list every coordinator sends matches a removal by device ID or by key.
			const url = await answering({ ...NOTHING_BLOCKED, removed: [peer.device_id], ...reply });

			await expect(check(url, [GROUP_ID])).resolves.toEqual({ ...NOTHING_REPORTED, ...reported });
		},
	);
});

describe("the block check a Team recovery sends", () => {
	const { local, serve, check, answering } = useBlockCheck();

	it("refuses an answer that arrives through a redirect", async () => {
		// Arrange: another server would answer that nothing is blocked.
		const elsewhere = await answering(NOTHING_BLOCKED);
		const coordinatorUrl = await serve((request, response) => {
			response.writeHead(307, { location: `${elsewhere}${request.url}` });
			response.end();
		});

		await expect(check(coordinatorUrl, [GROUP_ID])).rejects.toThrow();
		// The same answer given directly is accepted, so the redirect is what was refused.
		await expect(check(elsewhere, [GROUP_ID])).resolves.toEqual(NOTHING_REPORTED);
	});

	it.each([
		["an entry that is not a device ID", { revoked: [42] }],
		["a device that was never asked about", { revoked: ["device-other"] }],
		["a device listed twice", { enrolled: [peer.device_id, peer.device_id] }],
		["a device both removed and blocked", { revoked: [peer.device_id], removed: [peer.device_id] }],
		["nothing about a device that was asked about", { enrolled: [] }],
		["key evidence that is not two lists", { key_evidence: { removed: [] } }],
		[
			"key evidence about a device that was never asked about",
			{ key_evidence: { removed: ["device-other"], enrolled: [] } },
		],
		[
			"one key both removed and still enrolled",
			{ key_evidence: { removed: [peer.device_id], enrolled: [peer.device_id] } },
		],
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

		const late = fetchDeviceBlocksAndRemovalsForGroup(
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

type OnCoordinator = (store: BetterSqliteCoordinatorStore) => Promise<unknown>;

/** Enrolls the one other device most tests ask about. */
const enrollPeer: OnCoordinator = (store) =>
	store.enrollDevice(GROUP_ID, {
		deviceId: peer.device_id,
		fingerprint: "fingerprint-peer",
		publicKey: peer.public_key,
	});

/**
 * A coordinator with this device enrolled in the group, and whatever `enroll`
 * adds, reached through its own routes. `beforeBlockCheck` runs on the
 * coordinator's store once the roster has been read, just before the block
 * check is answered.
 */
async function enrolledCoordinator(
	local: ReturnType<typeof useLocalDevice>,
	{
		enroll = enrollPeer,
		beforeBlockCheck,
	}: { enroll?: OnCoordinator; beforeBlockCheck?: OnCoordinator } = {},
) {
	const coordinatorDbPath = join(local.root, "coordinator.sqlite");
	const onStore = async (act: OnCoordinator) => {
		const store = new BetterSqliteCoordinatorStore(coordinatorDbPath);
		await act(store).finally(() => store.close());
	};
	const self = { deviceId: local.deviceId, publicKey: loadPublicKey(local.keysDir) ?? "" };
	await onStore(async (store) => {
		await store.createGroup(GROUP_ID);
		await store.enrollDevice(GROUP_ID, { ...self, fingerprint: "fingerprint-local" });
		await enroll(store);
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
		// A request sent just before the deadline can reach this server just after it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		const pagesAtDeadline = pages;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(pages).toBe(pagesAtDeadline);
	}, 5_000);

	it("reports a device removed between the first roster read and the block check as removed under the key it sent, and off the roster", async () => {
		const { read } = await enrolledCoordinator(local, {
			beforeBlockCheck: (store) =>
				store
					.removeEnrollment({ groupId: GROUP_ID, deviceId: peer.device_id })
					.catch(() => undefined),
		});

		const { evidence } = await read();

		// Assert: the check was asked about the device, and the roster read after it no longer lists it.
		expect(evidence).toMatchObject({
			roster: { devices: [{ deviceId: local.deviceId }] },
			deviceBlocks: {
				status: "read",
				checks: inAnyOrder(
					{ deviceId: local.deviceId, blocked: false, removal: "none" },
					{ deviceId: peer.device_id, blocked: false, removal: "of_this_key" },
				),
			},
		});
	});

	it("reads a device off the roster when it left the group before the block check, although the check reports no removal while its key stays enrolled in another group", async () => {
		// Arrange: the device holds one key in two groups, and leaves this group once the roster is read.
		const other = "group-other";
		const { read } = await enrolledCoordinator(local, {
			enroll: async (store) => {
				await enrollPeer(store);
				await store.createGroup(other);
				await store.enrollDevice(other, {
					deviceId: peer.device_id,
					fingerprint: "fingerprint-peer",
					publicKey: peer.public_key,
				});
			},
			beforeBlockCheck: (store) =>
				store
					.removeEnrollment({ groupId: GROUP_ID, deviceId: peer.device_id })
					.catch(() => undefined),
		});

		const { evidence } = await read();

		// Assert: the check alone would clear the device. The roster read after it does not list it.
		expect(evidence).toMatchObject({
			roster: { devices: [{ deviceId: local.deviceId }] },
			deviceBlocks: {
				checks: inAnyOrder(
					{ deviceId: local.deviceId, removal: "none" },
					{ deviceId: peer.device_id, blocked: false, removal: "none" },
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
					{ ...self, blocked: false, removal: "none" },
					{ deviceId: peer.device_id, publicKey: peer.public_key, blocked: false, removal: "none" },
				),
			},
			deviceRemovals: { removals: [] },
			completion: { manifest: null },
			memberRemovals: { removals: [] },
			groupBinding: { binding: { team_id: "team-engineering", state: "unbound" } },
		});
	});
});

describe("a Team recovery on what a coordinator reports about a device's keys", () => {
	const local = useLocalDevice();
	let db: InstanceType<typeof Database>;
	beforeEach(() => {
		db = new Database(":memory:");
	});
	afterEach(() => db.close());

	const enrollment = ({ deviceId, fingerprint, publicKey }: typeof DESKTOP) => ({
		deviceId,
		fingerprint,
		publicKey,
	});
	const remove = (store: BetterSqliteCoordinatorStore, deviceId: string) =>
		store.removeEnrollment({ groupId: GROUP_ID, deviceId });

	/**
	 * Plans the devices of a quarantined Team on evidence read from a coordinator
	 * that removed the Laptop and enrolls the Tablet. `desktop` enrolls the Desktop.
	 */
	async function planOnCoordinatorEvidence(
		desktop: OnCoordinator,
		beforeBlockCheck?: OnCoordinator,
	) {
		const manifest = await quarantinedTeam(db);
		const { read } = await enrolledCoordinator(local, {
			enroll: async (store) => {
				await store.enrollDevice(GROUP_ID, enrollment(LAPTOP));
				await remove(store, LAPTOP.deviceId);
				await desktop(store);
				await store.enrollDevice(GROUP_ID, enrollment(TABLET));
			},
			beforeBlockCheck,
		});
		const { roster, deviceRemovals, deviceBlocks } = (await read()).evidence;
		if (roster.status !== "read" || deviceRemovals.status !== "read") throw new Error("unread");
		if (deviceBlocks.status !== "read") throw new Error("block check unread");
		return planTeamRecoveryDevices(db, {
			teamId: manifest.team_id,
			groupId: GROUP_ID,
			manifest,
			roster: new Map(roster.devices.map((device) => [device.deviceId, device])),
			deviceRemovals: deviceRemovals.removals,
			deviceBlocks: deviceBlocks.checks,
			memberships: db
				.prepare("SELECT identity_id AS identityId, status FROM policy_team_memberships")
				.all() as Array<{ identityId: string; status: string }>,
		});
	}

	it("keeps a device that has a removal on record under another key and is enrolled under the reviewed one", async () => {
		// Arrange: the Desktop's ID was removed from another group, where it held an older key.
		const earlier = "group-earlier";
		const result = await planOnCoordinatorEvidence(async (store) => {
			await store.createGroup(earlier);
			await store.enrollDevice(earlier, { ...enrollment(PHONE), deviceId: DESKTOP.deviceId });
			await store.enrollDevice(GROUP_ID, enrollment(DESKTOP));
			await store.removeEnrollment({ groupId: earlier, deviceId: DESKTOP.deviceId });
		});

		expect(result).toMatchObject({
			state: "planned",
			devices: expect.arrayContaining([
				expect.objectContaining({ deviceId: "device-b", outcome: "regains_access" }),
			]),
		});
	});

	it("does not give access back to a device whose reviewed key is removed between the first roster read and the block check", async () => {
		const result = await planOnCoordinatorEvidence(
			(store) => store.enrollDevice(GROUP_ID, enrollment(DESKTOP)),
			(store) => remove(store, DESKTOP.deviceId).catch(() => undefined),
		);

		// Assert: the Desktop is off the roster. The removal list was read before the removal, so recovery stops.
		expect(result).toEqual({
			state: "refused",
			reason: "device_missing_without_removal",
			deviceIds: ["device-b"],
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
