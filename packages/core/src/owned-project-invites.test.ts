import { describe, expect, vi } from "vitest";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { ownedRow } from "./coordinator-device-ownership-test-harness.js";
import {
	type RevocationFixture,
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import { OWNED_DENIAL, OWNED_UNAVAILABLE } from "./shared-owned-device-enrollment-test-harness.js";
import {
	registerOwnedProjectContract,
	registerOwnedProjectD1,
	stageProject,
} from "./shared-owned-project-invites-test-harness.js";
import { ownedRecipientTables } from "./shared-owned-recipient-invites-test-harness.js";

describe.each(["SQLite", "D1"] as const)(
	"%s project ownership (raw ledger is not owner proof)",
	(backend) => {
		const databases = new WeakMap<RevocationFixture, ReturnType<typeof setupStore>>();
		const test = revocationHarness(async (use) => {
			const local = setupStore(backend);
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
			const f: RevocationFixture = {
				store: local.store,
				input: revocationInput(),
				exec: async (sql, ...values) => {
					local.db.prepare(sql).run(...values);
				},
				rows: async (table) => {
					if (!ownedRecipientTables.includes(table))
						throw new Error("Unknown project fixture table");
					return local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
				},
			};
			databases.set(f, local);
			try {
				await use(f);
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				fetch.mockRestore();
				await local.store.close();
				if (local.db.open) local.db.close();
			}
		});
		registerOwnedProjectContract(test, backend);
		if (backend === "SQLite") {
			for (const stage of ["first", "repair", "recovery"] as const) {
				for (const subject of ["ID", "key"] as const) {
					test(`SQLite final ${stage} write denies new ${subject} binding and rolls back`, async ({
						fixture: f,
					}) => {
						// Arrange: insert raw evidence inside the actual immediate transaction.
						const { input } = await stageProject(f, stage);
						const local = databases.get(f);
						if (!local) throw new Error("Missing project fixture database");
						const before = await Promise.all(ownedRecipientTables.map((t) => f.rows(t)));
						const prepare = local.db.prepare.bind(local.db);
						const gate = {
							first: "INSERT INTO enrolled_devices",
							repair: "UPDATE enrolled_devices SET identity_id",
							recovery: "UPDATE coordinator_invites SET bootstrap_grant_id",
						}[stage];
						let injected = false;
						const row = gateOwnershipRow({
							identityId: input.recipientActorId,
							deviceId: input.deviceId,
							subject,
						});
						const spy = vi.spyOn(local.db, "prepare").mockImplementation((sql) => {
							if (!injected && sql.includes(gate)) {
								injected = true;
								const columns = Object.keys(row);
								prepare(
									`INSERT INTO coordinator_device_ownership_bindings (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
								).run(...Object.values(row));
							}
							return prepare(sql);
						});
						function gateOwnershipRow(options: {
							identityId: string;
							deviceId: string;
							subject: string;
						}) {
							return {
								...ownedRow,
								identity_id: options.identityId,
								device_id: options.subject === "ID" ? options.deviceId : "retained-other-device",
								key_id: options.subject === "ID" ? "b".repeat(64) : ownedRow.key_id,
							};
						}
						try {
							// Act
							const pending = f.store.consumeProjectInvite(input);
							// Assert: real rollback includes the injected ledger row.
							await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
							expect(injected).toBe(true);
							spy.mockRestore();
							expect(await Promise.all(ownedRecipientTables.map((t) => f.rows(t)))).toEqual(before);
						} finally {
							spy.mockRestore();
						}
					});
				}
			}
		}
		if (backend === "D1")
			registerOwnedProjectD1(test, (f) => {
				const local = databases.get(f);
				if (!local) throw new Error("Missing project fixture database");
				return sqliteD1(local.db);
			});
		if (backend === "D1")
			test("D1 zero changes winner chain fails closed without partial rows", async ({
				fixture: f,
			}) => {
				// Arrange: override only the SQLite-backed shim after fixture setup.
				const { input } = await stageProject(f, "first");
				const local = databases.get(f);
				if (!local) throw new Error("Missing project fixture database");
				local.db.function("changes", () => 0);
				const before = await Promise.all(ownedRecipientTables.map((table) => f.rows(table)));
				// Act
				const pending = f.store.consumeProjectInvite(input);
				// Assert: consumption, enrollment, and grant writes all remain absent.
				await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
				expect(await Promise.all(ownedRecipientTables.map((table) => f.rows(table)))).toEqual(
					before,
				);
			});
	},
);
