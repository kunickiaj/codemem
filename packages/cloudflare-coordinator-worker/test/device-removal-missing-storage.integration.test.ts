import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	DEVICE_REMOVAL_MIGRATION_NAME,
	hasDeviceRemovalSchema,
} from "../../core/src/coordinator-device-removal.js";
import { revocationInput } from "../../core/src/coordinator-device-revocation-test-harness.js";
import { projectInvite } from "../../core/src/coordinator-project-revocation-test-harness.js";
import { recipientInvite } from "../../core/src/coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { resetNativeAuthStage } from "./native-auth-stage.js";

// A deployment on the current auth stage that has applied every migration except 0048.
beforeAll(async () => {
	await resetNativeAuthStage("prior_extension");
	await applyD1Migrations(
		env.COORDINATOR_DB,
		// Neither the storage migration nor a later one that builds on it.
		env.TEST_MIGRATIONS.filter(({ name }) => name < DEVICE_REMOVAL_MIGRATION_NAME),
	);
});

describe("native D1 without device removal storage", () => {
	const db = env.COORDINATOR_DB;
	it("D6 removal listing is unavailable before migration 0048", async () => {
		await expect(new D1CoordinatorStore(db).listDeviceRemovals()).rejects.toThrow(
			"device_removal_unavailable",
		);
	});
	const fixture = (name: string) => ({
		store: new D1CoordinatorStore(db),
		input: revocationInput(`no-storage-${name}`),
		exec: async (sql: string, ...values: unknown[]) => {
			await db.prepare(sql).bind(...values).run();
		},
		rows: async (table: string) => (await db.prepare(`SELECT * FROM ${table}`).all()).results,
	});

	it.each([
		["recipient", "new"],
		["recipient", "enrolled"],
		["Project", "new"],
		["Project", "enrolled"],
	] as const)("accepts a %s invitation for a device that is %s, in rows of the earlier shape", async (family, state) => {
		// Arrange
		const f = fixture(`${family}-${state}`.toLowerCase());
		expect(
			await hasDeviceRemovalSchema({ first: ({ sql }) => db.prepare(sql).first() }),
		).toBe(false);
		await db.prepare("DELETE FROM coordinator_invites").run();
		const { input, invite } =
			family === "recipient"
				? await recipientInvite(f, "team_member")
				: await projectInvite(f);
		if (state === "enrolled") await f.store.enrollDevice(invite.group_id, input);
		// Act: the insert form for a new device, the update form for an enrolled one.
		const result =
			"inviteKind" in input
				? await f.store.consumeRecipientInvite(input)
				: await f.store.consumeProjectInvite(input);
		// Assert
		expect(result.status).toBe("accepted");
		const { results } = await db
			.prepare("SELECT * FROM enrolled_devices WHERE group_id = ? AND device_id = ?")
			.bind(invite.group_id, input.deviceId)
			.all<Record<string, unknown>>();
		expect(results).toMatchObject([{ public_key: input.publicKey, enabled: 1 }]);
		expect(results.every((row) => row.identity_id !== null && !("key_id" in row))).toBe(true);
	});
});
