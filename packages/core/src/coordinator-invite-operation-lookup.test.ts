import { describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { type Backend, type Store, setupStore } from "./coordinator-auth-store-test-fixtures.js";

const GROUP_ID = "lookup-group";
const OPERATION_ID = `share_${"a".repeat(40)}`;
const PROJECTS = [
	{
		canonical_identity: "https://git.example.invalid/example/project.git",
		display_name: "Project",
		existing_memory_count: 3,
	},
];

const PENDING_RESPONSE = {
	operation_id: OPERATION_ID,
	group_id: GROUP_ID,
	reviewed_project_set_digest: "b".repeat(64),
	state: "waiting_for_acceptance",
	pending_person_id: "pending-person",
	recipient_actor_id: null,
	recipient_display_name: null,
	recipient_device_id: null,
	recipient_device_display_name: null,
	recipient_public_key: null,
	recipient_fingerprint: null,
	consumed_at: null,
	bootstrap_grant_id: null,
	trust_state: "pending",
	projects: PROJECTS,
	invite_link: expect.stringMatching(/^codemem:\/\/join\?invite=/u),
};

async function createOperationInvite(store: Store) {
	await store.createGroup(GROUP_ID, "Fixture team");
	await store.createGroup("other-group");
	return store.createInvite({
		groupId: GROUP_ID,
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00.000Z",
		operationId: OPERATION_ID,
		reviewedProjectSetDigest: "b".repeat(64),
		projectIntent: PROJECTS,
		projectSummaries: PROJECTS,
		inviterDisplayName: "Fixture owner",
		pendingPersonId: "pending-person",
	});
}

describe.each<Backend>(["SQLite", "D1"])("%s invite operation lookup", (backend) => {
	it.each(["pending", "consumed", "revoked", "expired"])(
		"retrieves the complete %s record with the operation index instead of listing history",
		async (state) => {
			// Arrange: terminal and expired records must remain visible to admin polling.
			const { store, db } = setupStore(backend);
			try {
				const invite = await createOperationInvite(store);
				if (state !== "pending") {
					const updates = {
						consumed: "consumed_at = '2026-10-01T00:00:00.000Z', token = 'consumed:fixture'",
						revoked: "revoked_at = '2026-10-01T00:00:00.000Z'",
						expired: "expires_at = '2000-01-01T00:00:00.000Z'",
					}[state];
					db.prepare(`UPDATE coordinator_invites SET ${updates} WHERE invite_id = ?`).run(
						invite.invite_id,
					);
				}
				const expected = (await store.listInvites(GROUP_ID))[0];
				const listing = vi
					.spyOn(store, "listInvites")
					.mockRejectedValue(new Error("history forbidden"));
				const prepare = vi.spyOn(db, "prepare");

				// Act: inspect the actual SQL executed by each implementation, not a test-only query.
				const result = await store.getInviteByOperationId(GROUP_ID, OPERATION_ID);
				const queries = prepare.mock.calls.map(([query]) => query);
				prepare.mockRestore();
				const plans = queries.map((query) =>
					db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(GROUP_ID, OPERATION_ID),
				);

				// Assert: the unique operation index supplies the row and group isolation remains a predicate.
				expect(result).toEqual(expected);
				expect(listing).not.toHaveBeenCalled();
				expect(queries).toHaveLength(1);
				expect(plans[0]).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							detail: expect.stringMatching(
								/SEARCH coordinator_invites USING INDEX idx_coordinator_invites_operation_id \(operation_id=\?\)/u,
							),
						}),
					]),
				);
			} finally {
				vi.restoreAllMocks();
				await store.close();
				if (db.open) db.close();
			}
		},
	);

	it.each([
		{ groupId: GROUP_ID, operationId: "missing-operation" },
		{ groupId: "other-group", operationId: OPERATION_ID },
		{ groupId: "missing-group", operationId: OPERATION_ID },
	])("returns null for $groupId / $operationId without listing", async (input) => {
		// Arrange
		const { store, db } = setupStore(backend);
		try {
			await createOperationInvite(store);
			const listing = vi
				.spyOn(store, "listInvites")
				.mockRejectedValue(new Error("history forbidden"));

			// Act
			const result = await store.getInviteByOperationId(input.groupId, input.operationId);

			// Assert
			expect(result).toBeNull();
			expect(listing).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await store.close();
			if (db.open) db.close();
		}
	});

	it.each([
		{ groupId: GROUP_ID, operationId: OPERATION_ID, status: 200 },
		{ groupId: GROUP_ID, operationId: "missing-operation", status: 404 },
		{ groupId: "other-group", operationId: OPERATION_ID, status: 404 },
	])(
		"admin polling returns $status for $groupId / $operationId without enumerating history",
		async (input) => {
			// Arrange: the HTTP handler runs locally and cannot fetch external services.
			const { store, db } = setupStore(backend);
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
			try {
				await createOperationInvite(store);
				const listing = vi
					.spyOn(store, "listInvites")
					.mockRejectedValue(new Error("history forbidden"));
				const lookup = vi.spyOn(store, "getInviteByOperationId");
				const app = createCoordinatorApp({
					storeFactory: () => store,
					requestVerifier: vi.fn(async () => false),
					runtime: {
						adminSecret: () => "fixture-admin",
						now: () => "2026-10-01T00:00:00.000Z",
					},
				});

				// Act
				const response = await app.request(
					`/v1/admin/project-invites/${input.operationId}?group_id=${input.groupId}`,
					{ headers: { "X-Codemem-Coordinator-Admin": "fixture-admin" } },
				);
				const body = await response.json();

				// Assert
				expect(response.status).toBe(input.status);
				expect(lookup).toHaveBeenCalledExactlyOnceWith(input.groupId, input.operationId);
				expect(listing).not.toHaveBeenCalled();
				expect(fetch).not.toHaveBeenCalled();
				if (input.status === 404) {
					expect(body).toEqual({ error: "operation_not_found" });
				} else {
					expect(body).toEqual(PENDING_RESPONSE);
				}
			} finally {
				vi.restoreAllMocks();
				await store.close();
				if (db.open) db.close();
			}
		},
	);
});
