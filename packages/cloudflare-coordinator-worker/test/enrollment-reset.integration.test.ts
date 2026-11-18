import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import {
	changeEnrollmentKey,
	d1EnrollmentExec,
	deleteEnrollmentWithoutTombstone,
	enrollmentTestKeyId,
	seedEnrollment,
} from "../../core/src/coordinator-enrollment-test-fixtures.js";
import {
	dropEnrollmentRemovalTriggers,
	installEnrollmentRemovalTriggers,
} from "./device-removal-reset.js";
import { resetEnrollments } from "./enrollment-reset.js";

const db = env.COORDINATOR_DB;
const exec = d1EnrollmentExec(db);
const all = async (sql: string) => (await db.prepare(sql).all()).results;
const enrolled = () =>
	all("SELECT group_id, device_id FROM enrolled_devices ORDER BY group_id, device_id");
const triggers = () =>
	all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
const tombstone = (deviceId: string) =>
	db
		.prepare(`INSERT INTO coordinator_device_removals(removal_id, group_id, device_id,
			public_key, fingerprint, removed_at) VALUES ('raw', 'g9', ?, 'removed-key', 'fp', 'then')`)
		.bind(deviceId)
		.run();

afterAll(() => installEnrollmentRemovalTriggers(db));

describe.each(["absent", "installed"] as const)(
	"native D1 enrollment test helpers with the enrollment triggers %s",
	(state) => {
		async function arrange() {
			await dropEnrollmentRemovalTriggers(db);
			await resetEnrollments(db);
			if (state === "installed") await installEnrollmentRemovalTriggers(db);
			for (const groupId of ["g1", "g2"])
				for (const deviceId of ["d1", "d2"])
					await seedEnrollment(exec, { groupId, deviceId, publicKey: `opaque ${deviceId}` });
		}

		it("resetEnrollments clears the named enrollments and every tombstone", async () => {
			// Arrange
			await arrange();
			await tombstone("removed-elsewhere");
			const before = await triggers();
			// Act
			await resetEnrollments(db, "group_id = ?", "g1");
			// Assert: both tables are guarded again afterwards.
			expect(await enrolled()).toEqual([
				{ group_id: "g2", device_id: "d1" },
				{ group_id: "g2", device_id: "d2" },
			]);
			expect(await all("SELECT 1 FROM coordinator_device_removals")).toEqual([]);
			expect(await triggers()).toEqual(before);
			await tombstone("removed-again");
			await expect(db.prepare("DELETE FROM coordinator_device_removals").run()).rejects.toThrow(
				/device_removal_immutable/u,
			);
		});

		it("deletes an enrollment without a tombstone, changes a key, and seeds after a removal", async () => {
			// Arrange
			await arrange();
			await tombstone("removed-elsewhere");
			const before = await triggers();
			// Act
			await deleteEnrollmentWithoutTombstone(exec, "group_id = ? AND device_id = ?", "g1", "d1");
			await changeEnrollmentKey(exec, { publicKey: "opaque replaced" }, "device_id = ?", "d2");
			await seedEnrollment(exec, { groupId: "g1", deviceId: "d3", publicKey: "opaque d3" });
			// Assert
			expect(
				await all(
					"SELECT device_id, public_key, key_id FROM enrolled_devices WHERE group_id = 'g1' ORDER BY device_id",
				),
			).toEqual([
				{
					device_id: "d2",
					public_key: "opaque replaced",
					key_id: enrollmentTestKeyId("opaque replaced"),
				},
				{ device_id: "d3", public_key: "opaque d3", key_id: "" },
			]);
			expect(await all("SELECT device_id FROM coordinator_device_removals")).toEqual([
				{ device_id: "removed-elsewhere" },
			]);
			expect(await triggers()).toEqual(before);
			const rawDelete = db.prepare("DELETE FROM enrolled_devices WHERE device_id = 'd3'").run();
			if (state === "installed")
				await expect(rawDelete).rejects.toThrow(/enrollment_delete_requires_removal/u);
			else await expect(rawDelete).resolves.toBeDefined();
		});
	},
);
