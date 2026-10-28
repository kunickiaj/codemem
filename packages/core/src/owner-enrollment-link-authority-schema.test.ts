import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	applyAccountConnectionSchema,
	CoordinatorAuthSchemaUpgradeRequiredError,
} from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { withCoordinatorAuthSchema } from "./coordinator-auth-schema.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS } from "./coordinator-owner-enrollment-qualification-schema.js";
import { COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL } from "./coordinator-owner-enrollment-schema.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { readOwnerLinkAuthority } from "./owner-enrollment-link-authority.js";

let f: ReturnType<typeof setupStore>;
let backend: AuthLinkBackend;
let calls: AuthLinkStatement[];
beforeEach(() => {
	f = setupStore("SQLite");
	f.db.exec(COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL);
	for (const sql of COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS) f.db.exec(sql);
	calls = [];
	const raw = nativeBackend(f.db);
	backend = {
		...raw,
		first: (statement) => {
			calls.push(statement);
			return raw.first(statement);
		},
	};
});
afterEach(() => {
	f.db.close();
	vi.restoreAllMocks();
});

it("uses the wrapper's fresh raw capability and executes eight SQLite reads on ready storage", async () => {
	// Arrange: count executed backend reads, not SQL preparations or nested wrapper calls.
	await applyAccountConnectionSchema(backend);
	const wrapped = withCoordinatorAuthSchema(backend);
	const capability = vi.spyOn(wrapped, "readAuthSchemaState");
	calls.length = 0;
	// Act
	const authority = await readOwnerLinkAuthority(wrapped, 100);
	// Assert: two raw schema reads replace six recursively wrapped schema reads.
	expect(capability).toHaveBeenCalledTimes(1);
	expect(calls).toHaveLength(8);
	expect(authority.with).toContain("owner_qualified_links");
});

it.each(["v2", "ready"] as const)(
	"falls back to a fresh schema read without a capability on %s storage",
	async (state) => {
		// Arrange
		if (state === "ready") await applyAccountConnectionSchema(backend);
		calls.length = 0;
		// Act
		const authority = await readOwnerLinkAuthority(backend, 100);
		// Assert: legacy V2 never gains device-claim qualification authority.
		expect(calls).toHaveLength(state === "ready" ? 4 : 2);
		expect(authority.hasPin).toBe(true);
		expect(authority.with.includes("owner_qualified_links")).toBe(state === "ready");
	},
);

it.each([
	"DROP TRIGGER account_change_birth",
	"DROP TABLE coordinator_auth_account_connection_history",
	"DROP TRIGGER account_change_birth; CREATE TRIGGER account_change_birth BEFORE INSERT ON coordinator_account_change_attempts BEGIN SELECT 1; END",
])("rechecks raw readiness and rejects schema drift after a successful read: %s", async (sql) => {
	// Arrange: the same wrapper must not cache the earlier ready result.
	await applyAccountConnectionSchema(backend);
	const wrapped = withCoordinatorAuthSchema(backend);
	expect((await readOwnerLinkAuthority(wrapped, 100)).with).toContain("owner_qualified_links");
	f.db.exec(sql);
	// Act
	const result = readOwnerLinkAuthority(wrapped, 101);
	// Assert: malformed optional storage must not silently become legacy authority.
	await expect(result).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
});

it.each([
	"DROP TRIGGER owner_enrollment_qualification_immutable_update",
	"DROP TRIGGER owner_enrollment_authority_update",
	"DROP TRIGGER owner_enrollment_qualification_immutable_update; CREATE TRIGGER owner_enrollment_qualification_immutable_update BEFORE UPDATE ON coordinator_owner_enrollment_qualifications BEGIN SELECT 1; END",
])("rechecks qualification definitions on every call: %s", async (sql) => {
	// Arrange
	await applyAccountConnectionSchema(backend);
	const wrapped = withCoordinatorAuthSchema(backend);
	const capability = vi.spyOn(wrapped, "readAuthSchemaState");
	expect((await readOwnerLinkAuthority(wrapped, 100)).with).toContain("owner_qualified_links");
	f.db.exec(sql);
	// Act
	const authority = await readOwnerLinkAuthority(wrapped, 101);
	// Assert: a valid connection schema cannot substitute for current qualification guards.
	expect(capability).toHaveBeenCalledTimes(2);
	expect(authority.with).not.toContain("owner_qualified_links");
	expect(authority.qualification).toBe("NULL");
});

it("rejects incomplete connection storage through the no-capability fallback", async () => {
	// Arrange
	await applyAccountConnectionSchema(backend);
	f.db.exec("DROP TRIGGER account_change_birth");
	// Act
	const result = readOwnerLinkAuthority(backend, 100);
	// Assert
	await expect(result).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
});
