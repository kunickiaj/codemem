import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDatabase, MemoryStore } from "../../packages/core/src/index.ts";
import {
	FIXTURE_ACTIONS,
	parseFixtureAction,
	runFixtureAction,
} from "./dogfood-sharing-fixture.ts";

const temporaryDirectories: string[] = [];

function createStore(role: string, options: { preseedIdentity?: boolean } = {}): MemoryStore {
	const directory = mkdtempSync(join(tmpdir(), `codemem-dogfood-${role}-`));
	temporaryDirectories.push(directory);
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "missing-config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	if (options.preseedIdentity !== false) {
		vi.stubEnv("CODEMEM_DEVICE_ID", `dogfood-${role}-device`);
		vi.stubEnv("CODEMEM_ACTOR_ID", `dogfood-${role}-identity`);
	} else {
		vi.stubEnv("CODEMEM_DEVICE_ID", undefined);
		vi.stubEnv("CODEMEM_ACTOR_ID", undefined);
	}
	vi.stubEnv("CODEMEM_ACTOR_DISPLAY_NAME", `Dogfood ${role}`);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const databasePath = join(directory, "mem.sqlite");
	initDatabase(databasePath);
	return new MemoryStore(databasePath);
}

function readSharingMutationCounts(store: MemoryStore): Record<string, number> {
	return Object.fromEntries(
		[
			"policy_team_memberships",
			"project_recipients",
			"project_scope_mappings",
			"replication_scopes",
			"scope_memberships",
			"share_operations",
			"share_operation_projects",
			"share_operation_steps",
		].map((table) => [
			table,
			Number(store.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()),
		]),
	);
}

const EMPTY_SHARING_MUTATION_COUNTS = {
	policy_team_memberships: 0,
	project_recipients: 0,
	project_scope_mappings: 0,
	replication_scopes: 0,
	scope_memberships: 0,
	share_operations: 0,
	share_operation_projects: 0,
	share_operation_steps: 0,
};

afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("parseFixtureAction", () => {
	it("keeps fixture source free of invitation inspection and network calls", () => {
		const source = readFileSync(resolve("e2e/scripts/dogfood-sharing-fixture.ts"), "utf8");

		expect(source).not.toMatch(
			/\b(?:fetch|request)\s*\(|coordinator|invite|project_recipients|share_operations/iu,
		);
	});

	it("accepts only one explicit supported action", () => {
		expect(parseFixtureAction(["--action", "setup-owner"])).toBe("setup-owner");
	});

	it.each([
		[[]],
		[["setup-owner"]],
		[["--action", "setup-owner", "extra"]],
		[["--action", "unsupported-policy-mutation"]],
		[["--action", "create-invite"]],
		[["--action", "accept-invite"]],
		[["--action", "inspect-invite"]],
		[["--action", "commit-invite"]],
	])("rejects malformed or unsupported arguments: %j", (args) => {
		expect(() => parseFixtureAction(args)).toThrow(
			`Expected exactly --action <${FIXTURE_ACTIONS.join("|")}>`,
		);
	});
});

describe("runFixtureAction", () => {
	it("sets up the owner idempotently with separated Projects and an empty Team", async () => {
		const store = createStore("owner");
		try {
			await runFixtureAction(store, "setup-owner");
			const summary = await runFixtureAction(store, "setup-owner");

			expect(summary.profile.role).toBe("owner");
			expect(summary.team).toMatchObject({ exists: true, member_count: 0 });
			expect(summary.projects.selected.titles).toEqual([
				"DOGFOOD selected existing",
			]);
			expect(summary.projects.unrelated.titles).toEqual([
				"DOGFOOD unrelated existing",
			]);
			expect(summary.separation).toEqual({
				distinct_remotes: true,
				overlapping_titles: [],
				isolated: true,
			});
		} finally {
			store.close();
		}
	});

	it.each(["teammate", "second-device"] as const)(
		"initializes the %s profile idempotently without owner Projects or policy state",
		async (role) => {
			const store = createStore(role);
			try {
				await runFixtureAction(store, `setup-${role}`);
				const summary = await runFixtureAction(store, `setup-${role}`);

				expect(summary.profile.role).toBe(role);
				expect(summary.projects.selected.memory_count).toBe(0);
				expect(summary.projects.unrelated.memory_count).toBe(0);
				expect(summary.team).toMatchObject({ exists: false, member_count: 0 });
				expect(readSharingMutationCounts(store)).toEqual(EMPTY_SHARING_MUTATION_COUNTS);
			} finally {
				store.close();
			}
		},
	);

	it("ensures device identity before creating one human-named active local Identity", async () => {
		const store = createStore("owner", { preseedIdentity: false });
		try {
			expect(store.actorId).toBe("local:local");

			const summary = await runFixtureAction(store, "setup-owner");
			const localActors = store.db
				.prepare(
					"SELECT actor_id, display_name FROM actors WHERE is_local = 1 AND status = 'active'",
				)
				.all() as Array<{ actor_id: string; display_name: string }>;

			expect(summary.profile.identity_id).not.toBe("local:local");
			expect(summary.profile.identity_invariant).toEqual({
				active_local_count: 1,
				human_named: true,
			});
			expect(localActors).toEqual([
				{ actor_id: summary.profile.identity_id, display_name: "Dogfood Owner" },
			]);
		} finally {
			store.close();
		}
	});

	it("creates distinct stable human-named Identities for all three fresh peers", async () => {
		const summaries: Awaited<ReturnType<typeof runFixtureAction>>[] = [];
		const stores: MemoryStore[] = [];
		try {
			for (const role of ["owner", "teammate", "second-device"] as const) {
				const store = createStore(role, { preseedIdentity: false });
				stores.push(store);
				summaries.push(await runFixtureAction(store, `setup-${role}`));
			}

			expect(new Set(summaries.map((summary) => summary.profile.identity_id)).size).toBe(3);
			expect(summaries.every((summary) => summary.profile.device_id !== "local")).toBe(true);
			expect(
				summaries.every(
					(summary) =>
						summary.profile.identity_invariant.active_local_count === 1 &&
						summary.profile.identity_invariant.human_named,
				),
			).toBe(true);
			expect(summaries.map((summary) => summary.profile.display_name)).toEqual([
				"Dogfood Owner",
				"Dogfood Teammate",
				"Dogfood Teammate Second Device",
			]);
		} finally {
			for (const store of stores) store.close();
		}
	});

	it.each(["add-future-selected", "add-future-unrelated"] as const)(
		"rejects %s before the owner baseline exists",
		async (action) => {
			const store = createStore("owner");
			try {
				await expect(runFixtureAction(store, action)).rejects.toThrow(
					"Owner fixture is not initialized",
				);
			} finally {
				store.close();
			}
		},
	);

	it("rejects changing an initialized profile to a different dogfood role", async () => {
		const store = createStore("role-conflict");
		try {
			await runFixtureAction(store, "setup-teammate");

			await expect(runFixtureAction(store, "setup-second-device")).rejects.toThrow(
				"already initialized as teammate",
			);
		} finally {
			store.close();
		}
	});

	it("keeps selected and unrelated Projects in exact separate sessions", async () => {
		const store = createStore("owner");
		try {
			const summary = await runFixtureAction(store, "setup-owner");
			const sessions = store.db
				.prepare("SELECT project, cwd, git_remote FROM sessions ORDER BY project")
				.all() as Array<{ project: string; cwd: string; git_remote: string }>;

			expect(summary.projects.selected.remote).toBe(
				"https://example.invalid/dogfood/selected.git",
			);
			expect(summary.projects.unrelated.remote).toBe(
				"https://example.invalid/dogfood/unrelated.git",
			);
			expect(sessions).toEqual([
				{
					project: "dogfood-selected-project",
					cwd: "/workspace/dogfood-selected-project",
					git_remote: "https://example.invalid/dogfood/selected.git",
				},
				{
					project: "dogfood-unrelated-project",
					cwd: "/workspace/dogfood-unrelated-project",
					git_remote: "https://example.invalid/dogfood/unrelated.git",
				},
			]);
		} finally {
			store.close();
		}
	});

	it("adds one idempotent future memory to each exact Project independently", async () => {
		const store = createStore("owner");
		try {
			await runFixtureAction(store, "setup-owner");
			await runFixtureAction(store, "add-future-selected");
			await runFixtureAction(store, "add-future-selected");
			const selected = await runFixtureAction(store, "summary");

			expect(selected.projects.selected.titles).toEqual([
				"DOGFOOD selected existing",
				"DOGFOOD selected future",
			]);
			expect(selected.projects.unrelated.titles).toEqual([
				"DOGFOOD unrelated existing",
			]);

			await runFixtureAction(store, "add-future-unrelated");
			const unrelated = await runFixtureAction(store, "add-future-unrelated");

			expect(unrelated.projects.selected.titles).toEqual(
				selected.projects.selected.titles,
			);
			expect(unrelated.projects.unrelated.titles).toEqual([
				"DOGFOOD unrelated existing",
				"DOGFOOD unrelated future",
			]);
			expect(unrelated.separation.isolated).toBe(true);
		} finally {
			store.close();
		}
	});

	it("leaves invitation and recipient-policy tables empty after supported actions", async () => {
		const store = createStore("owner");
		try {
			for (const action of [
				"setup-owner",
				"add-future-selected",
				"add-future-unrelated",
				"summary",
			] as const) {
				await runFixtureAction(store, action);
			}

			expect(readSharingMutationCounts(store)).toEqual(EMPTY_SHARING_MUTATION_COUNTS);
		} finally {
			store.close();
		}
	});
});
