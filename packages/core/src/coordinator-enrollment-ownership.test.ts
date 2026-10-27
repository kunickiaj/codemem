import { afterEach, describe, expect, it } from "vitest";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";
import { commitDeviceRebind } from "./coordinator-device-rebind-commit.js";
import {
	GROUPS,
	type RebindFixture,
	rebindFixture,
	TARGET,
} from "./coordinator-device-rebind-test-fixtures.js";

let f: RebindFixture;
afterEach(async () => {
	await f?.close();
});

const ownership = async () =>
	(await f.store.listEnrolledDevices(GROUPS[0])).map((row) => row.ownership_identity_id);

describe.each<Backend>(["SQLite", "D1"])("%s enrollment ownership for admins", (kind) => {
	it("names the Identity a rebind bound the device's key to", async () => {
		// Arrange
		f = await rebindFixture(kind);
		const before = await ownership();
		// Act
		await commitDeviceRebind(f.input());
		// Assert
		expect(before).toEqual([undefined]);
		expect(await ownership()).toEqual([TARGET]);
	});

	it("says nothing when the binding is for another key", async () => {
		// Arrange
		f = await rebindFixture(kind);
		await commitDeviceRebind(f.input());
		// Act: the device re-enrolls in this group with a new key.
		f.db
			.prepare("UPDATE enrolled_devices SET public_key = ? WHERE group_id = ?")
			.run(`ssh-ed25519 ${Buffer.alloc(51, 1).toString("base64")}`, GROUPS[0]);
		// Assert
		expect(await ownership()).toEqual([undefined]);
	});
});
