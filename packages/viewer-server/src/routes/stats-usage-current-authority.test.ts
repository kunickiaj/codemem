import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { ed25519KeyId } from "../../../core/src/coordinator-ed25519-key-id.js";
import {
	refreshScopeMembershipCache,
	upsertCachedScopeMemberships,
} from "../../../core/src/scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "../../../core/src/scope-membership-cache-test-fixtures.js";
import type { ScopeMembershipSnapshot } from "../../../core/src/scope-membership-snapshot.js";
import {
	ensureDeviceIdentity,
	fingerprintPublicKey,
	generateKeypair,
	loadPublicKey,
	resolveKeyPaths,
} from "../../../core/src/sync-identity.js";
import { insertTestSession } from "../../../core/src/test-utils.js";
import { __usageCacheTestHooks, statsRoutes } from "./stats.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFileSync: vi.fn(() => {
		throw new Error("External subprocess disabled in tests");
	}),
}));

const evidenceTable = "scope_membership_authorization_evidence";
const secret = "foreign-managed-pack-secret";
const fixtures: Array<{ store: MemoryStore; directory: string }> = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	__usageCacheTestHooks.cache.clear();
	for (const { store, directory } of fixtures.splice(0)) {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

function setup() {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(cacheTime));
	const network = vi.fn(() => {
		throw new Error("Network disabled in tests");
	});
	vi.stubGlobal("fetch", network);
	const directory = mkdtempSync(join(tmpdir(), "codemem-usage-authority-"));
	const keysDir = join(directory, "keys");
	const store = new MemoryStore(join(directory, "test.sqlite"), { keysDir });
	fixtures.push({ store, directory });
	return { store, keysDir, directory, network, app: statsRoutes(() => store) };
}

async function seedProof(store: MemoryStore, keysDir: string) {
	ensureDeviceIdentity(store.db, { keysDir, deviceId: store.deviceId });
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing fixture signing key");
	const snapshot = cacheWireSnapshot(cacheScope(), [cacheMember(cacheScope(), store.deviceId)]);
	const item = snapshot.items[0];
	if (!item) throw new Error("Missing fixture enrollment");
	item.enrollment.public_key = publicKey;
	item.enrollment.fingerprint = fingerprintPublicKey(publicKey);
	item.key_id = (await ed25519KeyId(publicKey)) ?? "";
	const result = await refreshScopeMembershipCache(store.db, {
		coordinatorId: "server-a",
		groupIds: ["group-a"],
		now: new Date(cacheTime),
		fetchers: {
			listScopes: async () => ({ version: 1, items: [snapshot.scope] }),
			getScopeSnapshot: async () => snapshot,
		},
	});
	expect(result.status).toBe("refreshed");
}

function seedPack(store: MemoryStore, scopeId: string, options: { private?: boolean } = {}) {
	const sessionId = insertTestSession(store.db);
	const title = scopeId === "scope-a" ? secret : `control-${scopeId}`;
	const id = Number(
		store.db
			.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at,
		 metadata_json, rev, visibility, scope_id, origin_device_id, import_key, actor_id)
		VALUES (?, 'discovery', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, ?, ?, ?, ?, ?)`)
			.run(
				sessionId,
				title,
				title,
				cacheTime,
				cacheTime,
				options.private ? "private" : "shared",
				scopeId,
				options.private ? store.deviceId : "foreign-device",
				options.private ? null : `foreign-import-${scopeId}`,
				store.actorId,
			).lastInsertRowid,
	);
	store.db
		.prepare(`INSERT INTO usage_events
		(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
		VALUES (?, 'pack', 20, 0, 10, ?, ?)`)
		.run(
			sessionId,
			cacheTime,
			JSON.stringify({ pack_item_ids: [id], summary: title, snippets: [title] }),
		);
	return id;
}

function seedControls(store: MemoryStore) {
	store.db
		.prepare(`INSERT INTO replication_scopes
		(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES ('manual-control', 'Manual', 'user', 'manual', 0, 'active', ?, ?)`)
		.run(cacheTime, cacheTime);
	upsertCachedScopeMemberships(store.db, [
		cacheMember(
			cacheScope({ scope_id: "manual-control", authority_type: "manual", membership_epoch: 0 }),
			store.deviceId,
		),
	]);
	return [
		seedPack(store, "local-default"),
		seedPack(store, "local-default", { private: true }),
		seedPack(store, "manual-control"),
	];
}

function rawAuthority(store: MemoryStore) {
	return {
		members: store.db.prepare("SELECT * FROM scope_memberships ORDER BY scope_id, device_id").all(),
		scopes: store.db.prepare("SELECT * FROM replication_scopes ORDER BY scope_id").all(),
		devices: store.db.prepare("SELECT * FROM sync_device").all(),
	};
}

function readOnlyState(store: MemoryStore, keysDir: string) {
	return {
		changes: store.db.prepare("SELECT total_changes() AS changes").get(),
		schema: store.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all(),
		keys: readdirSync(keysDir)
			.sort()
			.map((name) => [name, readFileSync(join(keysDir, name), "utf8")]),
	};
}

type Usage = {
	totals: { count: number };
	recent_packs: Array<{
		metadata_json: { pack_item_ids: number[]; summary: string; snippets: string[] };
	}>;
};

async function usage(app: ReturnType<typeof statsRoutes>): Promise<Usage> {
	const response = await app.request("/api/usage");
	expect(response.status).toBe(200);
	return response.json();
}

function packIds(payload: Usage) {
	return payload.recent_packs
		.flatMap((row) => row.metadata_json.pack_item_ids)
		.sort((a, b) => a - b);
}

type Denial =
	| "wrong-private-key"
	| "missing-private-key"
	| "revoked-proof"
	| "missing-proof"
	| "changed-evidence"
	| "deny-overlay";

function deny(fixture: ReturnType<typeof setup>, reason: Denial) {
	const { store, keysDir, directory } = fixture;
	const [privatePath] = resolveKeyPaths(keysDir);
	if (reason === "missing-private-key") {
		unlinkSync(privatePath);
		return;
	}
	if (reason === "wrong-private-key") {
		const replacement = resolveKeyPaths(join(directory, "replacement"));
		generateKeypair(...replacement);
		writeFileSync(privatePath, readFileSync(replacement[0]), { mode: 0o600 });
		return;
	}
	if (reason === "deny-overlay") {
		store.db
			.prepare(`INSERT INTO recipient_policy_deny_overlays
			(canonical_project_identity, scope_id, device_id, generation, reason_code, created_at, updated_at)
			VALUES ('usage-project', 'scope-a', ?, 1, 'recipient_removed', ?, ?)`)
			.run(store.deviceId, cacheTime, cacheTime);
		return;
	}
	if (reason === "missing-proof") {
		store.db.prepare(`DELETE FROM ${evidenceTable} WHERE scope_id = 'scope-a'`).run();
		return;
	}
	const row = store.db
		.prepare(`SELECT evidence_json FROM ${evidenceTable} WHERE scope_id = 'scope-a'`)
		.get() as { evidence_json: string };
	const proof = JSON.parse(row.evidence_json) as ScopeMembershipSnapshot;
	const item = proof.items[0];
	if (!item) throw new Error("Missing retained proof");
	if (reason === "revoked-proof") item.membership.status = "revoked";
	else item.enrollment.enabled = 0;
	store.db
		.prepare(`UPDATE ${evidenceTable} SET evidence_json = ? WHERE scope_id = 'scope-a'`)
		.run(JSON.stringify(proof));
}

it.each<Denial>([
	"wrong-private-key",
	"missing-private-key",
	"revoked-proof",
	"missing-proof",
	"changed-evidence",
	"deny-overlay",
])(
	"drops cached foreign managed packs before TTL expiry after %s without writes or key repair",
	async (reason) => {
		// Arrange: real V1 proof and foreign import provenance; actor labels do not prove authorship.
		const fixture = setup();
		const { store, keysDir, app, network } = fixture;
		await seedProof(store, keysDir);
		const controls = seedControls(store);
		const managedId = seedPack(store, "scope-a");
		await app.request("/api/stats");
		const warmedAt = Date.now();
		const warm = await usage(app);
		expect(packIds(warm)).toEqual([...controls, managedId].sort((a, b) => a - b));
		expect(
			typeof warm.recent_packs.find((row) => row.metadata_json.summary === secret)?.metadata_json
				.summary,
		).toBe("string");
		expect(warm.recent_packs.some((row) => row.metadata_json.snippets.includes(secret))).toBe(true);
		const aggregate = vi.spyOn(store, "classifiedUsageAggregate");
		const authority = rawAuthority(store);
		deny(fixture, reason);
		const state = readOnlyState(store, keysDir);
		expect(rawAuthority(store)).toEqual(authority);
		expect(store.get(managedId)).toBeNull();
		// Act: immediate request and last millisecond of the original 10-second cache window.
		for (const elapsedMs of [1, 9_999]) {
			vi.setSystemTime(warmedAt + elapsedMs);
			const current = await usage(app);
			// Assert: no stale row, summary, or snippets; unrelated packs remain readable.
			expect(Date.now() - warmedAt).toBe(elapsedMs);
			expect(elapsedMs).toBeLessThan(__usageCacheTestHooks.ttlMs);
			expect(packIds(current)).toEqual(controls.sort((a, b) => a - b));
			expect(current.recent_packs).toHaveLength(3);
			expect(JSON.stringify(current)).not.toContain(secret);
			const hidden = current.recent_packs.find((row) =>
				row.metadata_json.pack_item_ids.includes(managedId),
			);
			expect(typeof hidden).toBe("undefined");
			expect(typeof hidden?.metadata_json.summary).toBe("undefined");
			expect(typeof hidden?.metadata_json.snippets).toBe("undefined");
			expect(aggregate).not.toHaveBeenCalled();
			expect(readOnlyState(store, keysDir)).toEqual(state);
			expect(rawAuthority(store)).toEqual(authority);
		}
		expect(network).not.toHaveBeenCalled();
	},
);

it("reuses the warm payload while current proof and signing key remain authorized", async () => {
	// Arrange
	const { store, keysDir, app, network } = setup();
	await seedProof(store, keysDir);
	const managedId = seedPack(store, "scope-a");
	await app.request("/api/stats");
	const warm = await usage(app);
	const aggregate = vi.spyOn(store, "classifiedUsageAggregate");
	const localId = seedPack(store, "local-default");
	const state = readOnlyState(store, keysDir);
	// Act
	vi.setSystemTime(Date.parse(cacheTime) + 9_999);
	const cached = await usage(app);
	// Assert: unchanged authority keeps the TTL cache, not just the same visible IDs.
	expect(cached.totals).toEqual(warm.totals);
	expect(packIds(cached)).toEqual([managedId, localId]);
	expect(cached.totals.count).toBe(1);
	expect(aggregate).not.toHaveBeenCalled();
	expect(store.get(managedId)).not.toBeNull();
	expect(readOnlyState(store, keysDir)).toEqual(state);
	expect(network).not.toHaveBeenCalled();
});

it("reads local, private, and manual packs without a signing key but excludes unproven managed replicas", async () => {
	// Arrange: controls are intentionally independent of managed signing authority.
	const { store, keysDir, app, network } = setup();
	await seedProof(store, keysDir);
	const controls = seedControls(store);
	const managedId = seedPack(store, "scope-a");
	unlinkSync(resolveKeyPaths(keysDir)[0]);
	await app.request("/api/stats");
	const state = readOnlyState(store, keysDir);
	// Act
	const payload = await usage(app);
	// Assert
	expect(packIds(payload)).toEqual(controls);
	expect(payload.totals.count).toBe(4);
	expect(JSON.stringify(payload)).not.toContain(secret);
	expect(store.get(managedId)).toBeNull();
	for (const id of controls) expect(store.get(id)).not.toBeNull();
	expect(readOnlyState(store, keysDir)).toEqual(state);
	expect(network).not.toHaveBeenCalled();
});
