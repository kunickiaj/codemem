import { initTestSchema, type MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advancePendingProjectShares } from "./routes/sync.js";

describe("advancePendingProjectShares", () => {
	let db: InstanceType<typeof Database>;
	let store: MemoryStore;

	function seedOperation(input: { id: string; state: string; owner?: string; createdAt: string }) {
		db.prepare(`INSERT INTO share_operations(
			operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
			person_kind, teammate_name, history_policy, reviewed_project_set_digest,
			coordinator_group_id, invite_token_digest, invite_expires_at, created_at, updated_at
		) VALUES (?, ?, ?, '[]', ?, 'existing', 'Brian', 'existing_and_future', ?,
			'team-a', ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run(
			input.id,
			input.state,
			input.owner ?? "actor-local",
			`person-${input.id}`,
			`digest-${input.id}`,
			`token-${input.id}`,
			input.createdAt,
			input.createdAt,
		);
		db.prepare(`INSERT INTO share_operation_steps(
			operation_id, step_key, effect_id, status, attempt_count, updated_at
		) VALUES (?, 'invite_consumption', ?, 'pending', 0, ?)`).run(
			input.id,
			`invite-consumption:${input.id}`,
			input.createdAt,
		);
	}

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		store = { actorId: "actor-local", db } as unknown as MemoryStore;
	});

	afterEach(() => db.close());

	it("processes a bounded oldest-first locally owned set and isolates failures", async () => {
		seedOperation({ id: "share-oldest", state: "accepted", createdAt: "2026-07-20T00:00:00Z" });
		seedOperation({
			id: "share-foreign",
			state: "accepted",
			owner: "actor-other",
			createdAt: "2026-07-20T00:00:01Z",
		});
		seedOperation({ id: "share-second", state: "provisioning", createdAt: "2026-07-20T00:00:02Z" });
		seedOperation({ id: "share-third", state: "initial_sync", createdAt: "2026-07-20T00:00:03Z" });
		seedOperation({ id: "share-revoked", state: "revoked", createdAt: "2026-07-19T00:00:00Z" });
		seedOperation({ id: "share-revoking", state: "revoking", createdAt: "2026-07-19T00:00:00Z" });
		seedOperation({ id: "share-cancelled", state: "cancelled", createdAt: "2026-07-19T00:00:01Z" });
		const visited: string[] = [];
		const advanceOperation = vi.fn(async (_store: MemoryStore, operationId: string) => {
			visited.push(operationId);
			if (operationId === "share-oldest") throw new Error("injected failure");
			return { advanced: true, state: "active" as const };
		});

		const result = await advancePendingProjectShares(store, {
			limit: 2,
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(visited).toEqual(["share-oldest", "share-second"]);
		expect(result).toMatchObject({ processed: 2, advanced: 1, failed: 1, waiting: 0 });
		expect(result.items[0]).toMatchObject({
			operationId: "share-oldest",
			outcome: "failed",
			error: "injected failure",
		});
		expect(result.items[1]).toEqual({ operationId: "share-second", outcome: "advanced" });
	});

	it("prioritizes advanceable work over older invite polling", async () => {
		for (const [id, createdAt] of [
			["share-waiting-1", "2026-07-20T00:00:00Z"],
			["share-waiting-2", "2026-07-20T00:00:01Z"],
			["share-waiting-3", "2026-07-20T00:00:02Z"],
		] as const) {
			seedOperation({ id, state: "waiting_for_acceptance", createdAt });
		}
		seedOperation({
			id: "share-accepted-new",
			state: "accepted",
			createdAt: "2026-07-20T00:10:00Z",
		});
		const advanceOperation = vi.fn(async (_store: MemoryStore, operationId: string) =>
			operationId === "share-accepted-new"
				? { advanced: true, state: "active" as const }
				: { advanced: false, state: "waiting_for_acceptance" as const },
		);

		await advancePendingProjectShares(store, {
			limit: 3,
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).toHaveBeenCalledWith(store, "share-accepted-new");
	});

	it("retries waiting-for-device operations through the existing advance seam", async () => {
		seedOperation({
			id: "share-waiting-device",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).toHaveBeenCalledWith(store, "share-waiting-device");
		expect(result).toMatchObject({ processed: 1, advanced: 1, failed: 0 });
	});

	it("treats an offline recipient as passive waiting instead of a daemon failure", async () => {
		seedOperation({
			id: "share-waiting-device",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw new Error("waiting_for_device");
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({
			processed: 1,
			advanced: 0,
			waiting: 1,
			attention: 0,
			failed: 0,
		});
		expect(result.items).toEqual([
			{ operationId: "share-waiting-device", outcome: "waiting_for_device" },
		]);
	});

	it("backs off recent waiting-for-device operations", async () => {
		seedOperation({
			id: "share-waiting-device",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:58:00Z",
		});
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, waiting: 0, attention: 0, failed: 0 });
	});

	it("leaves terminal needs-attention operations for explicit user retry", async () => {
		seedOperation({
			id: "share-needs-attention",
			state: "needs_attention",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, attention: 0, failed: 0 });
	});

	it("reports a newly terminal operation without failing global daemon health", async () => {
		seedOperation({
			id: "share-failed-setup",
			state: "accepted",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			db.prepare(
				"UPDATE share_operations SET state = 'needs_attention' WHERE operation_id = ?",
			).run("share-failed-setup");
			throw new Error("provisioning_failed");
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({
			processed: 1,
			advanced: 0,
			waiting: 0,
			attention: 1,
			failed: 0,
		});
		expect(result.items[0]).toMatchObject({
			operationId: "share-failed-setup",
			outcome: "needs_attention",
			error: "provisioning_failed",
		});
	});

	it.each([
		"coordinator_not_configured",
		"team_sharing_not_configured",
		"team_selection_ambiguous",
	])("moves pre-step configuration failure %s to explicit recovery", async (errorCode) => {
		seedOperation({
			id: "share-missing-coordinator",
			state: "accepted",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw new Error(errorCode);
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, attention: 1, failed: 0 });
		expect(result.items[0]).toMatchObject({ outcome: "needs_attention" });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe("needs_attention");
	});

	it("polls waiting-for-acceptance operations and backs off after a pending response", async () => {
		seedOperation({
			id: "share-awaiting-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => ({
			advanced: false,
			state: "waiting_for_acceptance" as const,
		}));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).toHaveBeenCalledWith(store, "share-awaiting-acceptance");
		expect(result).toMatchObject({ processed: 1, advanced: 0, waiting: 1, failed: 0 });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe(
			"waiting_for_acceptance",
		);
		expect(db.prepare("SELECT updated_at FROM share_operations").pluck().get()).toBe(
			"2026-07-20T01:00:00.000Z",
		);
	});

	it("does not poll a recently checked waiting-for-acceptance operation", async () => {
		seedOperation({
			id: "share-awaiting-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:59:45Z",
		});
		const advanceOperation = vi.fn(async () => ({
			advanced: false,
			state: "waiting_for_acceptance" as const,
		}));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, waiting: 0, failed: 0 });
	});

	it("backs off transient invite reconciliation errors without poisoning daemon health", async () => {
		seedOperation({
			id: "share-awaiting-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw new Error("coordinator unavailable");
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({
			processed: 1,
			waiting: 1,
			attention: 0,
			failed: 0,
		});
		expect(result.items[0]).toMatchObject({ outcome: "retry_scheduled" });
		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'invite_consumption'`)
				.get("share-awaiting-acceptance"),
		).toEqual({ status: "pending", attempt_count: 1, safe_error_code: "operation_read_failed" });
	});

	it("moves terminal invite reconciliation errors to explicit recovery", async () => {
		seedOperation({
			id: "share-invalid-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw Object.assign(new Error("operation_scope_mismatch"), { status: 409 });
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, waiting: 0, attention: 1, failed: 0 });
		expect(result.items[0]).toMatchObject({ outcome: "needs_attention" });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe("needs_attention");
	});

	it.each([
		"coordinator_not_configured",
		"team_sharing_not_configured",
		"team_selection_ambiguous",
		"recipient_fingerprint_mismatch",
		"recipient_device_identity_conflict",
		"recipient_actor_conflict",
		"pending_person_identity_conflict",
		"operation_intent_mismatch",
	])("moves status-less deterministic conflict %s to explicit recovery", async (errorCode) => {
		seedOperation({
			id: "share-invalid-identity",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw new Error(errorCode);
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, waiting: 0, attention: 1, failed: 0 });
		expect(result.items[0]).toMatchObject({ outcome: "needs_attention", error: errorCode });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe("needs_attention");
		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'invite_consumption'`)
				.get("share-invalid-identity"),
		).toEqual({ status: "failed", attempt_count: 1, safe_error_code: errorCode });
	});

	it("keeps transient invite reconciliation passive and recovers after the coordinator returns", async () => {
		seedOperation({
			id: "share-awaiting-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		db.prepare(`UPDATE share_operation_steps SET attempt_count = 2
			WHERE operation_id = ? AND step_key = 'invite_consumption'`).run("share-awaiting-acceptance");
		const advanceOperation = vi.fn(async () => {
			throw new Error("coordinator unavailable");
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, waiting: 1, attention: 0, failed: 0 });
		expect(result.items[0]).toMatchObject({ outcome: "retry_scheduled" });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe(
			"waiting_for_acceptance",
		);
		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'invite_consumption'`)
				.get("share-awaiting-acceptance"),
		).toEqual({ status: "pending", attempt_count: 3, safe_error_code: "operation_read_failed" });

		const recoveredAdvance = vi.fn(async () => {
			db.prepare("UPDATE share_operations SET state = 'active' WHERE operation_id = ?").run(
				"share-awaiting-acceptance",
			);
			return { advanced: true, state: "active" as const };
		});
		const recovered = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:01:00Z"),
			advanceOperation: recoveredAdvance,
		});

		expect(recovered).toMatchObject({ processed: 1, advanced: 1, failed: 0 });
		expect(recoveredAdvance).toHaveBeenCalledWith(store, "share-awaiting-acceptance");
	});
});
