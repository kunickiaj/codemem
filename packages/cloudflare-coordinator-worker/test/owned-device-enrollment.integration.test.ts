import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	insertOwnership,
	ownedRow,
	ownershipHarness,
} from "../../core/src/coordinator-device-ownership-test-harness.js";
import { recipientGuardedD1 } from "../../core/src/coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import {
	OWNED_DENIAL,
	ownedEnrollment,
	ownedGroup,
	registerOwnedEnrollmentContract,
} from "../../core/src/shared-owned-device-enrollment-test-harness.js";

describe("native D1 owned enrollment prerequisites (retained-binding fixtures, not owner proof)", () => {
	const test = ownershipHarness(async (use) => {
		await env.COORDINATOR_DB.prepare(
			"DROP TABLE IF EXISTS coordinator_device_ownership_bindings",
		).run();
		const migration = env.TEST_MIGRATIONS.find(
			(entry) => entry.name === "0028_add_device_ownership_bindings.sql",
		);
		if (!migration) throw new Error("Missing ownership fixture migration");
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: new D1CoordinatorStore(env.COORDINATOR_DB),
				exec: async (sql, ...values) => {
					await env.COORDINATOR_DB.prepare(sql)
						.bind(...values)
						.run();
				},
				query: async (sql, ...values) =>
					(
						await env.COORDINATOR_DB.prepare(sql)
							.bind(...values)
							.all()
					).results,
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_device_revocations"),
				env.COORDINATOR_DB.prepare(
					"DELETE FROM enrolled_devices WHERE group_id = 'owned-enrollment-group'",
				),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = 'owned-enrollment-group'"),
			]);
		}
	});
	registerOwnedEnrollmentContract(test);
	for (const operation of ["enroll", "enable"] as const) {
		for (const subject of ["ID", "key"] as const) {
			test(`${operation} actual native SQL denies ${subject} bound after capture`, async ({
				fixture: f,
			}) => {
				// Arrange: hook runs immediately before the actual native prepared write.
				await f.store.createGroup(ownedGroup);
				await f.store.enrollDevice(ownedGroup, ownedEnrollment);
				await f.store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, false);
				const before = await f.query("SELECT * FROM enrolled_devices");
				const binding = {
					...ownedRow,
					device_id: subject === "ID" ? ownedRow.device_id : "key-only-owner",
					key_id: subject === "ID" ? "b".repeat(64) : ownedRow.key_id,
				};
				const hook = vi.fn(async (writes: readonly { query: string }[]) => {
					if (
						writes.some(
							({ query }) =>
								query.includes("INSERT INTO enrolled_devices") ||
								query.includes("UPDATE enrolled_devices SET enabled"),
						)
					)
						await insertOwnership(f, binding);
				});
				const racing = recipientGuardedD1(env.COORDINATOR_DB, hook);
				// Act
				const pending =
					operation === "enroll"
						? racing.enrollDevice(ownedGroup, ownedEnrollment)
						: racing.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, true);
				// Assert
				await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
				expect(hook).toHaveBeenCalled();
				expect(await f.query("SELECT * FROM enrolled_devices")).toEqual(before);
				expect(await f.query("SELECT * FROM coordinator_device_ownership_bindings")).toEqual([
					binding,
				]);
			});
		}
	}
});
