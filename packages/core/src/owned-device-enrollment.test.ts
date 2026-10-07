import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	insertOwnership,
	type OwnershipFixture,
	ownedRow,
	ownershipHarness,
} from "./coordinator-device-ownership-test-harness.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import { pendingJoin } from "./coordinator-join-revocation-test-harness.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import { recipientGuardedD1 } from "./coordinator-recipient-revocation-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";
import {
	aliasReplacement,
	OWNED_DENIAL,
	OWNED_UNAVAILABLE,
	ownedEnrollment,
	ownedGroup,
	registerOwnedEnrollmentContract,
	registerStoredKeyRaces,
	seedStoredOwnedAlias,
	storedOwnedAlias,
} from "./shared-owned-device-enrollment-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const forbiddenFetch = vi.fn(async () => {
	throw new Error("network forbidden");
});
beforeEach(() => {
	forbiddenFetch.mockClear();
	vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
	expect(forbiddenFetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

function fixture(f: ReturnType<typeof setupStore>): OwnershipFixture {
	return {
		store: f.store,
		exec: async (sql, ...values) => {
			f.db.prepare(sql).run(...values);
		},
		query: async (sql, ...values) => f.db.prepare(sql).all(...values),
	};
}
describe.each(["SQLite", "D1"] as const)("%s owned-device enrollment prerequisites", (backend) => {
	const databases = new WeakMap<OwnershipFixture, ReturnType<typeof setupStore>["db"]>();
	const test = ownershipHarness(async (use) => {
		const f = setupStore(backend);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			const o = fixture(f);
			databases.set(o, f.db);
			await use(o);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerOwnedEnrollmentContract(test);
	if (backend === "D1")
		registerStoredKeyRaces(test, (f, hook) => {
			const db = databases.get(f);
			if (!db) throw new Error("Missing fixture database");
			return recipientGuardedD1(sqliteD1(db), async (writes) => {
				if (writes.some(({ query }) => query.includes("INSERT INTO enrolled_devices")))
					await hook();
			});
		});
	for (const operation of ["enroll", "enable"] as const) {
		for (const subject of ["ID", "key"] as const) {
			test(`${operation} observes owned ${subject} inserted immediately before actual SQL`, async ({
				fixture: f,
			}) => {
				// Arrange: simulate an inactive future binding after key capture, never owner authorization.
				await f.store.createGroup(ownedGroup);
				await f.store.enrollDevice(ownedGroup, ownedEnrollment);
				await f.store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, false);
				const before = await f.query("SELECT * FROM enrolled_devices");
				const db =
					backend === "SQLite"
						? (
								f.store as ReturnType<typeof setupStore>["store"] & {
									db: ReturnType<typeof setupStore>["db"];
								}
							).db
						: undefined;
				// D1's adapter owns its DB in the outer fixture; install an equivalent hook below instead.
				if (!db) return await d1Interleaving(operation, subject);
				const prepare = db.prepare.bind(db);
				const binding = isolatedBinding(subject);
				const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
					if (isEnrollmentWrite(sql)) {
						prepare(
							"INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) VALUES (?,?,?,?,?,?,?,?)",
						).run(...Object.values(binding));
					}
					return prepare(sql);
				});
				try {
					// Act
					const pending = applyDirectWrite(f.store, operation);
					// Assert: SQLite may roll back the injected binding with the denied transaction.
					await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
					expect(prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
					expect(spy.mock.calls.some(([sql]) => isEnrollmentWrite(sql))).toBe(true);
				} finally {
					spy.mockRestore();
				}
			});
		}
	}
});

async function d1Interleaving(operation: "enroll" | "enable", subject: "ID" | "key") {
	const f = setupStore("D1");
	try {
		// Arrange
		await f.store.createGroup(ownedGroup);
		await f.store.enrollDevice(ownedGroup, ownedEnrollment);
		await f.store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, false);
		const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
		const beforeWrite = vi.fn((sql: string) => {
			if (
				!sql.includes("INSERT INTO enrolled_devices") &&
				!sql.includes("UPDATE enrolled_devices SET enabled")
			)
				return;
			f.db
				.prepare(
					"INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) VALUES (?,?,?,?,?,?,?,?)",
				)
				.run(
					...Object.values({
						...ownedRow,
						device_id: subject === "ID" ? ownedRow.device_id : "key-only-owner",
						key_id: subject === "ID" ? "b".repeat(64) : ownedRow.key_id,
					}),
				);
		});
		const store = new D1CoordinatorStore(sqliteD1(f.db, { beforeWrite }));
		// Act
		const pending =
			operation === "enroll"
				? store.enrollDevice(ownedGroup, ownedEnrollment)
				: store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, true);
		// Assert
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
		expect(beforeWrite).toHaveBeenCalled();
		expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
		expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toHaveLength(
			1,
		);
	} finally {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
}

it("SQLite observes captured current-key ownership inserted at its final upsert", async () => {
	// Arrange: only the stored key can match the future binding, not the incoming ID/key.
	const f = setupStore("SQLite");
	let spy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		await f.store.createGroup(ownedGroup);
		await f.store.enrollDevice(ownedGroup, storedOwnedAlias);
		const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
		const prepare = f.db.prepare.bind(f.db);
		spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
			if (sql.includes("INSERT INTO enrolled_devices"))
				prepare(
					"INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) VALUES (?,?,?,?,?,?,?,?)",
				).run(...Object.values(ownedRow));
			return prepare(sql);
		});
		// Act
		const pending = f.store.enrollDevice(ownedGroup, aliasReplacement);
		// Assert: the injected binding may roll back inside SQLite's transaction; enrollment must not change.
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
		expect(spy.mock.calls.some(([sql]) => sql.includes("INSERT INTO enrolled_devices"))).toBe(true);
		expect(prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
	} finally {
		spy?.mockRestore();
		await f.store.close();
	}
});

describe("D1 captured inputs and write receipts", () => {
	it("current public-key receipt cannot mutate during incoming key hashing", async () => {
		// Arrange: keep the actual stored owned key unchanged while mutating the returned row object.
		const f = setupStore("D1");
		let digestSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			await seedStoredOwnedAlias(fixture(f));
			const receipt = { public_key: ownedEnrollment.publicKey };
			const db = sqliteD1(f.db);
			const store = new D1CoordinatorStore({
				prepare(sql) {
					const statement = db.prepare(sql);
					if (sql.startsWith("SELECT public_key FROM enrolled_devices"))
						statement.first = async <T>() => receipt as T;
					return statement;
				},
			});
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
				receipt.public_key = UNRELATED_PUBLIC_KEY;
				return digest(algorithm, data);
			});
			const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
			// Act
			const pending = store.enrollDevice(ownedGroup, aliasReplacement);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(digestSpy).toHaveBeenCalled();
			expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
		} finally {
			digestSpy?.mockRestore();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	it("backend write failure exposes no raw database diagnostic", async () => {
		// Arrange
		const f = setupStore("D1");
		try {
			await f.store.createGroup(ownedGroup);
			const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
			const store = new D1CoordinatorStore(
				sqliteD1(f.db, {
					beforeWrite: () => {
						throw new Error("private database SQL diagnostic");
					},
				}),
			);
			// Act
			const pending = store.enrollDevice(ownedGroup, ownedEnrollment);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
			expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	it("captures caller options before asynchronous hashing without inferring ownership", async () => {
		// Arrange
		const f = setupStore("D1");
		try {
			await f.store.createGroup(ownedGroup);
			await insertOwnership(fixture(f));
			const options = { ...ownedEnrollment, deviceId: "unbound", publicKey: UNRELATED_PUBLIC_KEY };
			// Act
			const pending = f.store.enrollDevice(ownedGroup, options);
			Object.assign(options, ownedEnrollment);
			await pending;
			// Assert
			expect(await f.store.getEnrollment(ownedGroup, "unbound")).toMatchObject({
				public_key: UNRELATED_PUBLIC_KEY,
				enabled: 1,
			});
			expect(await f.store.getEnrollment(ownedGroup, ownedEnrollment.deviceId, true)).toBeNull();
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	it("cannot enable a stored public key that drifts after capture", async () => {
		// Arrange
		const f = setupStore("D1");
		try {
			await f.store.createGroup(ownedGroup);
			const target = { ...ownedEnrollment, deviceId: "unbound", publicKey: UNRELATED_PUBLIC_KEY };
			await f.store.enrollDevice(ownedGroup, target);
			await f.store.setDeviceEnabled(ownedGroup, target.deviceId, false);
			await insertOwnership(fixture(f));
			const beforeWrite = vi.fn((sql: string) => {
				if (sql.includes("UPDATE enrolled_devices SET enabled"))
					f.db
						.prepare("UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?")
						.run(ownedEnrollment.publicKey, target.deviceId);
			});
			const store = new D1CoordinatorStore(sqliteD1(f.db, { beforeWrite }));
			// Act
			const result = await store.setDeviceEnabled(ownedGroup, target.deviceId, true);
			// Assert
			expect(result).toBe(false);
			expect(beforeWrite).toHaveBeenCalled();
			expect(await f.store.getEnrollment(ownedGroup, target.deviceId, true)).toMatchObject({
				public_key: ownedEnrollment.publicKey,
				enabled: 0,
			});
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	for (const receipt of [
		{},
		{ success: false, meta: { changes: 1 } },
		{ meta: { changes: Number.NaN } },
		{ meta: { changes: Infinity } },
	]) {
		for (const operation of ["enroll", "enable"] as const) {
			it(`${operation} rejects unknown write receipt ${JSON.stringify(receipt)}`, async () => {
				// Arrange: corrupt only the returned receipt; inspect actual DB before claiming effects.
				const f = setupStore("D1");
				try {
					await f.store.createGroup(ownedGroup);
					await f.store.enrollDevice(ownedGroup, ownedEnrollment);
					await f.store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, false);
					const store = new D1CoordinatorStore(receiptDb(sqliteD1(f.db), receipt));
					// Act
					const pending =
						operation === "enroll"
							? store.enrollDevice(ownedGroup, ownedEnrollment)
							: store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, true);
					// Assert: successful underlying SQL cannot make an untrusted receipt successful.
					await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
					expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toEqual(
						[],
					);
				} finally {
					await f.store.close();
					if (f.db.open) f.db.close();
				}
			});
		}
	}
});
function receiptDb(db: D1DatabaseLike, receipt: unknown): D1DatabaseLike {
	return {
		prepare(sql) {
			const statement = db.prepare(sql);
			const wrapped: D1PreparedStatementLike = {
				...statement,
				bind(...values) {
					statement.bind(...values);
					return wrapped;
				},
				async run() {
					const result = await statement.run();
					if (
						sql.includes("INSERT INTO enrolled_devices") ||
						sql.includes("UPDATE enrolled_devices SET enabled")
					)
						return receipt as Awaited<ReturnType<D1PreparedStatementLike["run"]>>;
					return result;
				},
			};
			return wrapped;
		},
	};
}

describe.each([
	["SQLite", "enroll"],
	["D1", "enroll"],
	["SQLite", "enable"],
	["D1", "enable"],
] as const)("%s %s owned enrollment API errors", (backend, operation) => {
	for (const scenario of [
		"unbound",
		"owned",
		"stored owned",
		"unavailable",
		"wrong secret",
	] as const) {
		it(`${scenario} admin enrollment returns fixed private result after authentication`, async () => {
			// Arrange
			const f = setupStore(backend);
			const close = vi.spyOn(f.store, "close").mockResolvedValue();
			const factory = vi.fn(() => f.store);
			const app = createCoordinatorApp({
				storeFactory: factory,
				requestVerifier: vi.fn(async () => ({ ok: false, error: "invalid_signature" }) as const),
				runtime: {
					adminSecret: () => "disposable-test-credential",
					now: () => "2026-10-07T00:00:00.000Z",
				},
			});
			try {
				await f.store.createGroup(ownedGroup);
				await prepareApiEnrollment(f, operation);
				await prepareApiScenario(f, scenario);
				const incoming = apiIncoming(scenario);
				const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
				// Act
				const response = await app.request(
					operation === "enable" ? "/v1/admin/devices/enable" : "/v1/admin/devices",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Codemem-Coordinator-Admin":
								scenario === "wrong secret" ? "wrong" : "disposable-test-credential",
						},
						body: JSON.stringify({
							group_id: ownedGroup,
							device_id: incoming.deviceId,
							public_key: incoming.publicKey,
							fingerprint: fingerprintPublicKey(incoming.publicKey),
							identity_id: ownedEnrollment.identityId,
						}),
					},
				);
				// Assert
				expect(response.status).toBe(
					{ unbound: 200, owned: 403, "stored owned": 403, unavailable: 503, "wrong secret": 401 }[
						scenario
					],
				);
				await assertApiResult(response, scenario, factory);
				if (scenario !== "unbound")
					expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
			} finally {
				close.mockRestore();
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		});
	}
});

async function prepareApiEnrollment(f: ReturnType<typeof setupStore>, operation: string) {
	if (operation !== "enable") return;
	await f.store.enrollDevice(ownedGroup, ownedEnrollment);
	await f.store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, false);
}

describe("SQLite shared enrollment callers", () => {
	for (const operation of ["project", "join"] as const) {
		for (const owned of [false, true]) {
			it(`${operation} ${owned ? "denies retained ownership without consuming or approving" : "preserves ordinary acceptance"}`, async () => {
				// Arrange: only SQLite currently routes these callers through the guarded shared callee.
				const f = setupStore("SQLite");
				const o = fixture(f);
				const r = {
					store: f.store,
					input: { ...ownedEnrollment, groupId: ownedGroup, actorId: "fixture-operator" },
					exec: o.exec,
					rows: (table: string) => o.query(`SELECT * FROM ${table} ORDER BY rowid`),
				};
				try {
					const { project, join } = await prepareSharedCaller(r, operation);
					if (owned) await insertOwnership(o);
					const tables = [
						"enrolled_devices",
						"coordinator_invites",
						"coordinator_join_requests",
						"coordinator_bootstrap_grants",
					];
					const before = await Promise.all(tables.map(r.rows));
					// Act
					const pending = applySharedCaller(f.store, project, join);
					// Assert
					await assertSharedCaller(pending, owned, operation);
					if (owned) await assertSharedApiDenial(f.store, project, join);
					if (owned) expect(await Promise.all(tables.map(r.rows))).toEqual(before);
					else expect(await r.rows("coordinator_bootstrap_grants")).toHaveLength(1);
				} finally {
					await f.store.close();
				}
			});
		}
	}
});

function isEnrollmentWrite(sql: string) {
	return (
		sql.includes("INSERT INTO enrolled_devices") ||
		sql.includes("UPDATE enrolled_devices SET enabled = 1")
	);
}
function isolatedBinding(subject: "ID" | "key") {
	return {
		...ownedRow,
		device_id: subject === "ID" ? ownedRow.device_id : "key-only-owner",
		key_id: subject === "ID" ? "b".repeat(64) : ownedRow.key_id,
	};
}
function applyDirectWrite(
	store: ReturnType<typeof setupStore>["store"],
	operation: "enroll" | "enable",
) {
	if (operation === "enroll") return store.enrollDevice(ownedGroup, ownedEnrollment);
	return store.setDeviceEnabled(ownedGroup, ownedEnrollment.deviceId, true);
}
async function prepareApiScenario(f: ReturnType<typeof setupStore>, scenario: string) {
	if (scenario === "stored owned") await seedStoredOwnedAlias(fixture(f));
	if (scenario === "owned" || scenario === "wrong secret") await insertOwnership(fixture(f));
	if (scenario === "unavailable") f.db.exec("DROP TABLE coordinator_device_ownership_bindings");
}
function apiIncoming(scenario: string) {
	return scenario === "stored owned" ? aliasReplacement : ownedEnrollment;
}
async function prepareSharedCaller(r: Parameters<typeof projectInvite>[0], operation: string) {
	if (operation === "project") return { project: await projectInvite(r), join: undefined };
	return { project: undefined, join: await pendingJoin(r) };
}

async function assertApiResult(
	response: Response,
	scenario: string,
	factory: ReturnType<typeof vi.fn>,
) {
	if (scenario === "owned" || scenario === "stored owned")
		expect(await response.json()).toEqual({ error: OWNED_DENIAL });
	if (scenario === "unavailable")
		expect(await response.json()).toEqual({ error: OWNED_UNAVAILABLE });
	if (scenario === "unbound") expect(await response.json()).toEqual({ ok: true });
	if (scenario === "wrong secret") expect(factory).not.toHaveBeenCalled();
}
function applySharedCaller(
	store: ReturnType<typeof setupStore>["store"],
	project: Awaited<ReturnType<typeof projectInvite>> | undefined,
	join: Awaited<ReturnType<typeof pendingJoin>> | undefined,
) {
	if (project) return store.consumeProjectInvite(project.input);
	if (join) return store.reviewJoinRequest(join.options);
	throw new Error("Missing shared caller fixture");
}
async function assertSharedCaller(
	pending: ReturnType<typeof applySharedCaller>,
	owned: boolean,
	operation: string,
) {
	if (owned) {
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
		return;
	}
	expect(await pending).toMatchObject({
		status: operation === "project" ? "accepted" : "approved",
	});
}

async function assertSharedApiDenial(
	store: ReturnType<typeof setupStore>["store"],
	project: Awaited<ReturnType<typeof projectInvite>> | undefined,
	join: Awaited<ReturnType<typeof pendingJoin>> | undefined,
) {
	// Arrange: same unchanged invite/request must also get a fixed private HTTP error.
	const close = vi.spyOn(store, "close").mockResolvedValue();
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: {
			adminSecret: () => "disposable-test-credential",
			now: () => "2026-10-06T00:00:00.000Z",
		},
		requestVerifier: vi.fn(async () => ({ ok: false, error: "invalid_signature" }) as const),
	});
	const path = project ? "/v1/join" : "/v1/admin/join-requests/approve";
	const body = project
		? {
				token: project.input.token,
				operation_id: project.input.operationId,
				device_id: project.input.deviceId,
				public_key: project.input.publicKey,
				fingerprint: project.input.fingerprint,
				recipient_actor_id: project.input.recipientActorId,
				recipient_display_name: project.input.recipientDisplayName,
				device_display_name: project.input.deviceDisplayName,
			}
		: {
				request_id: join?.options.requestId,
				bootstrap_grant_seed_device_id: join?.seed.deviceId,
				bootstrap_grant_expires_at: join?.options.bootstrapGrant?.expiresAt,
			};
	try {
		// Act
		const response = await app.request(path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "disposable-test-credential",
			},
			body: JSON.stringify(body),
		});
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: OWNED_DENIAL });
	} finally {
		close.mockRestore();
	}
}
