import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadStickyRulesForPack,
	STICKY_RULES_DEFAULT_BUDGETS,
	stickyRuleInputsFromFilters,
} from "./sticky-rules.js";
import { initTestSchema } from "./test-utils.js";

interface SeedMemoryOpts {
	id?: number;
	sessionId: number;
	title: string;
	appliesTo: "user" | "org" | "toolchain" | "project";
	appliesToKey?: string | null;
	scopeId?: string | null;
	active?: number;
	deletedAt?: string | null;
	updatedAt?: string;
}

function makeStore() {
	const db = new BetterSqlite3(":memory:");
	initTestSchema(db);
	db.prepare("INSERT INTO sessions (id, started_at, project) VALUES (?, ?, ?)").run(
		1,
		"2026-01-01T00:00:00Z",
		"demo-project",
	);
	return { db };
}

function seedMemory(store: ReturnType<typeof makeStore>, opts: SeedMemoryOpts) {
	const ts = opts.updatedAt ?? new Date().toISOString();
	store.db
		.prepare(
			`INSERT INTO memory_items
			(session_id, kind, title, body_text, confidence, tags_text, active,
			 created_at, updated_at, metadata_json, applies_to, applies_to_key,
			 scope_id, deleted_at, rev)
			 VALUES (?, 'rule', ?, 'body', 0.5, '', ?, ?, ?, '{}', ?, ?, ?, ?, 1)`,
		)
		.run(
			opts.sessionId,
			opts.title,
			opts.active ?? 1,
			ts,
			ts,
			opts.appliesTo,
			opts.appliesToKey ?? null,
			opts.scopeId ?? null,
			opts.deletedAt ?? null,
		);
	return Number((store.db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id);
}

describe("loadStickyRulesForPack", () => {
	let store: ReturnType<typeof makeStore>;

	beforeEach(() => {
		store = makeStore();
	});

	afterEach(() => {
		store.db.close();
	});

	it("returns an empty band when there are no sticky rules", () => {
		const band = loadStickyRulesForPack(store);
		expect(band.user).toEqual([]);
		expect(band.org).toEqual([]);
		expect(band.toolchain).toEqual([]);
		expect(band.project).toEqual([]);
		expect(band.ids).toEqual([]);
	});

	it("loads user/org/toolchain layers into their slots, capped by the per-layer budget", () => {
		// 7 user rules — budget caps at 5
		for (let i = 0; i < 7; i++) {
			seedMemory(store, {
				sessionId: 1,
				title: `User rule ${i}`,
				appliesTo: "user",
				updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
			});
		}
		seedMemory(store, {
			sessionId: 1,
			title: "Toolchain rule",
			appliesTo: "toolchain",
			appliesToKey: "pnpm",
		});

		const band = loadStickyRulesForPack(store, { toolchainKey: "pnpm" });
		expect(band.user.length).toBe(STICKY_RULES_DEFAULT_BUDGETS.user);
		// Newest user rules come first
		expect(band.user[0]?.title).toBe("User rule 6");
		expect(band.toolchain.length).toBe(1);
		expect(band.toolchain[0]?.title).toBe("Toolchain rule");
		expect(band.org).toEqual([]);
	});

	it("does not pull project-layer memories into the sticky band (avoids retrieval duplicate)", () => {
		seedMemory(store, { sessionId: 1, title: "Project memory 1", appliesTo: "project" });
		seedMemory(store, { sessionId: 1, title: "Project memory 2", appliesTo: "project" });
		seedMemory(store, { sessionId: 1, title: "Real sticky", appliesTo: "user" });

		const band = loadStickyRulesForPack(store);
		expect(band.project).toEqual([]);
		expect(band.user.map((m) => m.title)).toEqual(["Real sticky"]);
		expect(band.ids).toEqual([band.user[0]?.id]);
	});

	it("skips org/toolchain layers when no key is provided", () => {
		seedMemory(store, {
			sessionId: 1,
			title: "Org rule",
			appliesTo: "org",
			appliesToKey: "acme",
		});
		seedMemory(store, {
			sessionId: 1,
			title: "Toolchain rule",
			appliesTo: "toolchain",
			appliesToKey: "pnpm",
		});

		const band = loadStickyRulesForPack(store);
		expect(band.org).toEqual([]);
		expect(band.toolchain).toEqual([]);
	});

	it("filters org and toolchain by the supplied key", () => {
		seedMemory(store, {
			sessionId: 1,
			title: "pnpm rule",
			appliesTo: "toolchain",
			appliesToKey: "pnpm",
		});
		seedMemory(store, {
			sessionId: 1,
			title: "npm rule",
			appliesTo: "toolchain",
			appliesToKey: "npm",
		});

		const band = loadStickyRulesForPack(store, { toolchainKey: "pnpm" });
		expect(band.toolchain.map((m) => m.title)).toEqual(["pnpm rule"]);
	});

	it("excludes inactive and soft-deleted memories", () => {
		seedMemory(store, { sessionId: 1, title: "Active", appliesTo: "user" });
		seedMemory(store, {
			sessionId: 1,
			title: "Inactive",
			appliesTo: "user",
			active: 0,
		});
		seedMemory(store, {
			sessionId: 1,
			title: "Deleted",
			appliesTo: "user",
			deletedAt: "2026-01-02T00:00:00Z",
		});

		const band = loadStickyRulesForPack(store);
		expect(band.user.map((m) => m.title)).toEqual(["Active"]);
	});

	it("enforces the sharing-domain filter when scopeIds is provided", () => {
		seedMemory(store, {
			sessionId: 1,
			title: "Work-scope rule",
			appliesTo: "user",
			scopeId: "work-domain",
		});
		seedMemory(store, {
			sessionId: 1,
			title: "Personal-scope rule",
			appliesTo: "user",
			scopeId: "personal-domain",
		});
		seedMemory(store, {
			sessionId: 1,
			title: "Legacy NULL-scope rule",
			appliesTo: "user",
			scopeId: null,
		});

		const band = loadStickyRulesForPack(store, { scopeIds: ["work-domain"] });
		const titles = band.user.map((m) => m.title).sort();
		// Work-scope + legacy NULL-scope come through; personal-scope is filtered out.
		expect(titles).toEqual(["Legacy NULL-scope rule", "Work-scope rule"]);
	});

	it("returns no rules from another sharing domain even if applies_to=user", () => {
		seedMemory(store, {
			sessionId: 1,
			title: "Other-domain rule",
			appliesTo: "user",
			scopeId: "other-domain",
		});

		const band = loadStickyRulesForPack(store, { scopeIds: ["work-domain"] });
		expect(band.user).toEqual([]);
	});

	it("respects per-layer budget overrides", () => {
		for (let i = 0; i < 3; i++) {
			seedMemory(store, {
				sessionId: 1,
				title: `U${i}`,
				appliesTo: "user",
				updatedAt: `2026-01-0${i + 1}T00:00:00Z`,
			});
		}

		const band = loadStickyRulesForPack(store, { budgets: { user: 2 } });
		expect(band.user.length).toBe(2);
	});

	it("populates ids in pack order across layers (project excluded)", () => {
		const u = seedMemory(store, { sessionId: 1, title: "U", appliesTo: "user" });
		const t = seedMemory(store, {
			sessionId: 1,
			title: "T",
			appliesTo: "toolchain",
			appliesToKey: "pnpm",
		});
		// project memory should NOT appear in band.ids
		seedMemory(store, { sessionId: 1, title: "P", appliesTo: "project" });

		const band = loadStickyRulesForPack(store, { toolchainKey: "pnpm" });
		expect(band.ids).toEqual([u, t]);
	});
});

describe("loadStickyRulesForPack EXPLAIN QUERY PLAN", () => {
	it("uses idx_memory_items_applies_to for the user-layer query", () => {
		const store = makeStore();
		try {
			// Seed enough varied rows for the planner to prefer the index.
			const layers: Array<"user" | "org" | "toolchain" | "project"> = [
				"user",
				"org",
				"toolchain",
				"project",
			];
			for (let i = 0; i < 100; i++) {
				const layer = layers[i % layers.length] ?? "project";
				seedMemory(store, {
					sessionId: 1,
					title: `m${i}`,
					appliesTo: layer,
					appliesToKey: layer === "org" || layer === "toolchain" ? `k${i % 4}` : null,
					updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
				});
			}
			store.db.exec("ANALYZE");

			const plan = store.db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT id FROM memory_items WHERE applies_to = ? AND active = 1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5",
				)
				.all("user") as { detail: string }[];
			const detail = plan.map((p) => p.detail).join(" | ");
			expect(detail).toMatch(/idx_memory_items_applies_to/);
		} finally {
			store.db.close();
		}
	});
});

describe("stickyRuleInputsFromFilters", () => {
	it("returns empty inputs when filters is undefined", () => {
		expect(stickyRuleInputsFromFilters(undefined)).toEqual({});
	});

	it("threads scope_id string into scopeIds", () => {
		expect(stickyRuleInputsFromFilters({ scope_id: "work" })).toEqual({ scopeIds: ["work"] });
	});

	it("threads scope_id array into scopeIds", () => {
		expect(stickyRuleInputsFromFilters({ scope_id: ["a", "b"] })).toEqual({ scopeIds: ["a", "b"] });
	});

	it("falls back to include_scope_ids when scope_id is absent", () => {
		expect(stickyRuleInputsFromFilters({ include_scope_ids: ["a"] })).toEqual({ scopeIds: ["a"] });
	});
});
