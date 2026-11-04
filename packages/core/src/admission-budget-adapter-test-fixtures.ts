import { describe, expect, it, vi } from "vitest";
import type { AdmissionBudgetPool } from "./admission-budget.js";
import { createAdmissionBudgetAdapters } from "./admission-budget-adapters.js";
import { allocate, allocationKeyFor } from "./admission-budget-allocation-schema-test-fixtures.js";
import {
	type WriteDatabase,
	type WriteFixture,
	writeFixture,
} from "./peer-traversal-coordinator-attempt-write-test-fixtures.js";
import type {
	TraversalSignalDeviceReservation,
	TraversalSignalIngressReservation,
} from "./peer-traversal-coordinator-decision.js";
import { decideTraversalSignal } from "./peer-traversal-coordinator-decision.js";
import { decisionOptions } from "./peer-traversal-coordinator-decision-test-fixtures.js";
import { phaseChain } from "./peer-traversal-coordinator-phase-write-test-fixtures.js";
import {
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
} from "./relay-admission-codec.js";
import {
	decideRelayAdmission,
	type RelayAdmissionDeviceReservation,
	type RelayAdmissionIngressReservation,
} from "./relay-admission-decision.js";
import { metadataSeed } from "./relay-admission-metadata-test-fixtures.js";

export type Bindings = readonly (string | number | null)[];
export const UNIT = 60000;
const AUDIENCE = "f".repeat(64);
type Create = () => Promise<WriteFixture>;
type ScopeKey = readonly [AdmissionBudgetPool, string, string, string];
const scope = (f: WriteFixture) => ({
	db: f.db,
	authority: f.authority,
	group: f.options.namespace.groupId,
});
export async function adapterFixture(db: WriteDatabase, now: number, id: number) {
	return writeFixture(db, now, id);
}
export async function seedProfiles(
	f: WriteFixture,
	options: { disabled?: boolean; routeBurst?: number } = {},
) {
	const s = scope(f);
	const rate = options.disabled ? 0 : 1;
	await allocate(s, allocationKeyFor(s), rate * 4, options.disabled ? 0 : 64);
	for (const pool of ["traversal", "relay-route", "relay-registration"] as const) {
		let burst = 16;
		if (pool === "relay-route") burst = options.routeBurst ?? 16;
		if (pool === "relay-registration") burst = 2;
		if (options.disabled) burst = 0;
		const key = allocationKeyFor(s, { pool, audienceId: pool === "traversal" ? "" : AUDIENCE });
		await allocate(s, key, rate, burst);
		await allocate(s, { ...key, groupId: s.group }, rate, burst);
	}
	await allocate(s, allocationKeyFor(s, { pool: "device" }), rate, options.disabled ? 0 : 16);
	await allocate(
		s,
		allocationKeyFor(s, { pool: "device-registration" }),
		rate,
		options.disabled ? 0 : 2,
	);
}
export function relayIngress(
	f: WriteFixture,
	kind: "registration" | "admission" = "admission",
): RelayAdmissionIngressReservation {
	return {
		namespace: { ...f.options.namespace, relayAudienceId: AUDIENCE },
		ingressKey: "test-ingress",
		expected: kind === "registration" ? { kind } : { kind, role: "source" },
	};
}
export function traversalIngress(f: WriteFixture): TraversalSignalIngressReservation {
	return { namespace: { ...f.options.namespace }, ingressKey: "test-ingress", phase: "prepare" };
}
export function relayDevice(
	f: WriteFixture,
	kind: "registration" | "admission" = "admission",
): RelayAdmissionDeviceReservation {
	return {
		...relayIngress(f, kind),
		deviceId: f.options.participants.source.device_id,
		keyId: f.keys.source.keyId,
	};
}
export function traversalDevice(f: WriteFixture): TraversalSignalDeviceReservation {
	return {
		...traversalIngress(f),
		deviceId: f.options.participants.source.device_id,
		keyId: f.keys.source.keyId,
	};
}
function raw(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("missing own budget row");
	return value as Record<string, unknown>;
}
export function adapterHarness(f: WriteFixture) {
	const trace: string[] = [];
	const writes: { bindings: Bindings; row: unknown }[] = [];
	const writeReturning = vi.fn(async (sql: string, bindings: Bindings): Promise<unknown> => {
		trace.push("budget");
		const row = (await f.db.all(sql, [...bindings]))[0] ?? null;
		writes.push({ bindings: [...bindings], row });
		return row;
	});
	const database = { writeReturning };
	const adapters = createAdmissionBudgetAdapters({ database });
	const query = vi.fn(async (sql: string, bindings: Bindings): Promise<unknown> => {
		trace.push("query");
		return f.db.all(sql, [...bindings]);
	});
	const protocolWrite = vi.fn(async (sql: string, bindings: Bindings): Promise<unknown> => {
		trace.push("protocol");
		return (await f.db.all(sql, [...bindings]))[0] ?? null;
	});
	return { adapters, database, writes, trace, query, protocolWrite };
}
type Harness = ReturnType<typeof adapterHarness>;
const rows = (f: WriteFixture) =>
	f.db.all("SELECT * FROM admission_budget_buckets WHERE authority_id=?1", [f.authority]);
const keys = (h: Harness) =>
	h.writes.map((entry) => {
		const row = raw(entry.row);
		return [row.pool, row.audienceId, row.groupId, row.deviceId];
	});
const protocolRows = (f: WriteFixture) =>
	f.db.all("SELECT nonce FROM request_nonces WHERE device_id IN (?1,?2)", [
		f.options.proof.value.sourceDeviceId,
		f.options.proof.value.targetDeviceId,
	]);
function ingressKeys(
	f: WriteFixture,
	pool: "traversal" | "relay-route" | "relay-registration",
): ScopeKey[] {
	const audience = pool === "traversal" ? "" : AUDIENCE;
	return [
		[pool, audience, f.options.namespace.groupId, ""],
		[pool, audience, "", ""],
		["authority", "", "", ""],
	];
}
async function warmDenied(f: WriteFixture, key: ScopeKey) {
	const [pool, audienceId, groupId, deviceId] = key;
	await f.db.run(
		"INSERT INTO admission_budget_buckets(authority_id,pool,audience_id,group_id,device_id,units,refilled_at_ms,last_rate,last_capacity,exec_id,granted) VALUES (?1,?2,?3,?4,?5,0,?6,0,0,?7,0)",
		[f.authority, pool, audienceId, groupId, deviceId, f.now, f.session(950)],
	);
}

// All profiles and reservations here are synthetic local fixtures, not validated service ceilings.
export function registerAdapterScenarios(create: Create) {
	describe("durable callback composition", () => {
		registerIngressMapping(create);
		registerSharedIngress(create);
		registerStageStops(create);
		registerDeviceStops(create);
		registerCapture(create);
		registerMutation(create);
		registerMalformed(create);
		registerSharedDevice(create);
		registerRegistration(create);
		registerUnknownWrites(create);
	});
	describe("signed decisions with durable callbacks", () => {
		registerTraversalDecision(create);
		registerRelayDecisions(create);
		registerDecisionDenials(create);
		registerUnknownDecision(create);
	});
}
function registerSharedIngress(create: Create) {
	it.each(["registration", "admission"] as const)(
		"charges only the shared %s pool and authority before a group is known",
		async (kind) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);
			const pool = kind === "registration" ? "relay-registration" : "relay-route";

			const result = await h.adapters.relay.reserveSharedIngress({
				authorityId: f.authority,
				relayAudienceId: AUDIENCE,
				expected: relayIngress(f, kind).expected,
			});

			expect(result).toBe("reserved");
			expect(keys(h)).toEqual(ingressKeys(f, pool).slice(1));
			expect(await rows(f)).toHaveLength(2);
		},
	);
	it("returns unknown without writing for an invalid shared audience", async () => {
		const f = await create();
		await seedProfiles(f);
		const h = adapterHarness(f);

		const result = await h.adapters.relay.reserveSharedIngress({
			authorityId: f.authority,
			relayAudienceId: "not-an-audience",
			expected: { kind: "admission", role: "relay" },
		});

		expect(result).toBe("unknown");
		expect(h.trace).toEqual([]);
	});
}

function registerIngressMapping(create: Create) {
	it.each(["registration", "route", "traversal"] as const)(
		"charges %s realm, pool, authority in order with fresh stored executions",
		async (kind) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);

			let result: unknown;
			if (kind === "traversal")
				result = await h.adapters.traversal.reserveIngress(traversalIngress(f));
			else
				result = await h.adapters.relay.reserveIngress(
					relayIngress(f, kind === "registration" ? "registration" : "admission"),
				);

			const pools = {
				registration: "relay-registration",
				route: "relay-route",
				traversal: "traversal",
			} as const;
			expect(result).toBe("reserved");
			expect(keys(h)).toEqual(ingressKeys(f, pools[kind]));
			const ids = h.writes.map((entry) => raw(entry.row).execId);
			expect(new Set(ids).size).toBe(3);
			for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
			expect((await rows(f)).map((row) => row.exec_id).sort()).toEqual([...ids].sort());
		},
	);
}
function registerStageStops(create: Create) {
	it.each(
		[0, 1, 2].flatMap((stage) =>
			(["denied", "unknown"] as const).map((status) => ({ stage, status })),
		),
	)(
		"stops ingress at stage $stage on $status without refund or downstream writes",
		async ({ stage, status }) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);
			const expected = ingressKeys(f, "traversal");
			const key = expected[stage];
			if (!key) throw new Error("bad stage fixture");
			if (status === "denied") await warmDenied(f, key);
			const write = h.database.writeReturning.getMockImplementation();
			if (!write) throw new Error("missing writer");
			let count = 0;
			h.database.writeReturning.mockImplementation(async (sql: string, values: Bindings) => {
				const row = await write(sql, values);
				return count++ === stage && status === "unknown" ? null : row;
			});

			const result = await h.adapters.traversal.reserveIngress(traversalIngress(f));

			expect(result).toBe(status);
			expect(h.database.writeReturning).toHaveBeenCalledTimes(stage + 1);
			expect(keys(h)).toEqual(expected.slice(0, stage + 1));
			expect(await rows(f)).toHaveLength(stage + 1);
			expect(h.writes.map((entry) => raw(entry.row).granted)).toEqual(
				Array.from({ length: stage + 1 }, (_, index) =>
					index === stage && status === "denied" ? 0 : 1,
				),
			);
		},
	);
}
function registerDeviceStops(create: Create) {
	it.each(
		[0, 1].flatMap((stage) =>
			(["denied", "unknown"] as const).map((status) => ({ stage, status })),
		),
	)(
		"stops registration device scope $stage on $status without refunds",
		async ({ stage, status }) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);
			const r = relayDevice(f, "registration");
			const expected: ScopeKey[] = [
				["device-registration", "", r.namespace.groupId, r.deviceId],
				["device", "", r.namespace.groupId, r.deviceId],
			];
			const key = expected[stage];
			if (!key) throw new Error("bad stage fixture");
			if (status === "denied") await warmDenied(f, key);
			const write = h.database.writeReturning.getMockImplementation();
			if (!write) throw new Error("missing writer");
			let count = 0;
			h.database.writeReturning.mockImplementation(async (sql: string, values: Bindings) => {
				const row = await write(sql, values);
				return count++ === stage && status === "unknown" ? null : row;
			});

			const result = await h.adapters.relay.reserveVerifiedDevice(r);

			expect(result).toBe(status);
			expect(h.database.writeReturning).toHaveBeenCalledTimes(stage + 1);
			expect(keys(h)).toEqual(expected.slice(0, stage + 1));
			expect(await rows(f)).toHaveLength(stage + 1);
		},
	);
}
function registerCapture(create: Create) {
	it("captures one bound writer at construction, freezes ports and reads the reservation once", async () => {
		const f = await create();
		await seedProfiles(f);
		const h = adapterHarness(f);
		let gets = 0;
		let groups = 0;
		const database = {
			get writeReturning() {
				gets++;
				return async function (this: unknown, sql: string, values: Bindings) {
					expect(this).toBe(database);
					return h.database.writeReturning(sql, values);
				};
			},
		};
		const adapters = createAdmissionBudgetAdapters({ database });
		expect(gets).toBe(1);
		expect(h.database.writeReturning).not.toHaveBeenCalled();
		Object.defineProperty(database, "writeReturning", {
			get: () => {
				throw new Error("changed private port");
			},
		});
		const r = relayIngress(f);
		Object.defineProperty(r.namespace, "groupId", {
			get: () => (++groups === 1 ? f.options.namespace.groupId : "foreign"),
		});

		const result = await adapters.relay.reserveIngress(r);

		expect(result).toBe("reserved");
		expect(groups).toBe(1);
		expect(gets).toBe(1);
		for (const value of [adapters, adapters.relay, adapters.traversal])
			expect(Object.isFrozen(value)).toBe(true);
	});
}
function registerMutation(create: Create) {
	it.each(["ingress", "device"] as const)(
		"owns namespace, kind and device across the first %s write await",
		async (stage) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);
			const r = relayDevice(f, "registration");
			const original = { ...r, namespace: { ...r.namespace } };
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const write = h.database.writeReturning.getMockImplementation();
			if (!write) throw new Error("missing writer");
			h.database.writeReturning.mockImplementationOnce(async (sql: string, values: Bindings) => {
				const row = await write(sql, values);
				entered.resolve();
				await release.promise;
				return row;
			});

			const pending =
				stage === "ingress"
					? h.adapters.relay.reserveIngress(r)
					: h.adapters.relay.reserveVerifiedDevice(r);
			await entered.promise;
			Object.assign(r.namespace, {
				authorityId: "0".repeat(64),
				groupId: "foreign",
				relayAudienceId: "0".repeat(64),
			});
			Object.assign(r.expected, { kind: "admission", role: "source" });
			Object.assign(r, { deviceId: "foreign", keyId: "changed", ingressKey: "changed" });
			release.resolve();
			const result = await pending;

			expect(result).toBe("reserved");
			const expected =
				stage === "ingress"
					? ingressKeys(f, "relay-registration")
					: [
							["device-registration", "", original.namespace.groupId, original.deviceId],
							["device", "", original.namespace.groupId, original.deviceId],
						];
			expect(keys(h)).toEqual(expected);
		},
	);
}
function registerMalformed(create: Create) {
	it("returns unknown for missing or throwing writer capabilities without I/O", async () => {
		const f = await create();
		const h = adapterHarness(f);
		for (const fault of ["database", "writer", "getter"]) {
			const options = { database: { writeReturning: h.database.writeReturning } };
			if (fault === "database") Reflect.set(options, "database", undefined);
			if (fault === "writer") Reflect.set(options.database, "writeReturning", undefined);
			if (fault === "getter")
				Object.defineProperty(options, "database", {
					get: () => {
						throw new Error("private capture error");
					},
				});

			const adapters = createAdmissionBudgetAdapters(options);
			expect(await adapters.traversal.reserveIngress(traversalIngress(f))).toBe("unknown");
			expect(await adapters.relay.reserveVerifiedDevice(relayDevice(f))).toBe("unknown");
		}
		expect(h.database.writeReturning).not.toHaveBeenCalled();
	});
	it("rejects malformed required namespace, kind and device records before any scope write", async () => {
		const f = await create();
		const h = adapterHarness(f);
		for (const fault of ["group", "audience", "authority", "kind", "device", "namespace"]) {
			const r = relayDevice(f, "registration");
			corruptReservation(r, fault);

			expect(await h.adapters.relay.reserveVerifiedDevice(r)).toBe("unknown");
			if (fault !== "device") expect(await h.adapters.relay.reserveIngress(r)).toBe("unknown");
		}
		expect(
			await h.adapters.traversal.reserveIngress({
				...traversalIngress(f),
				namespace: { ...f.options.namespace, groupId: "" },
			}),
		).toBe("unknown");
		expect(h.database.writeReturning).not.toHaveBeenCalled();
	});
	it("distinguishes absent profiles from explicitly disabled scopes without granting either", async () => {
		const f = await create();
		const h = adapterHarness(f);
		expect(await h.adapters.traversal.reserveIngress(traversalIngress(f))).toBe("unknown");
		expect(await rows(f)).toEqual([]);
		await seedProfiles(f, { disabled: true });

		const result = await h.adapters.traversal.reserveIngress(traversalIngress(f));

		expect(result).toBe("denied");
		expect(await rows(f)).toMatchObject([{ units: 0, granted: 0 }]);
	});
}
function corruptReservation(r: RelayAdmissionDeviceReservation, fault: string) {
	if (fault === "group") Object.assign(r.namespace, { groupId: "" });
	if (fault === "audience") Object.assign(r.namespace, { relayAudienceId: "invalid" });
	if (fault === "authority") Object.assign(r.namespace, { authorityId: "A".repeat(64) });
	if (fault === "kind") Object.assign(r.expected, { kind: "unknown" });
	if (fault === "device") Object.assign(r, { deviceId: "has space" });
	if (fault === "namespace") Reflect.set(r, "namespace", null);
}
function registerSharedDevice(create: Create) {
	it("shares one device balance across protocols, audiences, rekeys, ingresses and new adapter instances", async () => {
		const f = await create();
		await seedProfiles(f);
		const h = adapterHarness(f);
		const outcomes: unknown[] = [];
		for (let index = 0; index < 17; index++) {
			const adapters = createAdmissionBudgetAdapters({
				database: {
					writeReturning: (sql: string, values: Bindings) => h.database.writeReturning(sql, values),
				},
			});
			const ingressKey = `https://invalid.example/?q=');DROP--${index}`;
			const keyId = index.toString(16).padStart(64, "0");
			if (index % 2 === 0)
				outcomes.push(
					await adapters.traversal.reserveVerifiedDevice({
						...traversalDevice(f),
						keyId,
						ingressKey,
					}),
				);
			else
				outcomes.push(
					await adapters.relay.reserveVerifiedDevice({
						...relayDevice(f),
						namespace: {
							...relayIngress(f).namespace,
							relayAudienceId: index.toString(16).padStart(64, "0"),
						},
						keyId,
						ingressKey,
					}),
				);
			expect(h.writes[index]?.bindings).not.toContain(ingressKey);
			expect(h.writes[index]?.bindings).not.toContain(keyId);
		}

		expect(outcomes).toEqual([...Array.from({ length: 16 }, () => "reserved"), "denied"]);
		expect(await rows(f)).toHaveLength(1);
		expect(keys(h).every((key) => key[0] === "device" && key[1] === "")).toBe(true);
	});
	it("reads a lowered persistent device profile rather than caching per-instance capacity", async () => {
		const f = await create();
		await seedProfiles(f);
		const h = adapterHarness(f);
		const r = traversalDevice(f);
		expect(await h.adapters.traversal.reserveVerifiedDevice(r)).toBe("reserved");
		await f.db.run(
			"UPDATE admission_budget_allocations SET burst=1 WHERE authority_id=?1 AND pool='device'",
			[f.authority],
		);

		const lowered = await createAdmissionBudgetAdapters({
			database: h.database,
		}).traversal.reserveVerifiedDevice(r);
		const exhausted = await createAdmissionBudgetAdapters({
			database: h.database,
		}).traversal.reserveVerifiedDevice(r);

		expect(lowered).toBe("reserved");
		expect(exhausted).toBe("denied");
		expect(h.writes).toHaveLength(3);
	});
}
function registerRegistration(create: Create) {
	it("charges registration subset before shared device and stops the third call at its subset", async () => {
		const f = await create();
		await seedProfiles(f);
		const h = adapterHarness(f);
		const r = relayDevice(f, "registration");

		const outcomes = [
			await h.adapters.relay.reserveVerifiedDevice(r),
			await h.adapters.relay.reserveVerifiedDevice(r),
			await h.adapters.relay.reserveVerifiedDevice(r),
		];

		expect(outcomes).toEqual(["reserved", "reserved", "denied"]);
		expect(keys(h).map((key) => key[0])).toEqual([
			"device-registration",
			"device",
			"device-registration",
			"device",
			"device-registration",
		]);
	});
	it("does not borrow registration ingress capacity after route capacity is exhausted", async () => {
		const f = await create();
		await seedProfiles(f, { routeBurst: 1 });
		const h = adapterHarness(f);
		expect(await h.adapters.relay.reserveIngress(relayIngress(f))).toBe("reserved");

		const route = await h.adapters.relay.reserveIngress(relayIngress(f));
		const registration = await h.adapters.relay.reserveIngress(relayIngress(f, "registration"));

		expect(route).toBe("denied");
		expect(registration).toBe("reserved");
	});
}
function registerUnknownWrites(create: Create) {
	it.each(["foreign", "envelope", "multiple", "throw", "reject-before"] as const)(
		"returns unknown on %s without retry, recovery query or later scopes",
		async (fault) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);
			const write = h.database.writeReturning.getMockImplementation();
			if (!write) throw new Error("missing writer");
			h.database.writeReturning.mockImplementationOnce(async (sql: string, values: Bindings) => {
				if (fault === "reject-before") throw new Error("private precommit error");
				const row = await write(sql, values);
				if (fault === "throw") throw new Error("private postcommit error");
				if (fault === "envelope") return { results: [row] };
				if (fault === "multiple") return [row, row];
				return { ...raw(row), execId: "0".repeat(32) };
			});

			const result = await h.adapters.traversal.reserveIngress(traversalIngress(f));

			expect(result).toBe("unknown");
			expect(h.database.writeReturning).toHaveBeenCalledTimes(1);
			expect(await rows(f)).toHaveLength(fault === "reject-before" ? 0 : 1);
		},
	);
}

async function seedRelayMetadata(f: WriteFixture) {
	for (const entry of metadataSeed({
		authority: f.authority,
		group: f.options.namespace.groupId,
		audience: AUDIENCE,
		authorityObserved: f.now,
		realmObserved: f.now,
	}))
		await f.db.run(entry.sql, entry.values);
}
async function relayRequest(f: WriteFixture, kind: "registration" | "admission") {
	await seedRelayMetadata(f);
	const source = f.options.participants.source;
	const target = f.options.participants.target;
	if (!target) throw new Error("missing target");
	const namespace = relayIngress(f).namespace;
	const createdAt = f.options.proof.value.createdAt;
	const common = { ...namespace, createdAt, admitBefore: createdAt + 30 };
	const bodyBytes =
		kind === "registration"
			? encodeRelayRegistrationBody({
					...common,
					deviceId: source.device_id,
					keyId: source.keyId,
					socketChallengeId: f.session(801),
				})
			: encodeRelayAdmissionBody({
					...common,
					role: "source",
					sourceDeviceId: source.device_id,
					sourceKeyId: source.keyId,
					targetDeviceId: target.device_id,
					targetKeyId: target.keyId,
					routeSessionId: f.session(802),
					messageADigest: "d".repeat(64),
					routeNotAfter: createdAt + 55,
				});
	const nonce = f.session(803);
	const externalPathname = "/trusted/v1/relay/admission-check";
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bodyBytes));
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const canonical = ["POST", externalPathname, String(createdAt), nonce, hash].join("\n");
	const signatureBytes = new Uint8Array(
		await crypto.subtle.sign(
			"Ed25519",
			f.keys.source.privateKey,
			new TextEncoder().encode(canonical),
		),
	);
	return {
		packet: encodeRelayCheckPacket({
			bodyBytes,
			timestamp: String(createdAt),
			nonce,
			signatureBytes,
		}),
		expected: relayIngress(f, kind).expected,
		deviceHeader: source.device_id,
		externalPathname,
		namespace,
		ingressKey: "signed-test-ingress",
	};
}
function traversalDeps(h: Harness) {
	return {
		database: { query: h.query, writeReturning: h.protocolWrite },
		budgets: h.adapters.traversal,
	};
}
function relayDeps(h: Harness) {
	return {
		database: { query: h.query, insertReturning: h.protocolWrite },
		budgets: h.adapters.relay,
	};
}
function registerTraversalDecision(create: Create) {
	it("runs five real signed traversal decisions with exactly five ingress charges and source/target device charges 3/2", async () => {
		const f = await create();
		await seedProfiles(f);
		const h = adapterHarness(f);
		const chain = await phaseChain(f);

		for (const proof of chain) {
			const start = h.trace.length;
			expect(
				await decideTraversalSignal(decisionOptions(f, proof), traversalDeps(h)),
			).toMatchObject({ ok: true, phase: proof.value.phase });
			expect(h.trace.slice(start)).toEqual([
				"budget",
				"budget",
				"budget",
				"query",
				"query",
				"budget",
				"protocol",
				"protocol",
			]);
		}

		const actual = await rows(f);
		expect(actual).toHaveLength(5);
		for (const bucket of actual) {
			const writes = h.writes
				.map((entry) => raw(entry.row))
				.filter(
					(row) =>
						row.pool === bucket.pool &&
						row.groupId === bucket.group_id &&
						row.deviceId === bucket.device_id,
				);
			let count = 5;
			if (bucket.pool === "device")
				count = bucket.device_id === f.options.proof.value.sourceDeviceId ? 3 : 2;
			expect(writes).toHaveLength(count);
			const first = writes[0];
			if (!first) throw new Error("missing committed budget operation");
			expect(bucket.units).toBe(
				Number(bucket.last_capacity) -
					count * UNIT +
					(Number(bucket.refilled_at_ms) - Number(first.decidedAtMs)) * Number(bucket.last_rate),
			);
		}
	});
}
function registerRelayDecisions(create: Create) {
	it.each(["registration", "admission"] as const)(
		"decides a real signed relay %s using the same enrolled Ed25519 fixture keys",
		async (kind) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);
			const request = await relayRequest(f, kind);

			const result = await decideRelayAdmission(request, relayDeps(h));

			expect(result?.kind).toBe(kind);
			expect(await protocolRows(f)).toHaveLength(1);
			const budgetCount = kind === "registration" ? 2 : 1;
			expect(h.trace).toEqual([
				"budget",
				"budget",
				"budget",
				"query",
				"query",
				...Array.from({ length: budgetCount }, () => "budget"),
				"protocol",
			]);
		},
	);
}
async function signedDecision(
	f: WriteFixture,
	h: Harness,
	protocol: "relay" | "traversal",
	options: { corruptSignature?: boolean } = {},
) {
	if (protocol === "relay") {
		const request = await relayRequest(f, "admission");
		if (options.corruptSignature)
			Object.assign(request.packet, {
				signature: `v2:${btoa(String.fromCharCode(...new Uint8Array(64)))}`,
			});
		return decideRelayAdmission(request, relayDeps(h));
	}
	const request = decisionOptions(f);
	if (options.corruptSignature)
		Object.assign(raw(request.packet), {
			signature: `v2:${btoa(String.fromCharCode(...new Uint8Array(64)))}`,
		});
	return decideTraversalSignal(request, traversalDeps(h));
}
function registerDecisionDenials(create: Create) {
	it.each(["relay", "traversal"] as const)(
		"charges %s ingress for an invalid signature but never charges a device or protocol nonce",
		async (protocol) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);

			const result = await signedDecision(f, h, protocol, { corruptSignature: true });

			expect(result).toBeNull();
			expect(h.writes).toHaveLength(3);
			expect(h.protocolWrite).not.toHaveBeenCalled();
			expect((await rows(f)).some((row) => row.pool === "device")).toBe(false);
			expect(await protocolRows(f)).toEqual([]);
		},
	);
	it.each(["relay", "traversal"] as const)(
		"denies %s before lookup or nonce writes when ingress profiles are absent or zero",
		async (protocol) => {
			for (const disabled of [false, true]) {
				const f = await create();
				if (disabled) await seedProfiles(f, { disabled: true });
				const h = adapterHarness(f);

				const result = await signedDecision(f, h, protocol);

				expect(result).toBeNull();
				expect(h.query).not.toHaveBeenCalled();
				expect(h.protocolWrite).not.toHaveBeenCalled();
				expect(await protocolRows(f)).toEqual([]);
			}
		},
	);
	it.each(["relay", "traversal"] as const)(
		"denies %s after verification when shared device capacity is exhausted, before protocol nonce/state",
		async (protocol) => {
			const f = await create();
			await seedProfiles(f);
			const h = adapterHarness(f);
			const device = traversalDevice(f);
			await warmDenied(f, ["device", "", device.namespace.groupId, device.deviceId]);

			const result = await signedDecision(f, h, protocol);

			expect(result).toBeNull();
			expect(h.query).toHaveBeenCalledTimes(2);
			expect(h.writes).toHaveLength(4);
			expect(h.protocolWrite).not.toHaveBeenCalled();
			expect(await protocolRows(f)).toEqual([]);
		},
	);
}
function registerUnknownDecision(create: Create) {
	it("denies a decision on an unknown budget receipt after actual commit, without querying enrollment or retrying", async () => {
		const f = await create();
		await seedProfiles(f);
		const h = adapterHarness(f);
		const write = h.database.writeReturning.getMockImplementation();
		if (!write) throw new Error("missing writer");
		h.database.writeReturning.mockImplementationOnce(async (sql: string, values: Bindings) => {
			await write(sql, values);
			return null;
		});

		const result = await decideTraversalSignal(decisionOptions(f), traversalDeps(h));

		expect(result).toBeNull();
		expect(h.database.writeReturning).toHaveBeenCalledTimes(1);
		expect(await rows(f)).toHaveLength(1);
		expect(h.query).not.toHaveBeenCalled();
		expect(h.protocolWrite).not.toHaveBeenCalled();
		expect(await protocolRows(f)).toEqual([]);
	});
}
