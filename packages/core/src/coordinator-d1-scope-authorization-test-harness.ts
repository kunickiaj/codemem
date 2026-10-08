import { expect, vi } from "vitest";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	MALFORMED_KEYS,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import type {
	contractHarness,
	GrantFixture,
} from "./coordinator-identity-group-grant-test-harness.js";
import { hashGuard } from "./coordinator-peer-discovery-revocation-test-harness.js";
import { READ_SCOPE_AUTHORIZATION_SQL } from "./coordinator-scope-authorization.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "./d1-coordinator-store.js";

type Test = ReturnType<typeof contractHarness>;
type Database = (f: GrantFixture) => D1DatabaseLike;
const unavailable = { kind: "rejected", error: "scope_authorization_unavailable" };
export const scopeTables = [
	"coordinator_scopes",
	"coordinator_scope_memberships",
	"coordinator_scope_membership_audit_log",
	"coordinator_scope_membership_effect_receipts",
	"enrolled_devices",
	"coordinator_device_revocations",
];
const scopeId = (f: GrantFixture) => `${f.review.groupId}-scope`;
const deviceId = (f: GrantFixture, suffix: string) => `${f.review.deviceId}-${suffix}`;
const input = (f: GrantFixture) => ({ groupId: f.review.groupId, scopeId: scopeId(f) });

async function addMember(f: GrantFixture, suffix: string) {
	const id = deviceId(f, suffix);
	await f.store.enrollDevice(f.review.groupId, {
		deviceId: id,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "untrusted-display-fingerprint",
	});
	await f.store.grantScopeMembership({
		scopeId: scopeId(f),
		deviceId: id,
		effectId: `${id}-grant`,
		membershipEpoch: 2,
		manifestIssuerDeviceId: "fixture-issuer",
		manifestHash: "fixture-manifest",
	});
}
async function seed(f: GrantFixture) {
	await f.store.createGroup(f.review.groupId);
	await f.store.createScope({
		...input(f),
		coordinatorId: f.review.coordinatorId,
		label: "Scope",
		membershipEpoch: 2,
		manifestIssuerDeviceId: "fixture-issuer",
		manifestHash: "fixture-manifest",
	});
	for (const name of ["a", "b"]) await addMember(f, name);
}
async function authorize(f: GrantFixture, store = f.store) {
	return store.getScopeAuthorization(input(f));
}
function expectIds(
	result: Awaited<ReturnType<typeof authorize>>,
	f: GrantFixture,
	suffixes: string[],
) {
	expect(result.kind).toBe("authorized");
	if (result.kind !== "authorized") throw new Error("Expected authorized snapshot");
	expect(result.members.map((m) => m.membership.device_id)).toEqual(
		suffixes.map((s) => deviceId(f, s)).sort(),
	);
}
async function history(f: GrantFixture) {
	return Promise.all(scopeTables.map((table) => f.rows(table)));
}
async function update(
	f: GrantFixture,
	table: string,
	field: string,
	value: unknown,
	options: { member?: boolean } = {},
) {
	await f.exec(
		`UPDATE ${table} SET ${field} = ? WHERE ${options.member ? "device_id" : "scope_id"} = ?`,
		value,
		options.member ? deviceId(f, "a") : scopeId(f),
	);
}
async function tombstone(f: GrantFixture, kind: "device_id" | "ed25519_key") {
	await f.exec(
		"INSERT INTO coordinator_device_revocations(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?)",
		kind,
		kind === "device_id" ? deviceId(f, "a") : EXPECTED_KEY_ID,
		`${scopeId(f)}-${kind}`,
		f.review.groupId,
		deviceId(f, "a"),
		CANONICAL_PUBLIC_KEY,
		"fixture-fingerprint",
		"2026-01-01",
	);
}

// Instrument the actual D1 statement, preserving its SQL, bindings and read method.
export function scopeReadWrapper(
	db: D1DatabaseLike,
	hooks: {
		beforeFinal?: (values: readonly unknown[]) => Promise<void>;
		receipt?: (sql: string, receipt: unknown, method: "all" | "first") => unknown;
	},
): D1DatabaseLike {
	let fired = false;
	return {
		...db,
		prepare(sql) {
			const wrap = (
				statement: ReturnType<D1DatabaseLike["prepare"]>,
				values: readonly unknown[] = [],
			): typeof statement => {
				const before = async () => {
					if (sql === READ_SCOPE_AUTHORIZATION_SQL && !fired) {
						fired = true;
						await hooks.beforeFinal?.(values);
					}
				};
				return {
					...statement,
					bind: (...bound) => wrap(statement.bind(...bound), bound),
					run: () => statement.run(),
					async first<T>() {
						await before();
						const receipt = await statement.first<T>();
						return (hooks.receipt ? hooks.receipt(sql, receipt, "first") : receipt) as T | null;
					},
					async all<T>() {
						await before();
						const receipt = await statement.all<T>();
						return (hooks.receipt ? hooks.receipt(sql, receipt, "all") : receipt) as typeof receipt;
					},
				};
			};
			return wrap(db.prepare(sql));
		},
	};
}

export function registerScopeContract(test: Test) {
	registerScopeDtos(test);
	registerScopeSources(test);
	registerMemberSources(test);
	registerEnrollmentKeys(test);
	registerPresentation(test);
	registerInputAndStorage(test);
}
function registerScopeDtos(test: Test) {
	test("returns exact version 1 DTOs sorted by member ID without changing raw history", async ({
		fixture: f,
	}) => {
		// Arrange: coordinator membership is not account or owner proof.
		await seed(f);
		const before = await history(f);
		const [scope] = await f.store.listScopes({ groupId: f.review.groupId });
		const memberships = await f.store.listScopeMemberships(scopeId(f), true);
		const enrollments = await f.store.listEnrolledDevices(f.review.groupId);
		// Act
		const result = await authorize(f);
		// Assert
		expect(result).toEqual({
			kind: "authorized",
			authorizationVersion: 1,
			scope,
			members: memberships.map((membership) => ({
				membership,
				enrollment: enrollments.find((e) => e.device_id === membership.device_id),
				keyId: EXPECTED_KEY_ID,
			})),
		});
		expect(await history(f)).toEqual(before);
	});
	test.for(ACCEPTED_ALIASES)(
		"canonical alias $name is positive before and excluded by key-only revocation",
		async ({ publicKey }, { fixture: f }) => {
			// Arrange: native-supported wire aliases only; Node-only aliases have separate fixtures.
			await seed(f);
			await update(f, "enrolled_devices", "public_key", publicKey, { member: true });
			const before = await authorize(f);
			await tombstone(f, "ed25519_key");
			const raw = await history(f);
			// Act
			const result = await authorize(f);
			// Assert
			expectIds(before, f, ["a", "b"]);
			expectIds(result, f, []);
			expect(await history(f)).toEqual(raw);
		},
	);
	test("ID-only tombstone excludes only its device, not another member sharing the key", async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		await tombstone(f, "device_id");
		const before = await history(f);
		// Act
		const result = await authorize(f);
		// Assert
		expectIds(result, f, ["b"]);
		expect(await history(f)).toEqual(before);
	});
}
function registerScopeSources(test: Test) {
	test.for([
		["missing", null, "scope_not_found"],
		["status", "removed", "scope_inactive"],
		["authority_type", "local", "scope_source_mismatch"],
		["group_id", "other-group", "scope_source_mismatch"],
		["group_id", null, "scope_source_mismatch"],
	] as const)("rejects %s scope authority", async ([field, value, error], { fixture: f }) => {
		// Arrange
		await seed(f);
		if (field === "missing")
			await f.exec("DELETE FROM coordinator_scopes WHERE scope_id = ?", scopeId(f));
		else await update(f, "coordinator_scopes", field, value);
		// Act
		const result = await authorize(f);
		// Assert
		expect(result).toEqual({ kind: "rejected", error });
	});
	test("rejects archived group without rewriting memberships", async ({ fixture: f }) => {
		// Arrange
		await seed(f);
		await f.store.archiveGroup(f.review.groupId);
		const before = await history(f);
		// Act
		const result = await authorize(f);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "group_archived" });
		expect(await history(f)).toEqual(before);
	});
}
function registerMemberSources(test: Test) {
	test.for([
		["coordinator_id", "conflicting"],
		["group_id", "other-group"],
		["manifest_issuer_device_id", "conflicting"],
		["manifest_hash", "conflicting"],
		["membership_epoch", 1],
		["status", "revoked"],
	] as const)("omits conflicting or inactive member %s", async ([field, value], { fixture: f }) => {
		// Arrange
		await seed(f);
		await update(f, "coordinator_scope_memberships", field, value, { member: true });
		const before = await history(f);
		// Act
		const result = await authorize(f);
		// Assert
		expectIds(result, f, ["b"]);
		expect(await history(f)).toEqual(before);
	});
	test.for(["coordinator_id", "group_id", "manifest_issuer_device_id", "manifest_hash"])(
		"null legacy member %s inherits explicit scope source",
		async (field, { fixture: f }) => {
			// Arrange
			await seed(f);
			await update(f, "coordinator_scope_memberships", field, null, { member: true });
			// Act
			const result = await authorize(f);
			// Assert
			expectIds(result, f, ["a", "b"]);
		},
	);
	test("legacy null scope coordinator accepts null member coordinator but excludes conflicting source", async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		await update(f, "coordinator_scopes", "coordinator_id", null);
		await update(f, "coordinator_scope_memberships", "coordinator_id", null, { member: true });
		// Act
		const result = await authorize(f);
		// Assert
		expectIds(result, f, ["a"]);
	});
}
function registerEnrollmentKeys(test: Test) {
	test.for([
		"disabled",
		"missing",
		"wrong group",
		"owner opaque",
		...MALFORMED_KEYS.map((k) => k.publicKey),
	])("never promotes enrollment %s", async (mode, { fixture: f }) => {
		// Arrange
		await seed(f);
		if (mode === "missing")
			await f.exec("DELETE FROM enrolled_devices WHERE device_id = ?", deviceId(f, "a"));
		else if (mode === "disabled")
			await update(f, "enrolled_devices", "enabled", 0, { member: true });
		else if (mode === "wrong group") {
			await f.store.createGroup(`${f.review.groupId}-other`);
			await update(f, "enrolled_devices", "group_id", `${f.review.groupId}-other`, {
				member: true,
			});
		} else {
			await update(f, "enrolled_devices", "public_key", mode === "owner opaque" ? "pk1" : mode, {
				member: true,
			});
			await update(f, "coordinator_scope_memberships", "role", "owner", { member: true });
		}
		// Act
		const result = await authorize(f);
		// Assert
		expectIds(result, f, ["b"]);
	});
}
function registerPresentation(test: Test) {
	test.for(["", null, "identity-display"])(
		"accepts presentation and identity metadata %s",
		async (value, { fixture: f }) => {
			// Arrange
			await seed(f);
			await update(f, "enrolled_devices", "display_name", value, { member: true });
			await update(f, "enrolled_devices", "identity_id", value, { member: true });
			// Act
			const result = await authorize(f);
			// Assert
			expectIds(result, f, ["a", "b"]);
		},
	);
	test.for(["display_name", "identity_id"])(
		"rejects NUL in %s rather than returning empty authority",
		async (field, { fixture: f }) => {
			// Arrange
			await seed(f);
			await update(f, "enrolled_devices", field, "invalid\0metadata", { member: true });
			// Act
			const result = await authorize(f);
			// Assert
			expect(result).toEqual(unavailable);
		},
	);
	test.for(["active", "revoked"])(
		"validates malformed role only for %s membership",
		async (status, { fixture: f }) => {
			// Arrange: inactive history is skipped before strict positive-row validation.
			await seed(f);
			await update(f, "coordinator_scope_memberships", "status", status, { member: true });
			await update(f, "coordinator_scope_memberships", "role", "", { member: true });
			const before = await history(f);
			// Act
			const result = await authorize(f);
			// Assert
			if (status === "active") expect(result).toEqual(unavailable);
			else expectIds(result, f, ["b"]);
			expect(await history(f)).toEqual(before);
		},
	);
}
function registerInputAndStorage(test: Test) {
	test.for(["coordinator_scopes", "coordinator_scope_memberships"])(
		"rejects malformed epoch in %s",
		async (table, { fixture: f }) => {
			// Arrange
			await seed(f);
			await update(f, table, "membership_epoch", -1, {
				member: table === "coordinator_scope_memberships",
			});
			// Act
			const result = await authorize(f);
			// Assert
			expect(result).toEqual(unavailable);
		},
	);
	test("captures caller primitives before first await and never invokes accessor options", async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		const options = input(f);
		const getter = vi.fn(() => f.review.groupId);
		// Act
		const pending = f.store.getScopeAuthorization(options);
		options.groupId = "changed";
		options.scopeId = "changed";
		const result = await pending;
		const accessor = await f.store.getScopeAuthorization({
			get groupId() {
				return getter();
			},
			scopeId: scopeId(f),
		});
		// Assert
		expectIds(result, f, ["a", "b"]);
		expect(accessor).toEqual(unavailable);
		expect(getter).not.toHaveBeenCalled();
	});
}

const memberDrifts = [
	["enrolled_devices", "public_key", UNRELATED_PUBLIC_KEY],
	["enrolled_devices", "public_key", `${CANONICAL_PUBLIC_KEY} changed-comment`],
	["enrolled_devices", "fingerprint", "changed"],
	["enrolled_devices", "identity_id", "changed"],
	["enrolled_devices", "display_name", "changed"],
	["enrolled_devices", "enabled", 0],
	["coordinator_scope_memberships", "membership_epoch", 3],
	["coordinator_scope_memberships", "manifest_hash", "changed"],
	["coordinator_scope_memberships", "role", "owner"],
	["coordinator_scope_memberships", "status", "revoked"],
] as const;

export function registerScopeRaces(test: Test, database: Database) {
	registerMemberDrifts(test, database);
	registerScopeDrifts(test, database);
	registerHashCapture(test, database);
	registerLargeRoster(test, database);
}
function registerMemberDrifts(test: Test, database: Database) {
	test.for(memberDrifts)(
		"final atomic read omits drift %s.%s",
		async ([table, field, value], { fixture: f }) => {
			// Arrange
			await seed(f);
			let fired = false;
			const store = new D1CoordinatorStore(
				scopeReadWrapper(database(f), {
					beforeFinal: async (values) => {
						fired = true;
						expect(values).toHaveLength(2);
						await update(f, table, field, value, { member: true });
					},
				}),
			);
			// Act
			const result = await authorize(f, store);
			// Assert
			expect(fired).toBe(true);
			expectIds(result, f, ["b"]);
		},
	);
	test.for(["remove member", "remove enrollment", "late ID", "late key", "new grant"])(
		"final atomic read isolates %s",
		async (mode, { fixture: f }) => {
			// Arrange
			await seed(f);
			let fired = false;
			const store = new D1CoordinatorStore(
				scopeReadWrapper(database(f), {
					beforeFinal: async () => {
						fired = true;
						if (mode === "new grant") await addMember(f, "c");
						else if (mode.startsWith("late"))
							await tombstone(f, mode === "late ID" ? "device_id" : "ed25519_key");
						else
							await f.exec(
								`DELETE FROM ${mode === "remove member" ? "coordinator_scope_memberships" : "enrolled_devices"} WHERE device_id = ?`,
								deviceId(f, "a"),
							);
					},
				}),
			);
			// Act
			const result = await authorize(f, store);
			// Assert
			expect(fired).toBe(true);
			let ids = ["b"];
			if (mode === "new grant") ids = ["a", "b"];
			if (mode === "late key") ids = [];
			expectIds(result, f, ids);
		},
	);
}
function registerScopeDrifts(test: Test, database: Database) {
	test.for([
		["membership_epoch", 3],
		["group_id", "changed"],
		["coordinator_id", "changed"],
		["manifest_issuer_device_id", "changed"],
		["manifest_hash", "changed"],
		["authority_type", "local"],
		["status", "removed"],
		["label", "changed"],
		["archive", "changed"],
	] as const)("scope pin rejects late %s drift", async ([field, value], { fixture: f }) => {
		// Arrange
		await seed(f);
		let fired = false;
		const store = new D1CoordinatorStore(
			scopeReadWrapper(database(f), {
				beforeFinal: async () => {
					fired = true;
					if (field === "archive") await f.store.archiveGroup(f.review.groupId);
					else await update(f, "coordinator_scopes", field, value);
				},
			}),
		);
		// Act
		const result = await authorize(f, store);
		// Assert
		expect(fired).toBe(true);
		expect(result).toEqual(unavailable);
	});
}
function registerHashCapture(test: Test, database: Database) {
	test("captures the whole roster before first hash can replace the second member key", async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		let fired = false;
		const guard = hashGuard(f, async () => {
			fired = true;
			await f.exec(
				"UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?",
				UNRELATED_PUBLIC_KEY,
				deviceId(f, "b"),
			);
		});
		try {
			// Act
			const result = await authorize(f);
			// Assert
			expect(fired).toBe(true);
			expectIds(result, f, ["a"]);
		} finally {
			guard.restore();
		}
	});
	test("clones returned capture rows before first hash can mutate retained second-member objects", async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		const captured: Record<string, unknown>[] = [];
		const db = scopeReadWrapper(database(f), {
			receipt: (sql, receipt, method) => {
				if (sql === READ_SCOPE_AUTHORIZATION_SQL) return receipt;
				if (!/FROM (enrolled_devices|coordinator_scope_memberships)/i.test(sql)) return receipt;
				const rows = readReceiptRows(receipt, method);
				captured.push(...rows.filter((row) => row && typeof row === "object"));
				return receipt;
			},
		});
		const store = new D1CoordinatorStore(db);
		const guard = hashGuard({ ...f, store }, async () => {
			for (const row of captured) {
				if (row.device_id !== deviceId(f, "b") || !("public_key" in row)) continue;
				row.public_key = UNRELATED_PUBLIC_KEY;
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?",
					row.public_key,
					row.device_id,
				);
			}
		});
		try {
			// Act
			const result = await authorize(f, store);
			// Assert
			expect(captured.filter((row) => "public_key" in row)).toHaveLength(2);
			expectIds(result, f, ["a"]);
		} finally {
			guard.restore();
		}
	});
}
function registerLargeRoster(test: Test, database: Database) {
	test("121 members use five reads and two final JSON bindings", async ({ fixture: f }) => {
		// Arrange
		await seed(f);
		const names = Array.from({ length: 119 }, (_, n) => `bulk-${String(n).padStart(3, "0")}`);
		for (const name of names) await addMember(f, name);
		let bindings: readonly unknown[] = [];
		let reads = 0;
		const store = new D1CoordinatorStore(
			scopeReadWrapper(database(f), {
				beforeFinal: async (values) => {
					bindings = values;
				},
				receipt: (_sql, receipt) => {
					reads += 1;
					return receipt;
				},
			}),
		);
		// Act
		const result = await authorize(f, store);
		// Assert
		expectIds(result, f, ["a", "b", ...names]);
		expect(reads).toBe(5);
		expect(bindings).toHaveLength(2);
		expect(JSON.parse(String(bindings[1]))).toHaveLength(121);
	});
}

export function registerScopeReceipts(test: Test, database: Database) {
	registerTupleReceipts(test, database);
	registerReadFailures(test, database);
}
function readReceiptRows(receipt: unknown, method: "all" | "first"): Record<string, unknown>[] {
	if (method === "first") return [receipt as Record<string, unknown>];
	return (receipt as { results: Record<string, unknown>[] }).results;
}
function alteredTupleReceipt(receipt: unknown, method: "all" | "first", mode: string) {
	const record = readReceiptRows(receipt, method)[0];
	if (!record) throw new Error("Expected final receipt");
	const members = JSON.parse(String(record.members_json));
	let json = mode;
	if (mode === "reverse") json = JSON.stringify(members.reverse());
	if (mode === "subset") json = JSON.stringify(members.slice(1));
	if (mode === "duplicate") json = JSON.stringify([members[0], members[0]]);
	if (mode === "unexpected") json = JSON.stringify([{ ...members[0], keyId: "unexpected" }]);
	const replacement = { ...record, members_json: json };
	return method === "first" ? replacement : { ...(receipt as object), results: [replacement] };
}
function registerTupleReceipts(test: Test, database: Database) {
	test.for(["reverse", "subset", "duplicate", "unexpected", "not-json", "null", "{}", "[{}]"])(
		"validates exact final tuple receipt %s",
		async (mode, { fixture: f }) => {
			// Arrange
			await seed(f);
			let fired = false;
			const store = new D1CoordinatorStore(
				scopeReadWrapper(database(f), {
					receipt: (sql, receipt, method) => {
						if (sql !== READ_SCOPE_AUTHORIZATION_SQL) return receipt;
						fired = true;
						return alteredTupleReceipt(receipt, method, mode);
					},
				}),
			);
			// Act
			const result = await authorize(f, store);
			// Assert
			expect(fired).toBe(true);
			if (mode === "reverse" || mode === "subset")
				expectIds(result, f, mode === "reverse" ? ["a", "b"] : ["b"]);
			else expect(result).toEqual(unavailable);
		},
	);
}
function registerReadFailures(test: Test, database: Database) {
	registerMissingReceipts(test, database);
	test.for(["capture scope", "capture group", "capture members", "capture enrollment", "final"])(
		"fixed private failure on %s read exception",
		async (stage, { fixture: f }) => {
			// Arrange
			await seed(f);
			let fired = false;
			const store = new D1CoordinatorStore(
				scopeReadWrapper(database(f), {
					receipt: (sql, receipt) => {
						if (matchesStage(sql, stage)) {
							fired = true;
							throw new Error("private SQL diagnostic and device identifier");
						}
						return receipt;
					},
				}),
			);
			// Act
			const result = await authorize(f, store);
			// Assert
			expect(fired).toBe(true);
			expect(result).toEqual(unavailable);
		},
	);
}
function registerMissingReceipts(test: Test, database: Database) {
	test.for(
		["capture scope", "capture group", "capture enrollment", "final"].flatMap((stage) =>
			["undefined", "malformed"].map((mode) => ({ stage, mode })),
		),
	)("rejects $stage $mode storage read receipt", async ({ stage, mode }, { fixture: f }) => {
		// Arrange: undefined or malformed receipts cannot confirm storage reads.
		await seed(f);
		let fired = false;
		const store = new D1CoordinatorStore(
			scopeReadWrapper(database(f), {
				receipt: (sql, receipt) => {
					if (!matchesStage(sql, stage)) return receipt;
					fired = true;
					return mode === "undefined" ? undefined : {};
				},
			}),
		);
		// Act
		const result = await authorize(f, store);
		// Assert
		expect(fired).toBe(true);
		expect(result).toEqual(unavailable);
	});
	test.for(
		["capture members", "capture enrollment"].flatMap((stage) =>
			["missing", "null", "object", "bad row", "unsuccessful", "duplicate row"].map((mode) => ({
				stage,
				mode,
			})),
		),
	)(
		"unconfirmed $stage $mode receipt is not empty authority",
		async ({ stage, mode }, { fixture: f }) => {
			// Arrange
			await seed(f);
			let fired = false;
			const store = new D1CoordinatorStore(
				scopeReadWrapper(database(f), {
					receipt: (sql, receipt, method) => {
						if (!matchesStage(sql, stage)) return receipt;
						fired = true;
						return malformedReceipt(receipt, method, mode);
					},
				}),
			);
			// Act
			const result = await authorize(f, store);
			// Assert
			expect(fired).toBe(true);
			expect(result).toEqual(unavailable);
		},
	);
}
function malformedReceipt(receipt: unknown, method: "all" | "first", mode: string) {
	if (method === "first") return mode === "null" ? null : {};
	if (mode === "missing") return {};
	if (mode === "null") return { results: null };
	if (mode === "object") return { results: {} };
	if (mode === "bad row") return { results: [null] };
	if (mode === "duplicate row") {
		const rows = (receipt as { results: unknown[] }).results;
		return { ...(receipt as object), results: [...rows, ...rows] };
	}
	return { ...(receipt as object), success: false };
}
function matchesStage(sql: string, stage: string) {
	if (stage === "final") return sql === READ_SCOPE_AUTHORIZATION_SQL;
	if (sql === READ_SCOPE_AUTHORIZATION_SQL) return false;
	const table = {
		"capture scope": "coordinator_scopes",
		"capture group": "groups",
		"capture members": "coordinator_scope_memberships",
		"capture enrollment": "enrolled_devices",
	}[stage];
	return new RegExp(`FROM ${table}\\b`, "i").test(sql);
}
