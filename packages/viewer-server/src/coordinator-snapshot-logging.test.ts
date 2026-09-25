import { initTestSchema, type MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createRecipientPolicyReconcilerEffects } from "./routes/sync.js";

it("logs only safe status codes for failed coordinator snapshot reads", async () => {
	const db = new Database(":memory:");
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		initTestSchema(db);
		db.prepare(`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch,
			status, created_at, updated_at
		) VALUES ('scope-a', 'Project', 'managed_project', 'coordinator',
			'https://coord.example.test', 'group', 1, 'active', ?, ?)`).run("2026-09-25", "2026-09-25");
		const store = { db, deviceId: "device-local" } as unknown as MemoryStore;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "secret-canary" }), {
						status: 429,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const effects = createRecipientPolicyReconcilerEffects(store, {
			config: {
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group"],
			} as never,
		});
		const input = { canonicalProjectIdentity: "project-a", scopeId: "scope-a" };
		await expect(effects.snapshot(input)).rejects.toThrow("recipient_policy_snapshot_not_fresh");
		await expect(effects.listBoundaryEnrollments(input)).rejects.toThrow(
			"recipient_policy_snapshot_not_fresh",
		);
		expect(warn.mock.calls.map(([message]) => message)).toEqual([
			"[sync] recipient policy coordinator snapshot failed: stage=scope_memberships code=http_429",
			"[sync] recipient policy coordinator snapshot failed: stage=device_enrollments code=http_429",
		]);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-canary");
	} finally {
		warn.mockRestore();
		vi.unstubAllGlobals();
		db.close();
	}
});
