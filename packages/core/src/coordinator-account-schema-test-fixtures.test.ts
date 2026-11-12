import { expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	CoordinatorAuthSchemaUpgradeRequiredError,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import { setupV2Store } from "./coordinator-account-schema-sqlite-test-fixtures.js";
import { useCurrentAccountSchema } from "./coordinator-account-schema-test-fixtures.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";

it("keeps a V2 coordinator file on V2 across reopening as an existing file", async () => {
	// Arrange
	const f = setupV2Store();
	await f.store.close();
	// Act
	const reopened = new BetterSqliteCoordinatorStore(f.path, { existingOnly: true });
	try {
		// Assert
		expect(await reopened.readAccountConnectionSchemaState()).toBe("v2");
	} finally {
		await reopened.close();
	}
});

it("brings a V2 coordinator to the current account schema through the installer", async () => {
	// Arrange
	const f = setupV2Store();
	const backend = nativeBackend(f.db);
	// Act
	await useCurrentAccountSchema(backend);
	await useCurrentAccountSchema(backend);
	// Assert
	expect(await readConnectionSchemaState(backend)).toBe("ready");
	expect(await f.store.getAccountChanges()).toBeDefined();
	await f.store.close();
});

it("refuses a partial account schema without writing", async () => {
	// Arrange
	const f = setupV2Store();
	const backend = nativeBackend(f.db);
	await useCurrentAccountSchema(backend);
	f.db.exec("DROP TRIGGER account_change_birth");
	const before = f.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
	// Act
	const result = useCurrentAccountSchema(backend);
	// Assert
	await expect(result).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
	expect(f.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
	await f.store.close();
});
