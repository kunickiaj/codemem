import { initDatabase, MemoryStore, recordReplicationOp } from "../../packages/core/src/index.ts";

const DB_PATH = "/data/mem.sqlite";
const NOW = "2026-07-21T12:00:00.000Z";
const SOURCE_SCOPE = "project-sharing-source";
const SELECTED_REMOTE = "https://example.invalid/acme/selected.git";
const UNRELATED_REMOTE = "https://example.invalid/acme/unrelated.git";

type Action = "init" | "seed-a" | "add-future" | "summary";

function action(): Action {
	const index = process.argv.indexOf("--action");
	const value = process.argv[index + 1];
	if (!value || !["init", "seed-a", "add-future", "summary"].includes(value)) {
		throw new Error("--action must be init, seed-a, add-future, or summary");
	}
	return value as Action;
}

function session(store: MemoryStore, project: string, remote: string): number {
	const id = store.startSession({
		cwd: `/workspace/${project}`,
		project,
		user: "e2e",
		toolVersion: "project-sharing-e2e",
	});
	store.db.prepare("UPDATE sessions SET git_remote = ? WHERE id = ?").run(remote, id);
	return id;
}

function remember(
	store: MemoryStore,
	sessionId: number,
	title: string,
	workspaceId: string | null = SOURCE_SCOPE,
): number {
	return store.remember(sessionId, "discovery", title, `${title} body`, 0.9, ["project-sharing-e2e"], {
		visibility: "shared",
		...(workspaceId ? { workspace_id: workspaceId, workspace_kind: "shared" } : {}),
		created_at: NOW,
		updated_at: NOW,
	});
}

function stampSourceScope(store: MemoryStore, memoryId: number, replicated: boolean): void {
	const importKey = store.db
		.prepare("SELECT import_key FROM memory_items WHERE id = ?")
		.pluck()
		.get(memoryId) as string | null;
	store.db
		.prepare(
			`DELETE FROM replication_ops
			 WHERE entity_type = 'memory_item'
			   AND entity_id IN (CAST(? AS TEXT), ?)`,
		)
		.run(memoryId, importKey ?? "__missing_import_key__");
	store.db.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?").run(SOURCE_SCOPE, memoryId);
	if (replicated) {
		recordReplicationOp(store.db, {
			memoryId,
			opType: "upsert",
			deviceId: store.deviceId,
			scopeId: SOURCE_SCOPE,
			createdAt: NOW,
		});
		return;
	}
	store.db.prepare("UPDATE memory_items SET import_key = NULL WHERE id = ?").run(memoryId);
}

function seedA(store: MemoryStore): void {
	store.db
		.prepare(
			`INSERT OR REPLACE INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, 'Project sharing source', 'team', 'local', 1, 'active', ?, ?)`,
		)
		.run(SOURCE_SCOPE, NOW, NOW);
	for (const deviceId of [store.deviceId, "source-bystander"]) {
		store.db
			.prepare(
				`INSERT OR REPLACE INTO scope_memberships(
					scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES (?, ?, 'member', 'active', 1, ?)`,
			)
			.run(SOURCE_SCOPE, deviceId, NOW);
	}
	const selectedSession = session(store, "selected-project", SELECTED_REMOTE);
	const selectedId = remember(store, selectedSession, "selected existing");
	store.endSession(selectedSession, { fixture: "selected-existing" });
	stampSourceScope(store, selectedId, false);

	const unrelatedSession = session(store, "unrelated-project", UNRELATED_REMOTE);
	const unrelatedId = remember(store, unrelatedSession, "unrelated existing");
	store.endSession(unrelatedSession, { fixture: "unrelated-existing" });
	stampSourceScope(store, unrelatedId, true);
}

function addFuture(store: MemoryStore): void {
	const selectedSession = session(store, "selected-project", SELECTED_REMOTE);
	remember(store, selectedSession, "selected future", null);
	store.endSession(selectedSession, { fixture: "selected-future" });

	const unrelatedSession = session(store, "unrelated-project", UNRELATED_REMOTE);
	const unrelatedId = remember(store, unrelatedSession, "unrelated future");
	store.endSession(unrelatedSession, { fixture: "unrelated-future" });
	stampSourceScope(store, unrelatedId, true);
}

function summary(store: MemoryStore): Record<string, unknown> {
	return {
		device_id: store.deviceId,
		actor_id: store.actorId,
		actor_display_name: store.actorDisplayName,
		memories: store.db
			.prepare("SELECT title, project, scope_id, active FROM memory_items ORDER BY title")
			.all(),
		actors: store.db
			.prepare("SELECT actor_id, display_name, status FROM actors ORDER BY actor_id")
			.all(),
		peers: store.db
			.prepare("SELECT peer_device_id, name, actor_id FROM sync_peers ORDER BY peer_device_id")
			.all(),
		managed_memberships: store.db
			.prepare(
				`SELECT sm.scope_id, sm.device_id, sm.status
				 FROM scope_memberships sm
				 JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
				 WHERE rs.kind = 'managed_project'
				 ORDER BY sm.scope_id, sm.device_id`,
			)
			.all(),
		source_memberships: store.db
			.prepare("SELECT device_id, status FROM scope_memberships WHERE scope_id = ? ORDER BY device_id")
			.all(SOURCE_SCOPE),
		operations: store.db
			.prepare(
				`SELECT operation_id, state, teammate_name, recipient_device_id,
					recipient_device_display_name
				 FROM share_operations ORDER BY created_at`,
			)
			.all(),
	};
}

async function main(): Promise<void> {
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	initDatabase(DB_PATH);
	const store = new MemoryStore(DB_PATH);
	try {
		const selectedAction = action();
		if (selectedAction === "seed-a") seedA(store);
		if (selectedAction === "add-future") addFuture(store);
		await store.flushPendingVectorWrites();
		console.log(JSON.stringify({ ok: true, action: selectedAction, ...summary(store) }, null, 2));
	} finally {
		store.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
