// Runs under `node --import <test-process-isolation.ts> --import tsx --test`, started by
// test-process-isolation.test.ts with only PATH and a decoy HOME in its environment.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { resolveDbPath } from "./db.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { resolveKeyPaths } from "./sync-identity.js";
import { initTestSchema, seedMixedScopeFixture } from "./test-utils.js";

const accountHome = resolve(userInfo().homedir);
const decoyHome = process.env.DECOY_HOME ?? "";

test("the preload points HOME at a temporary home of this process", () => {
	const home = resolve(process.env.HOME ?? "");
	assert.notEqual(home, resolve(decoyHome));
	assert.ok(home.startsWith(resolve(tmpdir())), "HOME is temporary");
	assert.ok(!home.startsWith(accountHome), "HOME is not the account's home");
	assert.equal(process.env.CODEMEM_TEST_ISOLATION, "1");
	assert.equal(process.env.CODEMEM_SYNC_KEY_STORE, "file");
});

test("a fixture refresh with CODEMEM_KEYS_DIR deleted writes its mark under the temporary home", async () => {
	delete process.env.CODEMEM_KEYS_DIR;
	const keysDir = join(process.env.HOME ?? "", ".config", "codemem", "keys");
	assert.equal(resolveKeyPaths()[0], join(keysDir, "device.key"));
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		const fixture = seedMixedScopeFixture(db);

		await refreshTestScopeRows(db, { [fixture.deviceId]: CANONICAL_PUBLIC_KEY });

		assert.ok(existsSync(keysDir) && readdirSync(keysDir).length > 0, "the mark is in the temp home");
	} finally {
		db.close();
	}
});

test("the real-path guard refuses the account's own store and keys", () => {
	// Resolved only, never opened.
	assert.throws(
		() => resolveDbPath(join(accountHome, ".codemem", "guard-test-never-opened.sqlite")),
		/A test tried to use the real codemem store/u,
	);
	assert.throws(
		() => resolveKeyPaths(join(accountHome, ".config", "codemem", "keys")),
		/A test tried to use the real codemem keys directory/u,
	);
});
