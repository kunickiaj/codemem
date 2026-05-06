import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	applyReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
	filterReplicationOpsForSyncWithStatus,
	getReplicationCursor,
	initDatabase,
	listInboundScopeRejections,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
	loadReplicationOpsSince,
	MemoryStore,
	setReplicationCursor,
	setSyncResetState,
	toJson,
	type ReplicationOp,
} from "../../packages/core/src/index.ts";
import { getMemoryForMcp, rememberMemoryForMcp } from "../../packages/mcp-server/src/memory-access.ts";
import { buildFilters } from "../../packages/mcp-server/src/project-scope.ts";
import { createApp } from "../../packages/viewer-server/src/index.ts";

const MIXED_DEVICE = "mixed-adam";
const MIXED_ACTOR = "adam";
const PERSONAL_PEER = "personal-peer";
const WORK_PEER = "work-peer";
const OSS_PEER = "oss-peer";
const OSS_EXCLUDED_PEER = "oss-excluded-peer";
const LEGACY_PEER = "legacy-peer";
const MALICIOUS_PEER = "malicious-peer";
const GROUP_ONLY_PEER = "group-only-peer";

const PERSONAL_SCOPE = `personal:${MIXED_ACTOR}`;
const ACME_SCOPE = "acme-work";
const OSS_SCOPE = "oss-codemem";
const LEGACY_SCOPE = "legacy-shared-review";

const QUERY_TOKEN = "smokeboundary";
const NOW = "2026-05-06T18:00:00.000Z";

interface MemoryIds {
	personal: number;
	work: number;
	oss: number;
}

interface MemoryTitles {
	personal: string;
	work: string;
	oss: string;
}

interface SmokeFixture {
	dbPath: string;
	ids: MemoryIds;
	titles: MemoryTitles;
	importKeys: Record<keyof MemoryIds, string>;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function parseArgs(argv: string[]): { dbPath: string } {
	let dbPath = "/data/mixed-adam-sharing-domains.sqlite";
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db-path") {
			const value = argv[index + 1]?.trim();
			assert(value, "--db-path requires a value");
			dbPath = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { dbPath };
}

function jsonList(values: string[] | null): string | null {
	return values ? JSON.stringify(values) : null;
}

function sorted(values: string[]): string[] {
	return [...values].sort((a, b) => a.localeCompare(b));
}

function assertSameSet(actual: string[], expected: string[], label: string): void {
	const left = sorted(actual);
	const right = sorted(expected);
	assert(
		JSON.stringify(left) === JSON.stringify(right),
		`${label}: expected ${JSON.stringify(right)}, got ${JSON.stringify(left)}`,
	);
}

function allExpectedTitles(titles: MemoryTitles): string[] {
	return [titles.personal, titles.work, titles.oss];
}

function prepareViewerStatic(dbPath: string): void {
	const safeName = basename(dbPath).replace(/[^a-zA-Z0-9.-]+/g, "-");
	const staticDir = `${dirname(dbPath)}/viewer-static-${safeName}`;
	mkdirSync(staticDir, { recursive: true });
	writeFileSync(`${staticDir}/index.html`, "<!doctype html><title>codemem e2e</title>");
	process.env.CODEMEM_VIEWER_STATIC_DIR = staticDir;
}

async function withStore<T>(
	dbPath: string,
	deviceId: string,
	fn: (store: MemoryStore) => T | Promise<T>,
): Promise<T> {
	const previousDevice = process.env.CODEMEM_DEVICE_ID;
	const previousActor = process.env.CODEMEM_ACTOR_ID;
	const previousDisplayName = process.env.CODEMEM_ACTOR_DISPLAY_NAME;
	process.env.CODEMEM_DEVICE_ID = deviceId;
	process.env.CODEMEM_ACTOR_ID = MIXED_ACTOR;
	process.env.CODEMEM_ACTOR_DISPLAY_NAME = "Mixed Adam";
	const store = new MemoryStore(dbPath);
	try {
		return await fn(store);
	} finally {
		store.close();
		if (previousDevice === undefined) delete process.env.CODEMEM_DEVICE_ID;
		else process.env.CODEMEM_DEVICE_ID = previousDevice;
		if (previousActor === undefined) delete process.env.CODEMEM_ACTOR_ID;
		else process.env.CODEMEM_ACTOR_ID = previousActor;
		if (previousDisplayName === undefined) delete process.env.CODEMEM_ACTOR_DISPLAY_NAME;
		else process.env.CODEMEM_ACTOR_DISPLAY_NAME = previousDisplayName;
	}
}

function upsertScope(
	store: MemoryStore,
	input: {
		scopeId: string;
		label: string;
		kind: string;
		authorityType: string;
		coordinatorId?: string | null;
		groupId?: string | null;
		epoch?: number;
		status?: string;
	},
): void {
	store.db
		.prepare(
			`INSERT OR REPLACE INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.scopeId,
			input.label,
			input.kind,
			input.authorityType,
			input.coordinatorId ?? null,
			input.groupId ?? null,
			input.epoch ?? 1,
			input.status ?? "active",
			NOW,
			NOW,
		);
}

function grantScope(
	store: MemoryStore,
	scopeId: string,
	deviceIds: string[],
	options: { role?: string; status?: string; epoch?: number; coordinatorId?: string; groupId?: string } = {},
): void {
	for (const deviceId of deviceIds) {
		store.db
			.prepare(
				`INSERT OR REPLACE INTO scope_memberships(
					scope_id, device_id, role, status, membership_epoch,
					coordinator_id, group_id, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				scopeId,
				deviceId,
				options.role ?? "member",
				options.status ?? "active",
				options.epoch ?? 1,
				options.coordinatorId ?? null,
				options.groupId ?? null,
				NOW,
			);
	}
}

function revokeScope(store: MemoryStore, scopeId: string, deviceId: string): void {
	store.db
		.prepare(
			`UPDATE scope_memberships
			 SET status = 'revoked', updated_at = ?
			 WHERE scope_id = ? AND device_id = ?`,
		)
		.run(NOW, scopeId, deviceId);
}

function upsertProjectMapping(store: MemoryStore, projectPattern: string, scopeId: string): void {
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 100, 'e2e', ?, ?)`,
		)
		.run(null, projectPattern, scopeId, NOW, NOW);
}

function upsertPeer(
	store: MemoryStore,
	input: {
		deviceId: string;
		name: string;
		include?: string[] | null;
		exclude?: string[] | null;
		claimedLocalActor?: boolean;
		actorId?: string | null;
		discoveredGroupId?: string | null;
	},
): void {
	const discoveredGroupId =
		input.discoveredGroupId !== undefined
			? input.discoveredGroupId
			: input.deviceId === PERSONAL_PEER
				? null
				: input.deviceId === LEGACY_PEER
					? "legacy"
					: "e2e-group";
	store.db
		.prepare(
			`INSERT OR REPLACE INTO sync_peers(
				peer_device_id, name, pinned_fingerprint, public_key, addresses_json,
				projects_include_json, projects_exclude_json, claimed_local_actor,
				actor_id, created_at, last_seen_at, discovered_via_coordinator_id, discovered_via_group_id
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.deviceId,
			input.name,
			`fingerprint-${input.deviceId}`,
			`public-key-${input.deviceId}`,
			JSON.stringify([`http://${input.deviceId}.invalid:7337`]),
			jsonList(input.include ?? null),
			jsonList(input.exclude ?? null),
			input.claimedLocalActor ? 1 : 0,
			input.actorId ?? null,
			NOW,
			NOW,
			"local-e2e-coordinator",
			discoveredGroupId,
		);
}

function insertActorRows(store: MemoryStore): void {
	for (const [actorId, displayName, isLocal] of [
		[MIXED_ACTOR, "Mixed Adam", 1],
		["legacy", "Legacy peer", 0],
	] as const) {
		store.db
			.prepare(
				`INSERT OR REPLACE INTO actors(
					actor_id, display_name, is_local, status, created_at, updated_at
				 ) VALUES (?, ?, ?, 'active', ?, ?)`,
			)
			.run(actorId, displayName, isLocal, NOW, NOW);
	}
}

function seedTopology(store: MemoryStore): void {
	store.db
		.prepare(
			"INSERT OR REPLACE INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(MIXED_DEVICE, "public-key-mixed", "fingerprint-mixed", NOW);
	insertActorRows(store);

	upsertScope(store, {
		scopeId: PERSONAL_SCOPE,
		label: "Personal",
		kind: "personal",
		authorityType: "user",
	});
	upsertScope(store, {
		scopeId: ACME_SCOPE,
		label: "Acme Work",
		kind: "team",
		authorityType: "coordinator",
		coordinatorId: "local-e2e-coordinator",
		groupId: "acme-eng",
	});
	upsertScope(store, {
		scopeId: OSS_SCOPE,
		label: "OSS codemem",
		kind: "team",
		authorityType: "coordinator",
		coordinatorId: "local-e2e-coordinator",
		groupId: "oss-codemem",
	});
	upsertScope(store, {
		scopeId: LEGACY_SCOPE,
		label: "Legacy shared review",
		kind: "team",
		authorityType: "local",
	});

	grantScope(store, PERSONAL_SCOPE, [MIXED_DEVICE, PERSONAL_PEER]);
	grantScope(store, ACME_SCOPE, [MIXED_DEVICE, WORK_PEER], {
		coordinatorId: "local-e2e-coordinator",
		groupId: "acme-eng",
	});
	grantScope(store, OSS_SCOPE, [MIXED_DEVICE, OSS_PEER], {
		coordinatorId: "local-e2e-coordinator",
		groupId: "oss-codemem",
	});

	upsertProjectMapping(store, "/workspace/personal/*", PERSONAL_SCOPE);
	upsertProjectMapping(store, "/workspace/work/acme/*", ACME_SCOPE);
	upsertProjectMapping(store, "/workspace/oss/codemem", OSS_SCOPE);

	const knownProjects = ["personal/finance", "work/acme-api", "oss/codemem"];
	upsertPeer(store, {
		deviceId: PERSONAL_PEER,
		name: "Personal peer",
		include: null,
		claimedLocalActor: true,
		actorId: MIXED_ACTOR,
	});
	upsertPeer(store, {
		deviceId: WORK_PEER,
		name: "Work peer",
		include: knownProjects,
		actorId: MIXED_ACTOR,
		discoveredGroupId: "acme-eng",
	});
	upsertPeer(store, {
		deviceId: OSS_PEER,
		name: "OSS peer",
		include: ["oss/codemem"],
		discoveredGroupId: "oss-codemem",
	});
	upsertPeer(store, {
		deviceId: OSS_EXCLUDED_PEER,
		name: "OSS excluded peer",
		include: ["oss/codemem"],
		exclude: ["oss/codemem"],
		discoveredGroupId: "oss-codemem",
	});
	upsertPeer(store, {
		deviceId: LEGACY_PEER,
		name: "Legacy peer",
		include: knownProjects,
		claimedLocalActor: true,
		actorId: "legacy",
	});
	upsertPeer(store, {
		deviceId: MALICIOUS_PEER,
		name: "Malicious peer",
		include: knownProjects,
		discoveredGroupId: "acme-eng",
	});
	upsertPeer(store, {
		deviceId: GROUP_ONLY_PEER,
		name: "Coordinator group only peer",
		include: knownProjects,
		discoveredGroupId: "acme-eng",
	});
	grantScope(store, OSS_SCOPE, [OSS_EXCLUDED_PEER], {
		coordinatorId: "local-e2e-coordinator",
		groupId: "oss-codemem",
	});

	for (const scopeId of [PERSONAL_SCOPE, ACME_SCOPE, OSS_SCOPE]) {
		setSyncResetState(
			store.db,
			{
				generation: 1,
				snapshot_id: `snapshot-${scopeId}`,
				baseline_cursor: "2026-05-06T17:59:00.000Z|baseline",
				retained_floor_cursor: "2026-05-06T17:59:00.000Z|baseline",
			},
			scopeId,
		);
	}
}

function createMixedMemories(store: MemoryStore): SmokeFixture {
	const definitions = {
		personal: {
			cwd: "/workspace/personal/finance",
			project: "personal/finance",
			title: `${QUERY_TOKEN} personal finance private`,
			body: `${QUERY_TOKEN} personal finance data must only sync through ${PERSONAL_SCOPE}.`,
			importKey: "e2e-mixed-personal-finance",
			metadata: {
				visibility: "private",
				workspace_id: PERSONAL_SCOPE,
				workspace_kind: "personal",
				actor_id: MIXED_ACTOR,
				actor_display_name: "Mixed Adam",
			},
		},
		work: {
			cwd: "/workspace/work/acme/api",
			project: "work/acme-api",
			title: `${QUERY_TOKEN} acme work shared`,
			body: `${QUERY_TOKEN} work data must stay in ${ACME_SCOPE}.`,
			importKey: "e2e-mixed-acme-work",
			metadata: { visibility: "shared", workspace_id: ACME_SCOPE, workspace_kind: "shared" },
		},
		oss: {
			cwd: "/workspace/oss/codemem",
			project: "oss/codemem",
			title: `${QUERY_TOKEN} oss codemem shared`,
			body: `${QUERY_TOKEN} OSS data must stay in ${OSS_SCOPE}.`,
			importKey: "e2e-mixed-oss-codemem",
			metadata: { visibility: "shared", workspace_id: OSS_SCOPE, workspace_kind: "shared" },
		},
	} as const;

	const ids = {} as MemoryIds;
	const titles = {} as MemoryTitles;
	const importKeys = {} as Record<keyof MemoryIds, string>;
	for (const key of Object.keys(definitions) as Array<keyof typeof definitions>) {
		const def = definitions[key];
		const sessionId = store.startSession({
			cwd: def.cwd,
			project: def.project,
			user: "e2e",
			toolVersion: "sharing-domain-smoke",
		});
		ids[key] = store.remember(sessionId, "discovery", def.title, def.body, 0.95, ["e2e"], {
			...def.metadata,
			import_key: def.importKey,
			files_read: [`${def.cwd}/README.md`],
		});
		titles[key] = def.title;
		importKeys[key] = def.importKey;
		store.endSession(sessionId, { e2e_sharing_domain_smoke: key });
	}
	return { dbPath: store.dbPath, ids, titles, importKeys };
}

function memoryScopes(store: MemoryStore, ids: MemoryIds): Record<keyof MemoryIds, string | null> {
	const result = {} as Record<keyof MemoryIds, string | null>;
	for (const key of Object.keys(ids) as Array<keyof MemoryIds>) {
		const row = store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").get(ids[key]) as
			| { scope_id: string | null }
			| undefined;
		result[key] = row?.scope_id ?? null;
	}
	return result;
}

function opsByImportKey(store: MemoryStore): Map<string, ReplicationOp> {
	const [ops] = loadReplicationOpsSince(store.db, null, 100);
	return new Map(ops.map((op) => [op.entity_id, op]));
}

function assertOutboundSync(store: MemoryStore, fixture: SmokeFixture): void {
	const opsByKey = opsByImportKey(store);
	const personalOp = opsByKey.get(fixture.importKeys.personal);
	const workOp = opsByKey.get(fixture.importKeys.work);
	const ossOp = opsByKey.get(fixture.importKeys.oss);
	assert(personalOp && workOp && ossOp, "expected replication ops for all Mixed Adam memories");
	const allOps = [personalOp, workOp, ossOp];

	const allowedFor = (peerDeviceId: string) =>
		filterReplicationOpsForSyncWithStatus(store.db, allOps, peerDeviceId, {
			localDeviceId: MIXED_DEVICE,
		})[0].map((op) => op.entity_id);

	assertSameSet(allowedFor(PERSONAL_PEER), [fixture.importKeys.personal], "personal peer outbound ops");
	assertSameSet(allowedFor(WORK_PEER), [fixture.importKeys.work], "work peer outbound ops");
	assertSameSet(allowedFor(OSS_PEER), [fixture.importKeys.oss], "OSS peer outbound ops");
	assertSameSet(allowedFor(OSS_EXCLUDED_PEER), [], "OSS peer excluded-project outbound ops");
	assertSameSet(allowedFor(LEGACY_PEER), [], "legacy peer default outbound ops");
	assertSameSet(allowedFor(MALICIOUS_PEER), [], "malicious peer outbound ops");
	assertSameSet(allowedFor(GROUP_ONLY_PEER), [], "coordinator-group-only peer outbound ops");

	const snapshot = loadMemorySnapshotPageForPeer(store.db, {
		peerDeviceId: WORK_PEER,
		scopeId: ACME_SCOPE,
		generation: 1,
		snapshotId: `snapshot-${ACME_SCOPE}`,
		baselineCursor: "2026-05-06T17:59:00.000Z|baseline",
		limit: 25,
	});
	assertSameSet(
		snapshot.items.map((item) => item.entity_id),
		[fixture.importKeys.work],
		"work scope bootstrap snapshot",
	);

	setReplicationCursor(store.db, WORK_PEER, { lastApplied: "2026-05-06T18:00:01.000Z|work" }, ACME_SCOPE);
	setReplicationCursor(store.db, OSS_PEER, { lastApplied: "2026-05-06T18:00:02.000Z|oss" }, OSS_SCOPE);
	assert(getReplicationCursor(store.db, WORK_PEER, ACME_SCOPE)[0]?.includes("work"), "missing work cursor");
	assert(getReplicationCursor(store.db, WORK_PEER, OSS_SCOPE)[0] == null, "work cursor leaked to OSS scope");
}

function visibleTitles(store: MemoryStore): string[] {
	return store.recent(20).map((item) => item.title);
}

async function assertStoreSurfaces(
	fixture: SmokeFixture,
	deviceId: string,
	expectedTitles: string[],
): Promise<void> {
	await withStore(fixture.dbPath, deviceId, async (store) => {
		assertSameSet(visibleTitles(store), expectedTitles, `${deviceId} recent visibility`);
		assertSameSet(
			store.search(QUERY_TOKEN, 20).map((item) => item.title),
			expectedTitles,
			`${deviceId} search visibility`,
		);
		assertSameSet(
			Object.entries(fixture.ids)
				.filter(([, id]) => store.timeline(null, id, 0, 0).length > 0)
				.map(([key]) => fixture.titles[key as keyof MemoryIds]),
			expectedTitles,
			`${deviceId} timeline visibility`,
		);
		const pack = store.buildMemoryPack(QUERY_TOKEN, 20, null, buildFilters({ query: QUERY_TOKEN }, null));
		assertSameSet(pack.items.map((item) => item.title), expectedTitles, `${deviceId} MCP pack visibility`);

		const mcpVisible = Object.entries(fixture.ids)
			.filter(([, id]) => getMemoryForMcp(store, id) != null)
			.map(([key]) => fixture.titles[key as keyof MemoryIds]);
		assertSameSet(mcpVisible, expectedTitles, `${deviceId} MCP direct-read visibility`);

		const app = createApp({ storeFactory: () => store });
		const observations = (await jsonResponse(app, "/api/observations?limit=20")) as {
			items: Array<{ title: string }>;
		};
		assertSameSet(
			observations.items.map((item) => item.title),
			expectedTitles,
			`${deviceId} viewer observations visibility`,
		);
		const viewerPack = (await jsonResponse(app, `/api/pack?context=${QUERY_TOKEN}&limit=20`)) as {
			items: Array<{ title: string }>;
		};
		assertSameSet(
			viewerPack.items.map((item) => item.title),
			expectedTitles,
			`${deviceId} viewer pack visibility`,
		);
	});
}

async function jsonResponse(app: ReturnType<typeof createApp>, path: string): Promise<unknown> {
	const response = await app.request(path);
	const body = await response.json();
	assert(response.ok, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
	return body;
}

async function assertViewerSyncState(fixture: SmokeFixture, revokedWork = false): Promise<void> {
	await withStore(fixture.dbPath, MIXED_DEVICE, async (store) => {
		const app = createApp({ storeFactory: () => store });
		const settings = (await jsonResponse(app, "/api/sync/sharing-domains/settings")) as {
			scopes: Array<{ scope_id: string }>;
			mappings: Array<{ project_pattern: string; scope_id: string }>;
		};
		assertSameSet(
			settings.scopes.map((scope) => scope.scope_id),
			[DEFAULT_SYNC_SCOPE_ID, PERSONAL_SCOPE, ACME_SCOPE, OSS_SCOPE, LEGACY_SCOPE],
			"viewer Sharing-domain settings scopes",
		);
		assertSameSet(
			settings.mappings.map((mapping) => `${mapping.project_pattern}->${mapping.scope_id}`),
			[
				`/workspace/personal/*->${PERSONAL_SCOPE}`,
				`/workspace/work/acme/*->${ACME_SCOPE}`,
				`/workspace/oss/codemem->${OSS_SCOPE}`,
			],
			"viewer project scope mappings",
		);

		const peers = (await jsonResponse(app, "/api/sync/peers?includeDiagnostics=1")) as {
			items: Array<{
				peer_device_id: string;
				authorized_scopes: Array<{ scope_id: string }>;
				project_scope: { effective_include: string[] };
				claimed_local_actor_scope?: { scope_id: string; authorized: boolean } | null;
				scope_rejections: { total: number; by_reason: Record<string, number> };
			}>;
		};
		const byPeer = new Map(peers.items.map((peer) => [peer.peer_device_id, peer]));
		assertSameSet(
			byPeer.get(PERSONAL_PEER)?.authorized_scopes.map((scope) => scope.scope_id) ?? [],
			[PERSONAL_SCOPE],
			"personal peer authorized scopes",
		);
		assertSameSet(
			byPeer.get(WORK_PEER)?.authorized_scopes.map((scope) => scope.scope_id) ?? [],
			revokedWork ? [] : [ACME_SCOPE],
			"work peer authorized scopes",
		);
		assertSameSet(
			byPeer.get(OSS_PEER)?.authorized_scopes.map((scope) => scope.scope_id) ?? [],
			[OSS_SCOPE],
			"OSS peer authorized scopes",
		);
		assertSameSet(byPeer.get(LEGACY_PEER)?.authorized_scopes.map((scope) => scope.scope_id) ?? [], [], "legacy authorized scopes");
		assertSameSet(
			byPeer.get(GROUP_ONLY_PEER)?.authorized_scopes.map((scope) => scope.scope_id) ?? [],
			[],
			"coordinator-group-only peer authorized scopes",
		);
		assert(
			byPeer.get(PERSONAL_PEER)?.claimed_local_actor_scope?.scope_id === PERSONAL_SCOPE,
			"personal same-actor peer should point at personal scope",
		);
		assert(
			byPeer.get(WORK_PEER)?.project_scope.effective_include.includes("personal/finance"),
			"work peer broad project filter fixture missing personal project include",
		);

		const status = (await jsonResponse(app, "/api/sync/status?includeDiagnostics=1")) as {
			peers: Array<{ peer_device_id: string; authorized_scopes: Array<{ scope_id: string }> }>;
		};
		assert(
			status.peers.some((peer) => peer.peer_device_id === OSS_PEER && peer.authorized_scopes[0]?.scope_id === OSS_SCOPE),
			"/api/sync/status did not include OSS peer Sharing-domain authorization",
		);
	});
}

function memoryRowCount(store: MemoryStore): number {
	const row = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as { count: number };
	return row.count;
}

function replicationOpCount(store: MemoryStore): number {
	const row = store.db.prepare("SELECT COUNT(*) AS count FROM replication_ops").get() as { count: number };
	return row.count;
}

function stableRows(store: MemoryStore, sql: string): string {
	return JSON.stringify(store.db.prepare(sql).all());
}

function mutationSnapshot(store: MemoryStore): string {
	return JSON.stringify({
		memoryItems: stableRows(
			store,
			`SELECT id, import_key, title, body_text, active, deleted_at, rev, updated_at,
			        actor_id, visibility, workspace_id, workspace_kind, scope_id, metadata_json
			   FROM memory_items
			  ORDER BY id`,
		),
		replicationOps: stableRows(
			store,
			`SELECT op_id, entity_type, entity_id, op_type, payload_json, clock_rev,
			        clock_updated_at, clock_device_id, device_id, created_at, scope_id
			   FROM replication_ops
			  ORDER BY op_id`,
		),
		replicationCursors: stableRows(
			store,
			`SELECT peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at
			   FROM replication_cursors_v2
			  ORDER BY peer_device_id, scope_id`,
		),
		syncResetState: stableRows(
			store,
			`SELECT scope_id, generation, snapshot_id, baseline_cursor, retained_floor_cursor
			   FROM sync_reset_state_v2
			  ORDER BY scope_id`,
		),
	});
}

function makeHostileOp(input: {
	opId: string;
	scopeId: string | null;
	peerDeviceId?: string;
	payload?: Record<string, unknown>;
	clockRev?: number;
	opType?: string;
	entityId?: string;
}): ReplicationOp {
	const peerDeviceId = input.peerDeviceId ?? MALICIOUS_PEER;
	return {
		op_id: input.opId,
		entity_type: "memory_item",
		entity_id: input.entityId ?? `hostile-${input.opId}`,
		op_type: input.opType ?? "upsert",
		payload_json: toJson({
			title: `hostile ${input.opId}`,
			body_text: "hostile payload must not be applied",
			kind: "discovery",
			visibility: "shared",
			project: "work/acme-api",
			workspace_id: input.scopeId,
			workspace_kind: "shared",
			scope_id: input.scopeId,
			...input.payload,
		}),
		clock_rev: input.clockRev ?? 1,
		clock_updated_at: "2026-05-06T18:05:00.000Z",
		clock_device_id: peerDeviceId,
		device_id: peerDeviceId,
		created_at: "2026-05-06T18:05:00.000Z",
		scope_id: input.scopeId,
	};
}

function assertHostileRejection(
	store: MemoryStore,
	op: ReplicationOp,
	expectedReason: string,
	peerDeviceId = MALICIOUS_PEER,
): void {
	const beforeMemoryCount = memoryRowCount(store);
	const beforeOpCount = replicationOpCount(store);
	const beforeSnapshot = mutationSnapshot(store);
	const result = applyReplicationOps(store.db, [op], MIXED_DEVICE, store.scanner, {
		inboundScopeValidation: { peerDeviceId, enabled: true },
	});
	assert(result.rejected === 1, `${op.op_id}: expected one rejected op, got ${result.rejected}`);
	assert(
		result.rejections[0]?.reason === expectedReason,
		`${op.op_id}: expected ${expectedReason}, got ${result.rejections[0]?.reason}`,
	);
	assert(memoryRowCount(store) === beforeMemoryCount, `${op.op_id}: hostile op changed memory row count`);
	assert(replicationOpCount(store) === beforeOpCount, `${op.op_id}: hostile op was recorded as applied`);
	assert(mutationSnapshot(store) === beforeSnapshot, `${op.op_id}: hostile op mutated protected local state`);
}

async function assertHostilePeerFixtures(fixture: SmokeFixture): Promise<void> {
	await withStore(fixture.dbPath, MIXED_DEVICE, async (store) => {
		assertHostileRejection(
			store,
			makeHostileOp({ opId: "sender-not-member", scopeId: ACME_SCOPE }),
			"sender_not_member",
		);
		assertHostileRejection(
			store,
			makeHostileOp({
				opId: "payload-scope-mismatch",
				scopeId: ACME_SCOPE,
				payload: { workspace_id: PERSONAL_SCOPE, workspace_kind: "personal", actor_id: MIXED_ACTOR },
			}),
			"scope_mismatch",
		);
		assertHostileRejection(
			store,
			makeHostileOp({
				opId: "claimed-local-actor-not-member",
				scopeId: PERSONAL_SCOPE,
				payload: {
					visibility: "private",
					workspace_id: PERSONAL_SCOPE,
					workspace_kind: "personal",
					actor_id: MIXED_ACTOR,
				},
			}),
			"sender_not_member",
		);
		assertHostileRejection(
			store,
			makeHostileOp({ opId: "max-clock-rev", scopeId: OSS_SCOPE, clockRev: Number.MAX_SAFE_INTEGER }),
			"sender_not_member",
		);
		assertHostileRejection(
			store,
			makeHostileOp({
				opId: "existing-key-max-clock-rev",
				scopeId: ACME_SCOPE,
				clockRev: Number.MAX_SAFE_INTEGER,
				entityId: fixture.importKeys.work,
			}),
			"sender_not_member",
		);
		assertHostileRejection(
			store,
			makeHostileOp({ opId: "local-default-scope", scopeId: DEFAULT_SYNC_SCOPE_ID }),
			"scope_mismatch",
		);
		assertHostileRejection(
			store,
			makeHostileOp({ opId: "unauthorized-reassign-scope", scopeId: OSS_SCOPE, opType: "reassign_scope" }),
			"sender_not_member",
		);
		assertHostileRejection(
			store,
			makeHostileOp({ opId: "missing-membership-manifest", scopeId: "unknown-coordinator-scope" }),
			"stale_epoch",
		);

		grantScope(store, ACME_SCOPE, [MALICIOUS_PEER], {
			status: "revoked",
			coordinatorId: "local-e2e-coordinator",
			groupId: "acme-eng",
		});
		assertHostileRejection(
			store,
			makeHostileOp({ opId: "revoked-peer-replay", scopeId: ACME_SCOPE }),
			"stale_epoch",
		);

		const boundary = loadReplicationOpsForPeer(store.db, {
			since: null,
			limit: 10,
			scopeId: ACME_SCOPE,
			generation: 1,
			snapshotId: "snapshot-before-cache-advanced",
			baselineCursor: "2026-01-01T00:00:00.000Z|old-baseline",
		});
		assert(
			boundary.reset_required === true && boundary.reset.reason === "boundary_mismatch",
			"stale snapshot replay should require reset with boundary_mismatch",
		);

		revokeScope(store, ACME_SCOPE, WORK_PEER);
		const workOp = opsByImportKey(store).get(fixture.importKeys.work);
		assert(workOp, "missing work op after revocation");
		const [allowedAfterRevoke] = filterReplicationOpsForSyncWithStatus(
			store.db,
			[workOp],
			WORK_PEER,
			{ localDeviceId: MIXED_DEVICE },
		);
		assertSameSet(allowedAfterRevoke.map((op) => op.entity_id), [], "work peer ops after revocation");

		const reasons = listInboundScopeRejections(store.db, { limit: 50 }).map((row) => row.reason);
		for (const reason of ["sender_not_member", "scope_mismatch", "stale_epoch"] as const) {
			assert(reasons.includes(reason), `expected rejection log to include ${reason}`);
		}
	});
}

async function assertMcpWriteGuard(fixture: SmokeFixture): Promise<void> {
	await withStore(fixture.dbPath, WORK_PEER, async (store) => {
		const before = memoryRowCount(store);
		const failedWithUnauthorizedScope = (() => {
			try {
				rememberMemoryForMcp(
					store,
					{
						kind: "decision",
						title: "unauthorized OSS write from work peer",
						body: "should roll back",
						confidence: 0.7,
						project: "oss/codemem",
					},
					{ cwd: "/workspace/oss/codemem", user: "e2e" },
				);
				return false;
			} catch (error) {
				return error instanceof Error && error.message.includes("unauthorized_scope");
			}
		})();
		assert(
			failedWithUnauthorizedScope,
			"work peer MCP remember into OSS scope should fail with unauthorized_scope",
		);
		assert(memoryRowCount(store) === before, "unauthorized MCP remember changed memory row count");
	});
}

async function main(): Promise<void> {
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	const { dbPath } = parseArgs(process.argv);
	prepareViewerStatic(dbPath);
	rmSync(dbPath, { force: true });
	mkdirSync(dirname(dbPath), { recursive: true });
	initDatabase(dbPath);

	const fixture = await withStore(dbPath, MIXED_DEVICE, async (store) => {
		seedTopology(store);
		const nextFixture = createMixedMemories(store);
		await store.flushPendingVectorWrites();
		const scopes = memoryScopes(store, nextFixture.ids);
		assert(scopes.personal === PERSONAL_SCOPE, `personal memory scope mismatch: ${scopes.personal}`);
		assert(scopes.work === ACME_SCOPE, `work memory scope mismatch: ${scopes.work}`);
		assert(scopes.oss === OSS_SCOPE, `OSS memory scope mismatch: ${scopes.oss}`);
		assertOutboundSync(store, nextFixture);
		return nextFixture;
	});

	await assertViewerSyncState(fixture, false);
	await assertStoreSurfaces(fixture, MIXED_DEVICE, allExpectedTitles(fixture.titles));
	await assertStoreSurfaces(fixture, PERSONAL_PEER, [fixture.titles.personal]);
	await assertStoreSurfaces(fixture, WORK_PEER, [fixture.titles.work]);
	await assertStoreSurfaces(fixture, OSS_PEER, [fixture.titles.oss]);
	await assertStoreSurfaces(fixture, LEGACY_PEER, []);
	await assertStoreSurfaces(fixture, MALICIOUS_PEER, []);
	await assertStoreSurfaces(fixture, GROUP_ONLY_PEER, []);
	await assertMcpWriteGuard(fixture);
	await assertHostilePeerFixtures(fixture);
	await assertViewerSyncState(fixture, true);

	console.log(
		JSON.stringify(
			{
				ok: true,
				db_path: dbPath,
				device_id: MIXED_DEVICE,
				scopes: [PERSONAL_SCOPE, ACME_SCOPE, OSS_SCOPE, LEGACY_SCOPE],
				peers: [
					PERSONAL_PEER,
					WORK_PEER,
					OSS_PEER,
					OSS_EXCLUDED_PEER,
					LEGACY_PEER,
					MALICIOUS_PEER,
					GROUP_ONLY_PEER,
				],
				memory_ids: fixture.ids,
			},
			null,
			2,
		),
	);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
