import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { connectReadOnly, type Database } from "./db.js";
import { createMemoryReadHandle } from "./memory-reads.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { ownershipFilterContext, type StoreHandle, search } from "./search.js";
import { MemoryStore } from "./store.js";
import { type MixedScopeFixture, seedMixedScopeFixture } from "./test-utils.js";
import type { MemoryFilters } from "./types.js";

/**
 * The same questions asked of the store and of a read handle on a second, read-only
 * connection that was given only the store's Identity. Every answer must be equal.
 */

const FILTER_CASES: Array<{ name: string; filters: MemoryFilters | null }> = [
	{ name: "no filter", filters: null },
	{ name: "mine", filters: { ownership_scope: "mine" } },
	{ name: "theirs", filters: { ownership_scope: "theirs" } },
	{ name: "one kind", filters: { kind: "discovery" } },
	{ name: "one project", filters: { project: "mixed-domain-fixture" } },
	{ name: "another project", filters: { project: "claimed-devices" } },
	{ name: "private only", filters: { visibility: "private" } },
	{ name: "mine in one project", filters: { ownership_scope: "mine", project: "claimed-devices" } },
];

const KEY_CASES = [
	{ name: "the device's own key", expectedPublicKey: CANONICAL_PUBLIC_KEY },
	{ name: "another key", expectedPublicKey: "another-runtime-key" },
	{ name: "no key", expectedPublicKey: undefined },
];

interface SeededStore {
	fixture: MixedScopeFixture;
	ids: number[];
	otherActorId: number;
	claimedDeviceId: number;
	inactiveId: number;
}

let dir: string;
let store: MemoryStore;
let readOnly: Database;
let previousConfig: string | undefined;

/** Rows of other people and devices in the default scope, next to the mixed-scope rows. */
async function seed(): Promise<SeededStore> {
	const fixture = seedMixedScopeFixture(store.db, store.deviceId);
	await refreshTestScopeRows(store.db, { [store.deviceId]: CANONICAL_PUBLIC_KEY });
	const now = "2026-04-02T00:00:00.000Z";
	store.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, 1, ?)",
		)
		.run("peer-claimed", store.actorId, now);
	const session = store.db
		.prepare(
			`INSERT INTO sessions(started_at, cwd, project, user, tool_version, metadata_json)
			 VALUES (?, '/tmp/claimed-devices', 'claimed-devices', 'test-user', 'test', '{}')`,
		)
		.run(now);
	const insert = store.db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, confidence, tags_text, active, created_at,
			updated_at, metadata_json, rev, visibility, scope_id, actor_id, origin_device_id
		 ) VALUES (?, ?, ?, ?, 0.5, '', ?, ?, ?, ?, 1, ?, 'local-default', ?, ?)`,
	);
	let second = 10;
	const memory = (input: {
		title: string;
		kind?: string;
		active?: number;
		visibility?: string;
		actorId: string | null;
		originDeviceId: string | null;
		metadata?: Record<string, unknown>;
	}): number => {
		const at = `2026-04-02T00:00:${second++}.000Z`;
		return Number(
			insert.run(
				session.lastInsertRowid,
				input.kind ?? "discovery",
				input.title,
				`${fixture.query} ${input.title}`,
				input.active ?? 1,
				at,
				at,
				JSON.stringify(input.metadata ?? {}),
				input.visibility ?? "shared",
				input.actorId,
				input.originDeviceId,
			).lastInsertRowid,
		);
	};
	const claimedDeviceId = memory({
		title: "From a claimed device",
		actorId: null,
		originDeviceId: "peer-claimed",
	});
	const otherActorId = memory({
		title: "From another person",
		kind: "decision",
		actorId: "local:other-peer",
		originDeviceId: "other-peer",
	});
	const inactiveId = memory({
		title: "Deactivated",
		active: 0,
		actorId: store.actorId,
		originDeviceId: store.deviceId,
	});
	const others = [
		memory({
			title: "Claimed device, legacy actor",
			actorId: "legacy-sync:peer-claimed",
			originDeviceId: "unknown-origin",
		}),
		memory({
			title: "Claimed device in metadata",
			actorId: null,
			originDeviceId: null,
			metadata: { origin_device_id: "peer-claimed" },
		}),
		memory({
			title: "Own private note",
			kind: "note",
			visibility: "private",
			actorId: store.actorId,
			originDeviceId: store.deviceId,
		}),
		memory({
			title: "Another person's private note",
			kind: "note",
			visibility: "private",
			actorId: "local:other-peer",
			originDeviceId: "other-peer",
		}),
	];
	return {
		fixture,
		ids: [...fixture.allIds, claimedDeviceId, otherActorId, inactiveId, ...others],
		otherActorId,
		claimedDeviceId,
		inactiveId,
	};
}

/** The store and a handle that were both told the device's public key is `expectedPublicKey`. */
function bothPaths(expectedPublicKey: string | undefined): { handle: StoreHandle } {
	vi.spyOn(store, "scopeResolutionDeviceContext").mockReturnValue({ expectedPublicKey });
	const handle = createMemoryReadHandle(readOnly, {
		actorId: store.actorId,
		deviceId: store.deviceId,
		expectedPublicKey,
	});
	return { handle };
}

function rawRows(ids: number[]): Array<Record<string, unknown>> {
	return ids.map(
		(id) =>
			store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as Record<
				string,
				unknown
			>,
	);
}

beforeEach(() => {
	previousConfig = process.env.CODEMEM_CONFIG;
	dir = mkdtempSync(join(tmpdir(), "codemem-memory-reads-"));
	process.env.CODEMEM_CONFIG = join(dir, "config.json");
	const dbPath = join(dir, "mem.sqlite");
	store = new MemoryStore(dbPath, { keysDir: join(dir, "keys") });
	readOnly = connectReadOnly(dbPath);
});

afterEach(async () => {
	vi.restoreAllMocks();
	readOnly.close();
	await store.close();
	if (previousConfig === undefined) delete process.env.CODEMEM_CONFIG;
	else process.env.CODEMEM_CONFIG = previousConfig;
	rmSync(dir, { recursive: true, force: true });
});

describe.each(KEY_CASES)("a read handle told $name", ({ expectedPublicKey }) => {
	it("gets each memory exactly as the store does", async () => {
		const seeded = await seed();
		const { handle } = bothPaths(expectedPublicKey);

		const fromHandle = seeded.ids.map((id) => handle.get(id));
		const fromStore = seeded.ids.map((id) => store.get(id));

		expect(fromHandle).toEqual(fromStore);
		// The comparison is not between two empty answers.
		expect(store.get(seeded.fixture.personalId)?.id).toBe(seeded.fixture.personalId);
		expect(store.get(seeded.inactiveId)?.active).toBe(0);
		expect(store.get(seeded.fixture.unauthorizedId)).toBeNull();
	});

	it.each(FILTER_CASES)("lists recent memories as the store does: $name", async ({ filters }) => {
		await seed();
		const { handle } = bothPaths(expectedPublicKey);

		expect(handle.recent(50, filters)).toEqual(store.recent(50, filters));
		expect(handle.recent(2, filters, 1)).toEqual(store.recent(2, filters, 1));
		expect(handle.recentByKinds(["decision", "note", ""], 50, filters)).toEqual(
			store.recentByKinds(["decision", "note", ""], 50, filters),
		);
		expect(handle.recentByKinds([], 50, filters)).toEqual(store.recentByKinds([], 50, filters));
	});

	it.each(FILTER_CASES)("searches as the store does: $name", async ({ filters }) => {
		const seeded = await seed();
		const { handle } = bothPaths(expectedPublicKey);

		const fromHandle = search(handle, seeded.fixture.query, 50, filters ?? undefined);
		const fromStore = search(store, seeded.fixture.query, 50, filters ?? undefined);

		expect(fromHandle).toEqual(fromStore);
	});

	it("decides ownership as the store does", async () => {
		const seeded = await seed();
		const { handle } = bothPaths(expectedPublicKey);
		const rows = rawRows(seeded.ids);
		const handlePredicate = handle.buildOwnershipPredicate?.();
		const storePredicate = store.buildOwnershipPredicate();

		expect(handle.sameActorPeerIds?.()).toEqual(store.sameActorPeerIds());
		expect(rows.map((row) => handle.memoryOwnedBySelf(row))).toEqual(
			rows.map((row) => store.memoryOwnedBySelf(row)),
		);
		expect(rows.map((row) => handlePredicate?.(row))).toEqual(
			rows.map((row) => storePredicate(row)),
		);
		expect(store.sameActorPeerIds()).toEqual(["peer-claimed"]);
		expect(store.memoryOwnedBySelf(rawRows([seeded.claimedDeviceId])[0] ?? {})).toBe(true);
		expect(store.memoryOwnedBySelf(rawRows([seeded.otherActorId])[0] ?? {})).toBe(false);
	});

	it("resolves the same filter context as the store", async () => {
		await seed();
		const { handle } = bothPaths(expectedPublicKey);
		const decisions = (context: ReturnType<typeof ownershipFilterContext>) => ({
			actorId: context.actorId,
			deviceId: context.deviceId,
			claimedDeviceIds: context.claimedDeviceIds,
			legacyActorIds: context.legacyActorIds,
			enforceScopeVisibility: context.enforceScopeVisibility,
			visibleScopeIds: context.visibleScopeIds,
			expectedPublicKey: context.expectedPublicKey,
		});

		expect(decisions(ownershipFilterContext(handle))).toEqual(
			decisions(store.ownershipFilterContext()),
		);
	});
});

describe("the coordinator scope in the comparison", () => {
	it("is visible only with the device's own key, on both paths", async () => {
		const seeded = await seed();
		const authorizedId = seeded.fixture.authorizedId;

		const withKey = bothPaths(CANONICAL_PUBLIC_KEY).handle.get(authorizedId);
		const storeWithKey = store.get(authorizedId);
		vi.restoreAllMocks();
		const withoutKey = bothPaths(undefined).handle.get(authorizedId);
		const storeWithoutKey = store.get(authorizedId);

		expect(withKey?.id).toBe(authorizedId);
		expect(storeWithKey?.id).toBe(authorizedId);
		expect(withoutKey).toBeNull();
		expect(storeWithoutKey).toBeNull();
	});
});

describe("a read handle", () => {
	it("answers for the Identity it was given, whatever the store's is", async () => {
		const seeded = await seed();
		const other = createMemoryReadHandle(readOnly, {
			actorId: "local:other-peer",
			deviceId: "other-peer",
			expectedPublicKey: undefined,
		});
		const otherRow = rawRows([seeded.otherActorId])[0] ?? {};

		expect(other.memoryOwnedBySelf(otherRow)).toBe(true);
		expect(store.memoryOwnedBySelf(otherRow)).toBe(false);
		const mine = other.recent(50, { ownership_scope: "mine" }).map((item) => item.title);
		expect(mine).toContain("From another person");
		expect(mine).toContain("Another person's private note");
		expect(mine).not.toContain("Own private note");
	});

	it("cannot write through its connection", async () => {
		await seed();
		const handle = createMemoryReadHandle(readOnly, {
			actorId: store.actorId,
			deviceId: store.deviceId,
			expectedPublicKey: undefined,
		});

		expect(() => handle.db.prepare("DELETE FROM memory_items").run()).toThrow(/readonly/u);
	});
});
