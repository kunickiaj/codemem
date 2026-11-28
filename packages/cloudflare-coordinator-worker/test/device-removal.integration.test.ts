import { d1EnrollmentExec } from "../../core/src/coordinator-enrollment-test-fixtures.js";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import {
	ENROLLMENT_REMOVAL_MIGRATION_NAME,
	ENROLLMENT_REMOVAL_TRIGGERS,
	ENROLLMENT_REMOVAL_TRIGGERS_READINESS_SQL,
	storedTriggerSql,
} from "../../core/src/coordinator-device-removal.js";
import {
	invitationFixture,
	enroll,
	REMOVAL_CLOCK_MS,
	registerDeviceRemovalContract,
	removalDeviceKey,
	removalHarness,
	target,
} from "../../core/src/coordinator-device-removal-test-harness.js";
import { registerDeviceRemovalDependentsContract } from "../../core/src/coordinator-device-removal-dependents-test-harness.js";
import { registerDeviceRemovalListContract } from "../../core/src/coordinator-device-removal-list-test-harness.js";
import { registerMembershipEnrollmentContract } from "../../core/src/coordinator-membership-enrollment-test-harness.js";
import { registerPeerRemovalQueryContract } from "../../core/src/coordinator-peer-removal-query-test-harness.js";
import { registerDeviceRemovalCommitContract } from "../../core/src/coordinator-device-removal-commit-test-harness.js";
import { registerDeviceRemovalPreviewContract } from "../../core/src/coordinator-device-removal-preview-test-harness.js";
import { registerEnrollmentWriterContract } from "../../core/src/coordinator-device-removal-writer-test-harness.js";
import { projectInvite } from "../../core/src/coordinator-project-revocation-test-harness.js";
import {
	recipientGuardedD1,
	recipientInvite,
} from "../../core/src/coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import {
	dropEnrollmentRemovalTriggers,
	installEnrollmentRemovalTriggers,
	resetDeviceRemovals,
} from "./device-removal-reset.js";

const ready = () =>
	env.COORDINATOR_DB.prepare(ENROLLMENT_REMOVAL_TRIGGERS_READINESS_SQL).first<number>("ready");

// First in the file, so the database is still as the migrations created it.
it("migration 0049 installs each enrollment trigger with the shared definition", async () => {
	// Arrange
	const migration = env.TEST_MIGRATIONS.find(
		({ name }) => name === ENROLLMENT_REMOVAL_MIGRATION_NAME,
	);
	// Act
	const stored = await env.COORDINATOR_DB.prepare(
		"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'enrolled_devices_%' ORDER BY name",
	).all<{ name: string; sql: string }>();
	// Assert: nine statements, and nine triggers with exactly those definitions.
	expect(migration?.queries.map(storedTriggerSql)).toEqual(
		ENROLLMENT_REMOVAL_TRIGGERS.map(({ sql }) => storedTriggerSql(sql)),
	);
	expect(
		stored.results.map(({ name, sql }) => ({ name, sql: storedTriggerSql(sql) })),
	).toEqual(
		ENROLLMENT_REMOVAL_TRIGGERS.map(({ name, sql }) => ({ name, sql: storedTriggerSql(sql) })).sort(
			(a, b) => a.name.localeCompare(b.name),
		),
	);
	expect(stored.results).toHaveLength(9);
	expect(await ready()).toBe(1);
});

let sequence = 0;
describe("native D1 device removal", () => {
	const test = removalHarness(async (use) => {
		const db = env.COORDINATOR_DB;
		await resetDeviceRemovals(db, env.TEST_MIGRATIONS);
		const store = new D1CoordinatorStore(db, { authClock: () => REMOVAL_CLOCK_MS });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				prefix: `removal-native-${++sequence}`,
				exec: async (sql, ...values) => {
					await db.prepare(sql).bind(...values).run();
				},
				rows: async <T>(sql: string, ...values: unknown[]) =>
					(await db.prepare(sql).bind(...values).all<T>()).results,
				interleave: (before, change) => {
					let done = false;
					return recipientGuardedD1(db, async (writes) => {
						if (done || !writes.some(({ query }) => before.some((text) => query.includes(text))))
							return;
						done = true;
						await change(d1EnrollmentExec(db));
					});
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	registerDeviceRemovalContract(test);
	registerEnrollmentWriterContract(test);
	registerDeviceRemovalPreviewContract(test);
	registerDeviceRemovalDependentsContract(test);
	registerDeviceRemovalCommitContract(test);
	registerDeviceRemovalListContract(test);
	registerMembershipEnrollmentContract(test);
	registerPeerRemovalQueryContract(test);
	test("D5 serves the admin removal listing from native D1", async ({ fixture: f }) => {
		const removed = await target(f);
		await enroll(f, removed);
		expect(await f.store.removeDevice(removed.groupId, removed.deviceId)).toBe(true);
		const adminSecret = "removal-list-test-secret";
		const app = createCoordinatorApp({
			storeFactory: () => f.store,
			runtime: { adminSecret: () => adminSecret, now: () => new Date(REMOVAL_CLOCK_MS).toISOString() },
			requestVerifier: () => false,
			requestRateLimit: { readLimit: 1 },
		});
		const url = `/v1/admin/devices/removals?device_id=${removed.deviceId}`;
		expect((await app.request(url)).status).toBe(401);
		const headers = { "X-Codemem-Coordinator-Admin": adminSecret };
		const response = await app.request(url, { headers });
		const page = await response.json<{ items: unknown[] }>();
		expect(response.status).toBe(200);
		expect(page).toMatchObject({
			version: 1,
			items: [{ device_id: removed.deviceId, group_id: removed.groupId, key_id: removed.key.keyId }],
			next_before_seq: null,
		});
		expect(page.items[0]).not.toHaveProperty("public_key");
		expect((await app.request(url, { headers })).status).toBe(429);
	});
	test("native peer lookup uses two reads with one JSON parameter for 0, 1 and 25 entries", async ({ fixture: f }) => {
		const prepare = vi.spyOn(env.COORDINATOR_DB, "prepare");
		try {
			for (const count of [0, 1, 25]) {
				prepare.mockClear();
				await f.store.lookupPeerRemovals({ peers: Array.from({ length: count }, (_, i) => ({ deviceId: `d${i}` })) });
				expect(prepare.mock.calls).toHaveLength(2);
				expect(prepare.mock.calls.map(([sql]) => sql.match(/\?/gu)?.length ?? 0)).toEqual([0, 1]);
			}
		} finally { prepare.mockRestore(); }
	});

	test("between migrations 0048 and 0049 an enrollment stores its key ID and cannot be removed", async ({
		fixture: f,
	}) => {
		// Arrange
		const key = await removalDeviceKey(`${f.prefix}-between`);
		const enrollment = { groupId: `${f.prefix}-g1`, deviceId: `${f.prefix}-d1` };
		await dropEnrollmentRemovalTriggers(env.COORDINATOR_DB);
		try {
			await f.store.createGroup(enrollment.groupId);
			await f.store.enrollDevice(enrollment.groupId, { deviceId: enrollment.deviceId, ...key });
			// Act: each refusal gets its handler at once, so neither is reported unhandled.
			const between = await ready();
			const removal = expect(f.store.removeEnrollment(enrollment)).rejects.toThrow(
				"device_removal_unavailable",
			);
			const preview = expect(
				f.store.previewDeviceRemoval({ deviceIds: [enrollment.deviceId] }),
			).rejects.toThrow("device_removal_unavailable");
			// Assert
			expect(between).toBe(0);
			await removal;
			await preview;
			expect(
				await f.rows("SELECT key_id FROM enrolled_devices WHERE device_id = ?", enrollment.deviceId),
			).toEqual([{ key_id: key.keyId }]);
		} finally {
			await installEnrollmentRemovalTriggers(env.COORDINATOR_DB);
		}
		expect(await f.store.removeEnrollment(enrollment)).toMatchObject({ kind: "removed" });
	});

	for (const family of ["recipient", "Project"] as const) {
		// Native D1 gives no view between the statements of a batch, so this reads the
		// statement itself. The core suite observes the same statement change no row.
		test(`statement 3 of a first ${family} acceptance carries the binding and the bound eligibility`, async ({
			fixture: f,
		}) => {
			// Arrange
			const key = await removalDeviceKey(`${f.prefix}-joining`);
			const invitation = invitationFixture(f, "statement-three", key);
			const { input } =
				family === "recipient"
					? await recipientInvite(invitation, "team_member")
					: await projectInvite(invitation);
			const consumes: { query: string; values: readonly unknown[] }[] = [];
			const recording = recipientGuardedD1(env.COORDINATOR_DB, async (writes, kind) => {
				if (kind !== "batch") return;
				consumes.push(
					...writes.filter(({ query }) => query.includes("UPDATE coordinator_invites SET token")),
				);
			});
			// Act
			const result =
				"inviteKind" in input
					? await recording.consumeRecipientInvite(input)
					: await recording.consumeProjectInvite(input);
			// Assert: the rewrite branch is everything between changes() and the unconsumed branch.
			expect(result.status).toBe("accepted");
			expect(consumes).toHaveLength(2);
			const statement = (consumes[1]?.query ?? "").replace(/\s+/gu, " ");
			const rewrite = statement.slice(
				statement.indexOf("(changes() = 1 AND"),
				statement.indexOf("OR (consumed_at IS NULL"),
			);
			for (const condition of [
				"consumed_at IS NOT NULL AND revoked_at IS NULL",
				"bound_device_id = ? AND bound_public_key = ? AND bound_fingerprint = ? AND recipient_actor_id = ?",
				"g.archived_at IS NULL",
				"coordinator_device_revocations",
				"coordinator_device_ownership_bindings",
				"bi.bound_public_key = ?",
			])
				expect(rewrite).toContain(condition);
			expect(consumes[1]?.values).toEqual(
				expect.arrayContaining([input.deviceId, input.publicKey, input.fingerprint]),
			);
		});
	}
});
