import { describe, expect, it, vi } from "vitest";
import type {
	WriteFixture,
	WriteSeedOptions,
} from "./peer-traversal-coordinator-attempt-write-test-fixtures.js";
import {
	decideTraversalSignal,
	type TraversalSignalDecisionDependencies,
	type TraversalSignalDecisionOptions,
	type TraversalSignalDeviceReservation,
	type TraversalSignalIngressReservation,
} from "./peer-traversal-coordinator-decision.js";
import { phaseChain } from "./peer-traversal-coordinator-phase-write-test-fixtures.js";
import { attemptRow, insertAttempt } from "./peer-traversal-coordinator-schema-test-fixtures.js";
import { encodeTraversalSignalPacket } from "./peer-traversal-signal-codec.js";
import type { RelayAdmissionBudgetStatus } from "./relay-admission-decision.js";
import { RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL } from "./relay-admission-participant-nonce.js";
import { PARTICIPANT_REVOCATION_INSERT } from "./relay-admission-participant-nonce-test-fixtures.js";

export type Bindings = readonly (string | number | null)[];
type Create = (options?: WriteSeedOptions) => Promise<WriteFixture>;
export function decisionOptions(
	f: WriteFixture,
	proof = f.options.proof,
): TraversalSignalDecisionOptions {
	return {
		packet: encodeTraversalSignalPacket(proof),
		expectedPhase: proof.value.phase,
		deviceHeader: proof.signer.deviceId,
		externalPathname: "/v1/traversal/signal",
		namespace: { ...f.options.namespace },
		ingressKey: "trusted-test-ingress",
	};
}
export function rawRow(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("missing raw test row");
	return value as Record<string, unknown>;
}
export const isNonceSql = (sql: string) => /^\s*INSERT\s+INTO\s+request_nonces\b/i.test(sql);
export function decisionHarness(f: WriteFixture) {
	const trace: string[] = [];
	const writes: { kind: string; row: unknown }[] = [];
	const query = vi.fn(async (sql: string, bindings: Bindings): Promise<unknown> => {
		trace.push(sql === RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL ? "participants" : "preflight");
		return f.db.all(sql, [...bindings]);
	});
	const writeReturning = vi.fn(async (sql: string, bindings: Bindings): Promise<unknown> => {
		const kind = isNonceSql(sql) ? "nonce" : "state";
		trace.push(kind);
		const row = (await f.db.all(sql, [...bindings]))[0] ?? null;
		writes.push({ kind, row });
		return row;
	});
	// These callbacks reserve test capacity only. They do not prove durable production budgets.
	const reserveIngress = vi.fn(
		async (
			_reservation: TraversalSignalIngressReservation,
		): Promise<RelayAdmissionBudgetStatus> => {
			trace.push("ingress");
			return "reserved";
		},
	);
	const reserveVerifiedDevice = vi.fn(
		async (_reservation: TraversalSignalDeviceReservation): Promise<RelayAdmissionBudgetStatus> => {
			trace.push("verified");
			return "reserved";
		},
	);
	const deps = {
		database: { query, writeReturning },
		budgets: { reserveIngress, reserveVerifiedDevice },
	} satisfies TraversalSignalDecisionDependencies;
	return { deps, trace, writes };
}
export const stateRows = (f: WriteFixture) =>
	f.db.all("SELECT * FROM traversal_attempts WHERE authority_id=?1", [f.authority]);
export const nonceRows = (f: WriteFixture) =>
	f.db.all("SELECT * FROM request_nonces WHERE device_id IN (?1,?2)", [
		f.options.proof.value.sourceDeviceId,
		f.options.proof.value.targetDeviceId,
	]);

export function registerDecisionScenarios(create: Create) {
	describe("private traversal decisions", () => {
		registerDecisionChain(create);
		registerBudgets(create);
		registerMalformedReservations(create);
		registerMissingPorts(create);
		registerInvalidRequests(create);
		registerPreflightDenials(create);
		registerEligibilityRaces(create);
		registerUnknownWrites(create);
		registerLostCasReceipt(create);
		registerQuota(create);
		registerReplayAndCompetition(create);
	});
}
function registerDecisionChain(create: Create) {
	it("decides all five signed phases with exact frozen replies, actor budgets and distinct owned executions", async () => {
		const f = await create();
		const chain = await phaseChain(f);
		const ids: unknown[] = [];

		for (const proof of chain) {
			const h = decisionHarness(f);
			const result = await decideTraversalSignal(decisionOptions(f, proof), h.deps);
			const final = rawRow(h.writes.find((entry) => entry.kind === "state")?.row);

			expect(result).toEqual({
				v: 1,
				ok: true,
				phase: proof.value.phase,
				sessionId: proof.value.sessionId,
				packetDigest: proof.packetDigest,
				requestNonce: proof.nonce,
				decidedAtMs: final.decidedAtMs,
				attemptNotAfter: proof.value.attemptNotAfter,
				remainingMs: proof.value.attemptNotAfter * 1000 - Number(final.decidedAtMs),
				policyRevision: 1,
				readyObservedAtMs: final.readinessObservedAtMs,
			});
			expect(Object.isFrozen(result)).toBe(true);
			expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(1024);
			expect(h.trace).toEqual([
				"ingress",
				"preflight",
				"participants",
				"verified",
				"nonce",
				"state",
			]);
			expect(h.deps.budgets.reserveVerifiedDevice).toHaveBeenCalledWith({
				namespace: f.options.namespace,
				ingressKey: "trusted-test-ingress",
				phase: proof.value.phase,
				deviceId: proof.signer.deviceId,
				keyId: proof.signer.keyId,
			});
			ids.push(...h.writes.map((entry) => rawRow(entry.row).attemptId));
			expect((await stateRows(f))[0]?.exec_id).toBe(final.attemptId);
		}
		expect(ids).toHaveLength(10);
		expect(new Set(ids).size).toBe(10);
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
	});
}
const BUDGET_CASES = (["reserveIngress", "reserveVerifiedDevice"] as const).flatMap((stage) =>
	(["missing", "denied", "unknown", "throw"] as const).map((status) => ({ stage, status })),
);
function registerBudgets(create: Create) {
	it.each(BUDGET_CASES)(
		"denies $stage $status without writing either table",
		async ({ stage, status }) => {
			const f = await create();
			const h = decisionHarness(f);
			const callback = h.deps.budgets[stage];
			if (status === "missing") Reflect.deleteProperty(h.deps.budgets, stage);
			else if (status === "throw") callback.mockRejectedValue(new Error("private budget detail"));
			else callback.mockResolvedValue(status);

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(h.deps.database.writeReturning).not.toHaveBeenCalled();
			if (stage === "reserveIngress" || status === "missing")
				expect(h.deps.database.query).not.toHaveBeenCalled();
			else expect(h.deps.database.query).toHaveBeenCalledTimes(2);
			expect(await nonceRows(f)).toEqual([]);
			expect(await stateRows(f)).toEqual([]);
		},
	);
}
function registerMalformedReservations(create: Create) {
	it.each(["reserveIngress", "reserveVerifiedDevice"] as const)(
		"accepts no truthy/coercible/undefined $stage result",
		async (stage) => {
			for (const value of [undefined, true, { toString: () => "reserved" }]) {
				const f = await create();
				const h = decisionHarness(f);
				Reflect.set(h.deps.budgets, stage, async () => value);

				const result = await decideTraversalSignal(decisionOptions(f), h.deps);

				expect(result).toBeNull();
				expect(h.deps.database.writeReturning).not.toHaveBeenCalled();
			}
		},
	);
}
function registerMissingPorts(create: Create) {
	it.each(["budgets", "query", "writeReturning"] as const)(
		"fails closed when %s capability is absent",
		async (port) => {
			const f = await create();
			const h = decisionHarness(f);
			if (port === "budgets") Reflect.set(h.deps, "budgets", undefined);
			else Reflect.set(h.deps.database, port, undefined);

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(h.trace).toEqual([]);
		},
	);
}
const BAD_REQUESTS = [
	"phase",
	"unknownPhase",
	"authority",
	"group",
	"namespaceExtra",
	"header",
	"ingressKey",
	"pathQuery",
	"pathControls",
	"pathBackslash",
	"pathDoubleSlash",
	"body",
	"signature",
	"pin",
	"missingTarget",
] as const;
function registerInvalidRequests(create: Create) {
	it.each(BAD_REQUESTS)(
		"denies invalid %s before any write or verified-device reservation",
		async (change) => {
			const f = await create();
			const h = decisionHarness(f);
			const input = decisionOptions(f);
			await corruptRequest(f, input, change);

			const result = await decideTraversalSignal(input, h.deps);

			expect(result).toBeNull();
			expect(h.deps.database.writeReturning).not.toHaveBeenCalled();
			expect(h.deps.budgets.reserveVerifiedDevice).not.toHaveBeenCalled();
		},
	);
}
async function corruptRequest(
	f: WriteFixture,
	input: TraversalSignalDecisionOptions,
	change: (typeof BAD_REQUESTS)[number],
) {
	const mutations = {
		phase: () => Object.assign(input, { expectedPhase: "offer" }),
		unknownPhase: () => Object.assign(input, { expectedPhase: "unknown" }),
		authority: () => Object.assign(input.namespace, { authorityId: "0".repeat(64) }),
		group: () => Object.assign(input.namespace, { groupId: "foreign" }),
		namespaceExtra: () => Object.assign(input.namespace, { relayAudienceId: "0".repeat(64) }),
		header: () => Object.assign(input, { deviceHeader: f.options.proof.value.targetDeviceId }),
		ingressKey: () => Object.assign(input, { ingressKey: "" }),
		pathQuery: () => Object.assign(input, { externalPathname: "/v1/traversal/signal?private" }),
		pathControls: () => Object.assign(input, { externalPathname: "/\u0001/v1/traversal/signal" }),
		pathBackslash: () => Object.assign(input, { externalPathname: "/a\\b/v1/traversal/signal" }),
		pathDoubleSlash: () => Object.assign(input, { externalPathname: "//v1/traversal/signal" }),
		body: () => Object.assign(rawRow(input.packet), { body: "invalid" }),
		signature: () =>
			Object.assign(rawRow(input.packet), {
				signature: `v2:${btoa(String.fromCharCode(...new Uint8Array(64)))}`,
			}),
		pin: () =>
			f.db.run("UPDATE enrolled_devices SET public_key=?1 WHERE group_id=?2 AND device_id=?3", [
				f.options.participants.target?.public_key ?? "",
				input.namespace.groupId,
				input.deviceHeader,
			]),
		missingTarget: () =>
			f.db.run(
				"UPDATE enrolled_devices SET device_id='missing-target' WHERE group_id=?1 AND device_id=?2",
				[input.namespace.groupId, f.options.proof.value.targetDeviceId],
			),
	};
	await mutations[change]();
}
const PREFLIGHT_DENIALS: WriteSeedOptions[] = [
	{ omit: "policy" },
	{ omit: "realm" },
	{ omit: "authorityHealth" },
	{ omit: "realmHealth" },
	{ rootState: "disabled" },
	{ realmState: "disabled" },
	{ authorityHealthOffset: -50001 },
	{ createdOffset: -30 },
];
function registerPreflightDenials(create: Create) {
	it.each(PREFLIGHT_DENIALS)(
		"denies unavailable metadata/window before participant lookup %j",
		async (seed) => {
			const f = await create(seed);
			const h = decisionHarness(f);

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(h.trace).toEqual(["ingress", "preflight"]);
			expect(h.deps.database.writeReturning).not.toHaveBeenCalled();
		},
	);
}
async function changeCurrent(f: WriteFixture, change: "policy" | "revocation" | "target") {
	if (change === "policy")
		return f.db.run(
			"UPDATE traversal_authority_policy SET policy_revision=2 WHERE authority_id=?1",
			[f.authority],
		);
	if (change === "revocation")
		return f.db.run(PARTICIPANT_REVOCATION_INSERT, [
			"device_id",
			f.options.proof.value.sourceDeviceId,
		]);
	return f.db.run("UPDATE enrolled_devices SET enabled=0 WHERE group_id=?1 AND device_id=?2", [
		f.options.namespace.groupId,
		f.options.proof.value.targetDeviceId,
	]);
}
function registerEligibilityRaces(create: Create) {
	it.each(["policy", "revocation", "target"] as const)(
		"rechecks %s after proof/budget but before the nonce write",
		async (change) => {
			const f = await create();
			const h = decisionHarness(f);
			const reserve = h.deps.budgets.reserveVerifiedDevice.getMockImplementation();
			if (!reserve) throw new Error("missing test reservation");
			h.deps.budgets.reserveVerifiedDevice.mockImplementation(
				async (reservation: TraversalSignalDeviceReservation) => {
					await changeCurrent(f, change);
					return reserve(reservation);
				},
			);

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(h.deps.database.writeReturning).toHaveBeenCalledTimes(1);
			expect(await nonceRows(f)).toEqual([]);
			expect(await stateRows(f)).toEqual([]);
		},
	);
	it.each(["policy", "revocation", "target"] as const)(
		"denies state after %s changes following an owned nonce receipt",
		async (change) => {
			const f = await create();
			const h = decisionHarness(f);
			const write = h.deps.database.writeReturning.getMockImplementation();
			if (!write) throw new Error("missing test writer");
			h.deps.database.writeReturning.mockImplementation(async (sql: string, values: Bindings) => {
				if (!isNonceSql(sql)) await changeCurrent(f, change);
				return write(sql, values);
			});

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(h.deps.database.writeReturning).toHaveBeenCalledTimes(2);
			expect(await nonceRows(f)).toHaveLength(1);
			expect(await stateRows(f)).toEqual([]);
			expect(h.deps.database.query).toHaveBeenCalledTimes(2);
		},
	);
}
const FAULTS = [
	"null",
	"undefined",
	"array",
	"multiple",
	"envelope",
	"foreign",
	"readiness",
	"policy",
	"clock",
	"window",
	"throw",
] as const;
function faultyRow(row: unknown, fault: (typeof FAULTS)[number]) {
	if (fault === "null") return null;
	if (fault === "undefined") return undefined;
	if (fault === "array") return [row];
	if (fault === "multiple") return [row, row];
	if (fault === "envelope") return { results: [row] };
	if (fault === "throw") throw new Error("private write outcome is unknown");
	const original = rawRow(row);
	if (fault === "window") {
		const now = Number(original.decidedAtMs) + 30000;
		return {
			...original,
			decidedAtMs: now,
			updatedAtMs: now,
			createdAt: new Date(now).toISOString(),
		};
	}
	const changes = {
		foreign: { attemptId: "0".repeat(32) },
		readiness: { readinessObservedAtMs: -1 },
		policy: { policyRevision: Number(original.policyRevision) + 1 },
		clock: { decidedAtMs: null },
	};
	return { ...original, ...changes[fault] };
}
function registerUnknownWrites(create: Create) {
	it.each(
		(["nonce", "state"] as const).flatMap((stage) => FAULTS.map((fault) => ({ stage, fault }))),
	)(
		"denies $stage $fault after a real commit without retry or readback",
		async ({ stage, fault }) => {
			const f = await create();
			const h = decisionHarness(f);
			const write = h.deps.database.writeReturning.getMockImplementation();
			if (!write) throw new Error("missing test writer");
			h.deps.database.writeReturning.mockImplementation(async (sql: string, values: Bindings) => {
				const row = await write(sql, values);
				if (isNonceSql(sql) === (stage === "nonce")) return faultyRow(row, fault);
				return row;
			});

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(h.deps.database.query).toHaveBeenCalledTimes(2);
			expect(h.deps.database.writeReturning).toHaveBeenCalledTimes(stage === "nonce" ? 1 : 2);
			expect(await nonceRows(f)).toHaveLength(1);
			expect(await stateRows(f)).toHaveLength(stage === "nonce" ? 0 : 1);
			expect(h.trace).toEqual([
				"ingress",
				"preflight",
				"participants",
				"verified",
				"nonce",
				...(stage === "state" ? ["state"] : []),
			]);
		},
	);
}
function registerLostCasReceipt(create: Create) {
	it("denies a lost CAS receipt even though the signed OFFER advanced stored state", async () => {
		const f = await create();
		const chain = await phaseChain(f);
		const prepare = decisionHarness(f);
		expect(await decideTraversalSignal(decisionOptions(f, chain[0]), prepare.deps)).not.toBeNull();
		const h = decisionHarness(f);
		const write = h.deps.database.writeReturning.getMockImplementation();
		if (!write) throw new Error("missing test writer");
		h.deps.database.writeReturning.mockImplementation(async (sql: string, values: Bindings) => {
			const row = await write(sql, values);
			return isNonceSql(sql) ? row : null;
		});

		const result = await decideTraversalSignal(decisionOptions(f, chain[1]), h.deps);

		expect(result).toBeNull();
		expect((await stateRows(f))[0]?.phase).toBe(2);
		expect(await nonceRows(f)).toHaveLength(2);
		expect(h.deps.database.query).toHaveBeenCalledTimes(2);
		expect(h.deps.database.writeReturning).toHaveBeenCalledTimes(2);
	});
}
function registerQuota(create: Create) {
	it("keeps the nonce consumed when a live pair quota aborts the state insert", async () => {
		const f = await create();
		const h = decisionHarness(f);
		const body = f.options.proof.value;
		await insertAttempt(
			f.db,
			attemptRow(f, {
				session_id: f.session(999),
				group_id: body.groupId,
				source_device_id: body.sourceDeviceId,
				target_device_id: body.targetDeviceId,
				source_key_id: body.sourceKeyId,
				target_key_id: body.targetKeyId,
			}),
		);

		const result = await decideTraversalSignal(decisionOptions(f), h.deps);

		expect(result).toBeNull();
		expect(h.deps.database.writeReturning).toHaveBeenCalledTimes(2);
		expect(await nonceRows(f)).toHaveLength(1);
		expect((await stateRows(f)).map((row) => row.session_id)).toEqual([f.session(999)]);
		expect(h.deps.database.query).toHaveBeenCalledTimes(2);
	});
}
function registerReplayAndCompetition(create: Create) {
	it("denies a globally consumed device nonce even when the session is still absent", async () => {
		const f = await create();
		const h = decisionHarness(f);
		const proof = f.options.proof;
		await f.db.run("INSERT INTO request_nonces(device_id,nonce,created_at) VALUES (?1,?2,?3)", [
			proof.signer.deviceId,
			proof.nonce,
			new Date(f.now).toISOString(),
		]);

		const result = await decideTraversalSignal(decisionOptions(f), h.deps);

		expect(result).toBeNull();
		expect(h.deps.database.writeReturning).toHaveBeenCalledTimes(1);
		expect(await nonceRows(f)).toHaveLength(1);
		expect(await stateRows(f)).toEqual([]);
	});
	it("allows one decision for concurrent identical signed packets", async () => {
		const f = await create();
		const first = decisionHarness(f);
		const second = decisionHarness(f);

		const results = await Promise.all([
			decideTraversalSignal(decisionOptions(f), first.deps),
			decideTraversalSignal(decisionOptions(f), second.deps),
		]);

		expect(results.filter((value: unknown) => value !== null)).toHaveLength(1);
		expect(await nonceRows(f)).toHaveLength(1);
		expect(await stateRows(f)).toHaveLength(1);
	});
}
