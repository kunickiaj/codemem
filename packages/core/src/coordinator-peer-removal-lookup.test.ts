import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PeerRemovalLookupEntry, queryPeerRemoval } from "./coordinator-peer-revocation.js";
import { readCoordinatorRemovalState } from "./coordinator-removal-notice.js";
import {
	registerCoordinatorPresence,
	removeCoordinatorRevokedPeers,
} from "./coordinator-runtime.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { removePairingState } from "./pairing-removal.js";
import { readAppliedRemovalSeq } from "./peer-removal-check-state.js";
import { listRetiredDeviceAliases } from "./retired-device-aliases.js";
import { saveSyncChannelCompletedBoundary } from "./sync-channel-progress.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const COORDINATOR = "https://coordinator.example.test";
const NOW = "2026-11-18T00:00:00.000Z";
const GROUPS = ["group-a", "group-b"];
const config = readCoordinatorSyncConfig({
	sync_coordinator_url: COORDINATOR,
	sync_coordinator_groups: GROUPS,
});

type Reply = {
	revoked?: string[];
	removed?: string[];
	enrolled?: string[];
	removal_seq?: unknown;
	key_evidence?: unknown;
};
type LookupCall = { groupId: string; entries: PeerRemovalLookupEntry[]; index: number };

let root: string;
let keysDir: string;
let db: InstanceType<typeof Database>;
let localDeviceId: string;
let lookups: LookupCall[];
let presence: Array<Record<string, unknown>>;

const valid = (reply: Reply = {}) =>
	Response.json({ version: 1, revoked: [], removed: [], enrolled: [], removal_seq: 42, ...reply });
const refused = (error: string, status = 403) => Response.json({ error }, { status });

/** Routes signed coordinator requests to `answer`, and records what this device sent. */
function stubCoordinator(answer: (call: LookupCall) => Response) {
	vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		if (url.pathname === "/v1/presence") {
			presence.push(body.capabilities as Record<string, unknown>);
			return Response.json({ ok: true });
		}
		const call = {
			groupId: url.searchParams.get("group_id") ?? "",
			entries: body.peers as PeerRemovalLookupEntry[],
			index: lookups.length,
		};
		lookups.push(call);
		return answer(call);
	});
}

function pair(deviceId: string, publicKey = `key-${deviceId}`) {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
		 VALUES (?, ?, ?, ?)`,
	).run(deviceId, fingerprintPublicKey(publicKey), publicKey, NOW);
	db.prepare(
		`INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, updated_at)
		 VALUES (?, 'scope-a', 'c1', ?)`,
	).run(deviceId, NOW);
}

function bind(deviceId: string) {
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, 'identity-a', 'Laptop', 'active', 'test', '1', 'user_managed', ?, ?, ?)`,
	).run(deviceId, `binding:${deviceId}`, NOW, NOW);
}

const refresh = () =>
	removeCoordinatorRevokedPeers({ db, dbPath: ":memory:" }, config, { keysDir });
const pairedIds = () =>
	db.prepare("SELECT peer_device_id FROM sync_peers ORDER BY peer_device_id").pluck().all();
const bindingStatus = (deviceId: string) =>
	db.prepare("SELECT status FROM identity_devices WHERE device_id = ?").pluck().get(deviceId);
const cursorCount = (deviceId: string) =>
	db
		.prepare("SELECT COUNT(*) FROM replication_cursors_v2 WHERE peer_device_id = ?")
		.pluck()
		.get(deviceId);
const removalState = () =>
	readCoordinatorRemovalState(db, { coordinatorId: COORDINATOR, groupIds: GROUPS });

async function advertisedCapabilities() {
	await registerCoordinatorPresence({ db, dbPath: ":memory:" }, config, { keysDir });
	return presence.at(-1);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codemem-peer-removal-lookup-"));
	keysDir = join(root, "keys");
	db = new Database(":memory:");
	initTestSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	[localDeviceId] = ensureDeviceIdentity(db, { keysDir });
	lookups = [];
	presence = [];
	pair("peer-a");
	pair("peer-b");
	bind("peer-a");
});

afterEach(() => {
	vi.unstubAllGlobals();
	db.close();
	rmSync(root, { recursive: true, force: true });
});

describe("coordinator removal lookup after Unpair", () => {
	it("still sends the key of an unpaired device, so a key-only revocation filed under another ID is found", async () => {
		removePairingState(db, {
			localDeviceId,
			reason: "disconnect",
			deviceIds: ["peer-a"],
		});
		stubCoordinator(() => valid({ revoked: ["peer-a"] }));

		const result = await refresh();

		expect(lookups[0]?.entries).toEqual([
			{ device_id: "peer-b", public_key: "key-peer-b" },
			{ device_id: "peer-a", public_key: "key-peer-a" },
		]);
		expect(result.status).toBe("checked");
		expect(bindingStatus("peer-a")).toBe("removed");
		expect(listRetiredDeviceAliases(db).get("peer-a")).toMatchObject({ kind: "key" });
	});

	it("stops asking about the unpaired device once the coordinator reports it removed", async () => {
		removePairingState(db, { localDeviceId, reason: "disconnect", deviceIds: ["peer-a"] });
		stubCoordinator(() => valid({ removed: ["peer-a"] }));
		await refresh();
		lookups.length = 0;
		stubCoordinator(() => valid());

		await refresh();

		expect(lookups[0]?.entries.map((entry) => entry.device_id)).toEqual(["peer-b"]);
	});
});

describe("coordinator removal lookup", () => {
	it.each(["removed", "revoked"] as const)(
		"H8: sends a bound device that has no pairing without a key, and ends its binding when the reply says %s",
		async (list) => {
			bind("bound-only");
			bind(localDeviceId);
			stubCoordinator(() => valid({ [list]: ["bound-only"] }));

			await refresh();

			expect(lookups[0]?.entries).toEqual([
				{ device_id: "peer-a", public_key: "key-peer-a" },
				{ device_id: "peer-b", public_key: "key-peer-b" },
				{ device_id: "bound-only" },
			]);
			expect(bindingStatus("bound-only")).toBe("removed");
			expect(bindingStatus("peer-a")).toBe("active");
			expect(bindingStatus(localDeviceId)).toBe("active");
		},
	);

	it("deletes the pairing, its sync progress, and its binding for a removed device, and records no retired alias", async () => {
		stubCoordinator(() => valid({ removed: ["peer-a"], enrolled: ["peer-b"] }));

		const result = await refresh();

		expect(result).toEqual({ revoked: 0, removed: 1, enrolled: ["peer-b"], status: "checked" });
		expect(pairedIds()).toEqual(["peer-b"]);
		expect(cursorCount("peer-a")).toBe(0);
		expect(bindingStatus("peer-a")).toBe("removed");
		expect(listRetiredDeviceAliases(db).size).toBe(0);
	});

	it("treats an ID listed as both revoked and removed as revoked", async () => {
		stubCoordinator(() => valid({ revoked: ["peer-a"], removed: ["peer-a"] }));

		const result = await refresh();

		expect(result).toMatchObject({ revoked: 1, removed: 0 });
		expect(listRetiredDeviceAliases(db).get("peer-a")?.kind).toBe("key");
	});

	it.each([
		["no removed array", { removed: undefined }],
		["no enrolled array", { enrolled: undefined }],
		["no revoked array", { revoked: undefined }],
		["no removal_seq", { removal_seq: undefined }],
		["a negative removal_seq", { removal_seq: -1 }],
		["a removal_seq that is not an integer", { removal_seq: "42" }],
	])("H9: a reply with %s is invalid and keeps every pairing", async (_case, reply) => {
		stubCoordinator(() => valid({ revoked: ["peer-a"], ...reply }));

		const result = await refresh();

		expect(result.status).toBe("failed");
		expect(pairedIds()).toEqual(["peer-a", "peer-b"]);
		expect(bindingStatus("peer-a")).toBe("active");
		expect(readAppliedRemovalSeq(db)).toBe(0);
	});

	it("H10: ignores IDs the client did not send", async () => {
		stubCoordinator(() => valid({ revoked: [localDeviceId], removed: ["someone-else"] }));

		const result = await refresh();

		expect(result).toMatchObject({ revoked: 0, removed: 0, status: "checked" });
		expect(pairedIds()).toEqual(["peer-a", "peer-b"]);
	});

	it("H11, H17: presence carries applied_removal_seq and peer_removal_check after a complete lookup, and 0 once a pairing is added", async () => {
		stubCoordinator(() => valid({ removal_seq: 42 }));
		expect(await advertisedCapabilities()).toMatchObject({ applied_removal_seq: 0 });

		await refresh();

		expect(await advertisedCapabilities()).toMatchObject({
			applied_removal_seq: 42,
			sync_features: expect.arrayContaining(["peer_removal_check"]),
		});
		pair("peer-new");
		expect(await advertisedCapabilities()).toMatchObject({ applied_removal_seq: 0 });
	});

	it("H15: with 30 pairings, a removal recorded between the two requests is not counted as applied", async () => {
		for (let index = 0; index < 28; index += 1)
			pair(`peer-extra-${String(index).padStart(2, "0")}`);
		stubCoordinator((call) => valid({ removal_seq: call.index === 0 ? 41 : 43 }));

		await refresh();

		expect(lookups.map((call) => call.entries.length)).toEqual([25, 5]);
		expect(readAppliedRemovalSeq(db)).toBe(41);
	});
});

describe("incomplete and stale coordinator lookups", () => {
	it.each([
		[503, "busy", []],
		[503, "device_removed", []],
		[403, "device_removed", ["group-a"]],
	] as const)(
		"H15: later batch %i %s applies no peer changes but preserves confirmed removal",
		async (status, code, removedFromGroups) => {
			for (let index = 0; index < 28; index += 1)
				pair(`peer-extra-${String(index).padStart(2, "0")}`);
			stubCoordinator(() => valid({ removal_seq: 40 }));
			await refresh();
			lookups = [];
			stubCoordinator((call) =>
				call.index === 0
					? valid({ removed: ["peer-a"], revoked: ["peer-b"], removal_seq: 44 })
					: refused(code, status),
			);

			const result = await refresh();

			expect(result).toMatchObject({ status: "failed", revoked: 0, removed: 0 });
			expect(pairedIds()).toEqual(expect.arrayContaining(["peer-a", "peer-b"]));
			expect(bindingStatus("peer-a")).toBe("active");
			expect(readAppliedRemovalSeq(db)).toBe(40);
			expect(removalState()).toEqual({ removed: false, removedFromGroups });
		},
	);

	it("H18: a pairing created while a lookup is running stops that lookup from storing its number", async () => {
		stubCoordinator(() => {
			pair("peer-during-lookup");
			return valid({ removal_seq: 42 });
		});

		await refresh();

		expect(readAppliedRemovalSeq(db)).toBe(0);
	});

	it("H13, H19: a pairing restored from an older peer list is not advertised as applied, and the next lookup drops it again", async () => {
		stubCoordinator(() => valid({ removed: ["peer-a"], removal_seq: 42 }));
		await refresh();
		expect(readAppliedRemovalSeq(db)).toBe(42);

		pair("peer-a");

		expect(readAppliedRemovalSeq(db)).toBe(0);
		await refresh();
		expect(pairedIds()).toEqual(["peer-b"]);
		expect(readAppliedRemovalSeq(db)).toBe(42);
	});

	it("sends one empty request when there is nothing to ask about, so presence can still report the number", async () => {
		db.exec("DELETE FROM sync_peers; DELETE FROM identity_devices");
		stubCoordinator(() => valid({ removal_seq: 9 }));

		await refresh();

		expect(lookups.map((call) => call.entries)).toEqual([[]]);
		expect(readAppliedRemovalSeq(db)).toBe(9);
	});
});

function replacementState() {
	const row = (table: string, idColumn = "peer_device_id") =>
		db.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = 'peer-a'`).all();
	return {
		pairing: row("sync_peers"),
		binding: row("identity_devices", "device_id"),
		cursors: row("replication_cursors"),
		scopedCursors: row("replication_cursors_v2"),
		channel: row("sync_channel_progress"),
	};
}

it.each([
	["removed", "new key"],
	["revoked", "new key"],
	["removed", "new row"],
] as const)(
	"keeps a replacement pairing after a stale %s answer (%s)",
	async (outcome, replacement) => {
		stubCoordinator(() => valid({ removal_seq: 40 }));
		await refresh();
		let current: ReturnType<typeof replacementState> | undefined;
		stubCoordinator(({ entries }) => {
			expect(entries).toContainEqual({ device_id: "peer-a", public_key: "key-peer-a" });
			if (replacement === "new key") {
				db.prepare(
					"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = 'peer-a'",
				).run("replacement-key", fingerprintPublicKey("replacement-key"));
			} else {
				db.exec(`DELETE FROM sync_peers WHERE peer_device_id = 'peer-a';
				DELETE FROM replication_cursors_v2 WHERE peer_device_id = 'peer-a';`);
				pair("peer-a");
			}
			db.prepare(
				"UPDATE replication_cursors_v2 SET last_applied_cursor = 'replacement' WHERE peer_device_id = 'peer-a'",
			).run();
			db.prepare(`INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, updated_at)
			VALUES ('peer-a', 'replacement', ?)`).run(NOW);
			saveSyncChannelCompletedBoundary(db, {
				peerDeviceId: "peer-a",
				scopeId: "scope-a",
				boundary: { generation: 2, snapshot_id: "replacement", baseline_cursor: null },
			});
			current = replacementState();
			return valid({ [outcome]: ["peer-a"], enrolled: ["peer-b"], removal_seq: 44 });
		});

		const result = await refresh();

		expect(current?.pairing).toHaveLength(1);
		expect(replacementState()).toEqual(current);
		expect(result).toEqual({ revoked: 0, removed: 0, enrolled: [], status: "failed" });
		expect(listRetiredDeviceAliases(db).has("peer-a")).toBe(false);
		expect(readAppliedRemovalSeq(db)).toBe(0);
	},
);

describe("coordinator removal lookup entries", () => {
	it("sends a pairing with no stored key by device ID only, and drops it when the reply says removed", async () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, public_key, created_at) VALUES ('peer-keyless', ?, ?)",
		).run("  ", NOW);
		stubCoordinator(() => valid({ removed: ["peer-keyless"] }));

		await refresh();

		expect(lookups[0]?.entries).toContainEqual({ device_id: "peer-keyless" });
		expect(pairedIds()).toEqual(["peer-a", "peer-b"]);
		expect(readAppliedRemovalSeq(db)).toBe(42);
	});

	it("sends a bound device whose pairing has an unsendable key once, by device ID only", async () => {
		pair("peer-long-key", "k".repeat(4097));
		pair("peer-nul-key", "key\0with-nul");
		bind("peer-long-key");
		stubCoordinator(() => valid());

		await refresh();

		expect(lookups[0]?.entries).toEqual([
			{ device_id: "peer-a", public_key: "key-peer-a" },
			{ device_id: "peer-b", public_key: "key-peer-b" },
			{ device_id: "peer-long-key" },
			{ device_id: "peer-nul-key" },
		]);
		expect(readAppliedRemovalSeq(db)).toBe(42);
	});

	it("applies valid entries but stores no number while a pairing's device ID cannot be sent", async () => {
		pair(" padded-device-id");
		stubCoordinator(() => valid({ removed: ["peer-a"] }));

		const result = await refresh();

		expect(lookups[0]?.entries.map((entry) => entry.device_id)).toEqual(["peer-a", "peer-b"]);
		expect(result).toMatchObject({ removed: 1, status: "checked" });
		expect(pairedIds()).toEqual([" padded-device-id", "peer-b"]);
		expect(readAppliedRemovalSeq(db)).toBe(0);
	});

	it("stores no number while an active binding's device ID cannot be sent", async () => {
		bind("bound device\u0000id");
		stubCoordinator(() => valid());

		await refresh();

		expect(readAppliedRemovalSeq(db)).toBe(0);
	});
});

describe("single-device removal query", () => {
	const query = (deviceId = "peer-a", publicKey?: string) =>
		queryPeerRemoval({ db, dbPath: ":memory:" }, config, {
			localDeviceId,
			keysDir,
			deviceId,
			publicKey,
		});
	const localState = () =>
		JSON.stringify(
			[
				"sync_peers",
				"identity_devices",
				"replication_cursors_v2",
				"sync_peer_removal_check_state",
			].map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
		);

	it("returns what the coordinator says about the device and never changes local state", async () => {
		stubCoordinator(() => valid({ removed: ["peer-a"], enrolled: ["peer-a", "other"] }));
		const before = localState();

		const answer = await query("peer-a", "key-peer-a");

		expect(answer).toEqual({ answered: true, enrolled: true, removed: true, revoked: false });
		expect(lookups[0]?.entries).toEqual([{ device_id: "peer-a", public_key: "key-peer-a" }]);
		expect(localState()).toBe(before);
		expect(removalState().removedFromGroups).toEqual([]);
	});

	it("answers that the coordinator lists the device in none of its arrays", async () => {
		stubCoordinator(() => valid());

		expect(await query("unlisted")).toEqual({
			answered: true,
			enrolled: false,
			removed: false,
			revoked: false,
		});
		expect(lookups[0]?.entries).toEqual([{ device_id: "unlisted" }]);
	});

	it.each([
		["predates the check", () => refused("not_found", 404)],
		["fails", () => refused("unavailable", 503)],
		["sends an invalid reply", () => valid({ removal_seq: undefined })],
		["refuses this device in every group", () => refused("device_removed")],
		[
			"cannot be reached",
			() => {
				throw new Error("network down");
			},
		],
	])("gives no answer and changes nothing when the coordinator %s", async (_case, answer) => {
		stubCoordinator(answer);
		const before = localState();

		expect(await query()).toEqual({ answered: false });
		expect(localState()).toBe(before);
		expect(removalState().removedFromGroups).toEqual([]);
	});
});

describe("this device was removed from sharing", () => {
	it("H14: device_removed from every configured group sets the removed state and deletes nothing", async () => {
		stubCoordinator(() => refused("device_removed"));

		const result = await refresh();

		expect(result.status).toBe("failed");
		expect(lookups.map((call) => call.groupId)).toEqual(GROUPS);
		expect(removalState()).toEqual({ removed: true, removedFromGroups: GROUPS });
		expect(pairedIds()).toEqual(["peer-a", "peer-b"]);
		expect(cursorCount("peer-a")).toBe(1);
		expect(bindingStatus("peer-a")).toBe("active");
	});

	it("H14: one group that refuses for another reason leaves this device not removed", async () => {
		stubCoordinator((call) =>
			call.groupId === "group-a" ? refused("device_removed") : refused("unknown_device", 401),
		);

		await refresh();

		expect(removalState()).toEqual({ removed: false, removedFromGroups: ["group-a"] });
	});

	it.each([503, "network failure", 404] as const)(
		"H14: records an earlier signed removal despite a later group failure (%s)",
		async (failure) => {
			stubCoordinator(() => valid({ removal_seq: 40 }));
			await refresh();
			stubCoordinator(({ groupId }) => {
				if (groupId === "group-a") return refused("device_removed");
				if (failure === "network failure") throw new Error("offline fixture");
				return refused("unavailable", failure);
			});

			expect((await refresh()).status).toBe(failure === 404 ? "unsupported" : "failed");
			expect(removalState()).toEqual({ removed: false, removedFromGroups: ["group-a"] });
			expect(readAppliedRemovalSeq(db)).toBe(40);
			expect(pairedIds()).toEqual(["peer-a", "peer-b"]);
			expect(bindingStatus("peer-a")).toBe("active");

			stubCoordinator(({ groupId }) =>
				groupId === "group-b" ? refused("device_removed") : refused("unknown_device", 401),
			);
			await refresh();
			expect(removalState()).toEqual({ removed: true, removedFromGroups: GROUPS });
		},
	);

	it("H14: the next signed request the coordinator accepts clears the removed state", async () => {
		stubCoordinator(() => refused("device_removed"));
		await refresh();
		stubCoordinator((call) => (call.groupId === "group-a" ? refused("device_removed") : valid()));

		await refresh();

		expect(removalState()).toEqual({ removed: false, removedFromGroups: [] });
	});
});

describe("coordinator removal lookup with key evidence", () => {
	it("keeps a device listed as removed and enrolled when the pinned key is still enabled", async () => {
		stubCoordinator(() =>
			valid({
				removed: ["peer-a"],
				enrolled: ["peer-a"],
				key_evidence: { removed: [], enrolled: ["peer-a"] },
			}),
		);

		await refresh();

		expect(pairedIds()).toEqual(["peer-a", "peer-b"]);
		expect(bindingStatus("peer-a")).toBe("active");
		expect(cursorCount("peer-a")).toBe(1);
	});

	it.each([
		["the pinned key is the removed one", { removed: ["peer-a"], enrolled: [] }],
		["the coordinator sends no key evidence", undefined],
		["the key evidence is malformed", { removed: "peer-a" }],
		["the key evidence contradicts itself", { removed: ["peer-a"], enrolled: ["peer-a"] }],
		["the enabled list mixes types", { removed: [], enrolled: ["peer-a", 7] }],
		[
			"the enabled list names a device this machine did not send",
			{ removed: [], enrolled: ["peer-a", "stranger"] },
		],
		["the removed list mixes types", { removed: [null], enrolled: ["peer-a"] }],
	])("removes a device listed as removed and enrolled when %s", async (_label, keyEvidence) => {
		stubCoordinator(() =>
			valid({ removed: ["peer-a"], enrolled: ["peer-a"], key_evidence: keyEvidence }),
		);

		await refresh();

		expect(pairedIds()).toEqual(["peer-b"]);
		expect(bindingStatus("peer-a")).toBe("removed");
	});

	it("ignores key evidence for a device this machine sent without a key", async () => {
		bind("bound-only");
		stubCoordinator(() =>
			valid({
				removed: ["bound-only"],
				enrolled: ["bound-only"],
				key_evidence: { removed: [], enrolled: ["bound-only"] },
			}),
		);

		await refresh();

		expect(bindingStatus("bound-only")).toBe("removed");
	});
});
