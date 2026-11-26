import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	INVITE_REVOCATION_CLOCK_MS,
	inviteRevocationHarness,
	registerInviteRevocationContract,
} from "./coordinator-invite-revocation-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s invitation revocation contract", (backend) => {
	let sequence = 0;
	const test = inviteRevocationHarness(async (use) => {
		const f = setupStore(backend, { authClock: () => INVITE_REVOCATION_CLOCK_MS });
		try {
			await use({ store: f.store, prefix: `invite-revoke-${++sequence}` });
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerInviteRevocationContract(test);
});

describe("invitation revocation admin route", () => {
	let directory: string;
	let path: string;
	let inviteId: string;
	let consumedInviteId: string;
	let deviceInviteId: string;
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "invite-revoke-route-"));
		path = join(directory, "coordinator.sqlite");
		const store = new BetterSqliteCoordinatorStore(path);
		await store.createGroup("group-a");
		const create = () =>
			store.createInvite({
				groupId: "group-a",
				policy: "auto_admit",
				expiresAt: "2099-01-01T00:00:00Z",
			});
		inviteId = (await create()).invite_id;
		consumedInviteId = (await create()).invite_id;
		deviceInviteId = (await create()).invite_id;
		// Only the route's kind check matters here; the contract tests use real Team invitations.
		store.db
			.prepare(
				"UPDATE coordinator_invites SET invite_kind = 'team_member' WHERE invite_id IN (?, ?)",
			)
			.run(inviteId, consumedInviteId);
		store.db
			.prepare("UPDATE coordinator_invites SET consumed_at = 'then' WHERE invite_id = ?")
			.run(consumedInviteId);
		await store.close();
	});
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	const post = (
		body: unknown,
		headers: Record<string, string> = { "X-Codemem-Coordinator-Admin": "test-secret" },
	) =>
		createCoordinatorApp({
			storeFactory: () =>
				new BetterSqliteCoordinatorStore(path, { authClock: () => INVITE_REVOCATION_CLOCK_MS }),
			runtime: { adminSecret: () => "test-secret", now: () => "2026-11-26T12:00:00Z" },
			requestVerifier: async () => false,
		}).request("/v1/admin/invites/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});

	it("refuses a request without the admin secret and revokes nothing", async () => {
		expect((await post({ group_id: "group-a", invite_id: inviteId }, {})).status).toBe(401);
		const response = await post({ group_id: "group-a", invite_id: inviteId });
		expect(await response.json()).toMatchObject({ status: "revoked" });
	});

	it("revokes an invitation and then answers that it was already revoked", async () => {
		const revokedAt = new Date(INVITE_REVOCATION_CLOCK_MS).toISOString();
		const first = await post({ group_id: "group-a", invite_id: inviteId });
		const again = await post({ group_id: "group-a", invite_id: inviteId });

		expect([first.status, await first.json()]).toEqual([
			200,
			{ version: 1, status: "revoked", invite_id: inviteId, revoked_at: revokedAt },
		]);
		expect([again.status, await again.json()]).toEqual([
			200,
			{ version: 1, status: "already_revoked", invite_id: inviteId, revoked_at: revokedAt },
		]);
	});

	it("answers 409 for an accepted invitation and 404 for an unknown one", async () => {
		const consumed = await post({ group_id: "group-a", invite_id: consumedInviteId });
		const unknown = await post({ group_id: "group-a", invite_id: "unknown" });

		expect([consumed.status, await consumed.json()]).toEqual([409, { error: "invite_consumed" }]);
		expect([unknown.status, await unknown.json()]).toEqual([404, { error: "invite_not_found" }]);
	});

	it.each([
		["an older device invitation", null],
		["an add-device invitation", "add_device"],
	])("answers 409 for %s and leaves it open", async (_name, kind) => {
		const store = new BetterSqliteCoordinatorStore(path);
		store.db
			.prepare("UPDATE coordinator_invites SET invite_kind = ? WHERE invite_id = ?")
			.run(kind, deviceInviteId);
		await store.close();

		const response = await post({ group_id: "group-a", invite_id: deviceInviteId });

		expect([response.status, await response.json()]).toEqual([
			409,
			{ error: "invite_kind_unsupported" },
		]);
		const reread = new BetterSqliteCoordinatorStore(path);
		const [row] = (await reread.listInvites("group-a")).filter(
			(i) => i.invite_id === deviceInviteId,
		);
		await reread.close();
		expect(row?.revoked_at).toBeNull();
	});

	it.each([
		["malformed JSON", "{"],
		["an unknown field", { group_id: "group-a", invite_id: "x", reason: "r" }],
		["a missing invitation", { group_id: "group-a" }],
		["a padded group", { group_id: " group-a", invite_id: "x" }],
	])("refuses a body with %s", async (_name, body) => {
		const response = await post(body);

		expect([response.status, await response.json()]).toEqual([400, { error: "invalid_input" }]);
	});
});
