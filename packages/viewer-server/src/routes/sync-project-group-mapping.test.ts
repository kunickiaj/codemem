import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeviceIdentity, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncRoutes } from "./sync.js";

const NOW = "2026-10-01T00:00:00.000Z";
const REMOTE = "https://git.example.invalid/fixture-org/api.git";

interface InventoryEntry {
	ambiguous_name?: boolean;
	display_project: string;
	group_key?: string;
	guardrail_warnings: Array<{ code: string; requires_confirmation: boolean }>;
	workspace_identity: string;
}

/** A repository checkout and an older folder recorded under its name, which form one row. */
function seedFoldedGroup(store: MemoryStore): void {
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES ('fixture-team', 'Fixture Team', 'team', 'coordinator', 1, 'active', ?, ?)`,
		)
		.run(NOW, NOW);
	for (const [cwd, gitRemote] of [
		["/fixture/src/api", REMOTE],
		["/fixture/old/api", null],
	] as const) {
		const sessionId = Number(
			store.db
				.prepare(
					`INSERT INTO sessions(started_at, cwd, project, git_remote, user, tool_version)
					 VALUES (?, ?, 'api', ?, 'fixture-user', 'test')`,
				)
				.run(NOW, cwd, gitRemote).lastInsertRowid,
		);
		store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, visibility, project)
				 VALUES (?, 'discovery', 'Fixture memory', 'Body', ?, ?, 'private', 'api')`,
			)
			.run(sessionId, NOW, NOW);
	}
}

describe("saving a Space for a folded Project group", () => {
	let dir: string;
	let store: MemoryStore;
	let app: ReturnType<typeof syncRoutes>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codemem-group-mapping-"));
		vi.stubEnv("CODEMEM_KEYS_DIR", join(dir, "keys"));
		store = new MemoryStore(join(dir, "mem.sqlite"));
		// Space changes use the device identity the Viewer sets up on its first Devices load.
		const [deviceId] = ensureDeviceIdentity(store.db, { keysDir: join(dir, "keys") });
		store.adoptEnsuredDeviceIdentity(deviceId);
		seedFoldedGroup(store);
		app = syncRoutes(() => store);
	});

	afterEach(() => {
		store.close();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function inventory(): Promise<InventoryEntry[]> {
		const res = await app.request("/api/sync/projects?include_empty=false&limit=250");
		return ((await res.json()) as { projects: InventoryEntry[] }).projects;
	}

	function mappings(entries: InventoryEntry[], scopeId: string) {
		return {
			mappings: entries.map((entry) => ({
				project_pattern: entry.display_project,
				scope_id: scopeId,
				workspace_identity: entry.workspace_identity,
			})),
		};
	}

	async function check(entries: InventoryEntry[], scopeId: string) {
		const res = await app.request("/api/sync/sharing-domains/project-mappings/bulk/check", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(mappings(entries, scopeId)),
		});
		return {
			status: res.status,
			body: (await res.json()) as {
				accepted: boolean;
				guardrail_warnings: Array<{ code: string; requires_confirmation: boolean }>;
			},
		};
	}

	async function save(entries: InventoryEntry[], scopeId: string) {
		const res = await app.request("/api/sync/sharing-domains/project-mappings/bulk", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(mappings(entries, scopeId)),
		});
		return { status: res.status, body: (await res.json()) as { error?: string } };
	}

	it("lists the two folders as one row with no name review of their own", async () => {
		const entries = await inventory();

		expect(entries).toHaveLength(2);
		expect(entries.every((entry) => typeof entry.group_key === "string")).toBe(true);
		expect(new Set(entries.map((entry) => entry.group_key)).size).toBe(1);
		expect(entries.flatMap((entry) => entry.guardrail_warnings)).toEqual([]);
	});

	it("says a Team Space needs review, and the bulk save refuses it the same way", async () => {
		// Arrange
		const entries = await inventory();

		// Act
		const checked = await check(entries, "fixture-team");
		const saved = await save(entries, "fixture-team");

		// Assert: the mapping analysis still wants the name confirmed, which a bulk save can't do.
		expect(checked.status).toBe(200);
		expect(checked.body.accepted).toBe(false);
		expect(
			checked.body.guardrail_warnings.some(
				(warning) => warning.code === "basename_collision_review" && warning.requires_confirmation,
			),
		).toBe(true);
		expect(saved).toMatchObject({
			status: 409,
			body: { error: "guardrail_confirmation_required" },
		});
		expect(store.db.prepare("SELECT count(*) FROM project_scope_mappings").pluck().get()).toBe(0);
	});

	it("says a Space that needs no confirmation can be saved, and the bulk save accepts it", async () => {
		const entries = await inventory();

		const checked = await check(entries, "local-default");
		const saved = await save(entries, "local-default");

		expect(checked.body.accepted).toBe(true);
		expect(saved.status).toBe(200);
		expect(store.db.prepare("SELECT count(*) FROM project_scope_mappings").pluck().get()).toBe(2);
	});
});
