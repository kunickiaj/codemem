import {
	ADMISSION_BUDGET_POOLS,
	type AdmissionBudgetPool,
} from "./admission-budget-allocation-schema.js";
import { RELAY_ADMISSION_CLOCK_SQL as CLOCK } from "./relay-admission-clock.js";

export type { AdmissionBudgetPool } from "./admission-budget-allocation-schema.js";
export interface AdmissionBudgetKey {
	readonly authorityId: string;
	readonly pool: AdmissionBudgetPool;
	readonly audienceId: string;
	readonly groupId: string;
	readonly deviceId: string;
}
export interface AdmissionBudgetReservationStatement {
	readonly sql: string;
	readonly bindings: readonly (string | number | null)[];
	readonly association: Readonly<AdmissionBudgetKey & { execId: string }>;
}

const OLD = "admission_budget_buckets";
const CAPACITY = `MIN(${OLD}.last_capacity,excluded.last_capacity)`;
const RATE = `MIN(${OLD}.last_rate,excluded.last_rate)`;
const BALANCE = `MIN(${OLD}.units,${CAPACITY})`;
const ELAPSED = `(${CLOCK} - ${OLD}.refilled_at_ms)`;
const NEED = `(${CAPACITY} - ${BALANCE})`;
// Test integer time-to-fill before multiplying. The ELSE product is strictly
// below NEED, and NEED + RATE - 1 fits SQLite's signed integer range.
const SETTLED = `(CASE WHEN ${RATE} = 0 THEN ${BALANCE}
 WHEN ${ELAPSED} >= (${NEED} + ${RATE} - 1) / ${RATE} THEN ${CAPACITY}
 ELSE ${BALANCE} + ${ELAPSED} * ${RATE} END)`;
const GRANT = `(CASE WHEN ${SETTLED} >= 60000 THEN 1 ELSE 0 END)`;
const RESERVE_SQL = `INSERT INTO admission_budget_buckets (
 authority_id,pool,audience_id,group_id,device_id,units,refilled_at_ms,last_rate,last_capacity,exec_id,granted)
 SELECT ?1,?2,?3,?4,?5,MAX(0,p.burst * 60000 - 60000),${CLOCK},p.rate_per_min,p.burst * 60000,?6,
 CASE WHEN p.burst > 0 THEN 1 ELSE 0 END
 FROM admission_budget_allocations p WHERE p.authority_id = ?1 AND p.pool = ?2 AND p.audience_id = ?3
 AND p.group_id = CASE WHEN ?2 IN ('device','device-registration') THEN '' ELSE ?4 END
 AND typeof(${CLOCK}) = 'integer' AND ${CLOCK} BETWEEN 0 AND 9007199254740991
 ON CONFLICT(authority_id,pool,audience_id,group_id,device_id) DO UPDATE SET
 units = ${SETTLED} - ${GRANT} * 60000, granted = ${GRANT},
 refilled_at_ms = ${CLOCK},last_rate = excluded.last_rate,last_capacity = excluded.last_capacity,exec_id = excluded.exec_id
 WHERE ${CLOCK} >= ${OLD}.refilled_at_ms
 RETURNING authority_id AS authorityId,pool,audience_id AS audienceId,group_id AS groupId,
 device_id AS deviceId,exec_id AS execId,refilled_at_ms AS decidedAtMs,units,granted,
 last_rate AS ratePerMin,last_capacity AS capacityUnits`;

function isHex(value: unknown, size: number): value is string {
	return typeof value === "string" && value.length === size && /^[0-9a-f]+$/.test(value);
}
function isGroup(value: unknown): value is string {
	if (typeof value !== "string" || value !== value.trim()) return false;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)) return false;
	}
	return new TextEncoder().encode(value).length <= 128;
}
function captureAssociation(options: AdmissionBudgetKey & { execId: string }) {
	const { authorityId, pool, audienceId, groupId, deviceId, execId } = options;
	if (
		!isHex(authorityId, 64) ||
		!isHex(execId, 32) ||
		!ADMISSION_BUDGET_POOLS.includes(pool) ||
		!isGroup(groupId) ||
		typeof audienceId !== "string" ||
		typeof deviceId !== "string"
	)
		return null;
	const device = pool === "device" || pool === "device-registration";
	const relay = pool === "relay-route" || pool === "relay-registration";
	if ((relay && !isHex(audienceId, 64)) || (!relay && audienceId !== "")) return null;
	if (device) {
		if (
			groupId === "" ||
			deviceId.length < 1 ||
			deviceId.length > 64 ||
			/[^\x21-\x7e]/.test(deviceId)
		)
			return null;
	} else if (deviceId !== "" || (pool === "authority" && groupId !== "")) return null;
	return Object.freeze({ authorityId, pool, audienceId, groupId, deviceId, execId });
}

/** Pure private compiler. The caller owns fresh execution IDs and trusted execution. */
export function buildAdmissionBudgetReservationStatement(
	options: AdmissionBudgetKey & { execId: string },
): AdmissionBudgetReservationStatement | null {
	try {
		const association = captureAssociation(options);
		if (!association) return null;
		const { authorityId, pool, audienceId, groupId, deviceId, execId } = association;
		return Object.freeze({
			sql: RESERVE_SQL,
			bindings: Object.freeze([authorityId, pool, audienceId, groupId, deviceId, execId]),
			association,
		});
	} catch {
		return null;
	}
}

function isSafe(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validBalance(
	pool: AdmissionBudgetPool,
	rate: unknown,
	capacity: unknown,
	units: unknown,
	granted: unknown,
) {
	if (
		!isSafe(rate) ||
		!isSafe(capacity) ||
		!isSafe(units) ||
		units > capacity ||
		capacity % 60000 !== 0 ||
		(rate === 0) !== (capacity === 0)
	)
		return false;
	if (pool === "device" && (rate > 96 || capacity > 960000)) return false;
	if (pool === "device-registration" && (rate > 2 || capacity > 120000)) return false;
	if (granted === 0) return units < 60000;
	return granted === 1 && rate > 0 && units <= capacity - 60000;
}

/** Only the same execution's singular raw RETURNING row can reserve capacity.
 * Shape validation proves neither commit nor peer authentication. Never read back or retry. */
export function readAdmissionBudgetReservationReceipt(
	row: unknown,
	statement: AdmissionBudgetReservationStatement,
): { status: "reserved" | "denied"; decidedAtMs: number; units: number } | null {
	try {
		if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
		const {
			authorityId,
			pool,
			audienceId,
			groupId,
			deviceId,
			execId,
			decidedAtMs,
			units,
			granted,
			ratePerMin,
			capacityUnits,
		} = row as Record<string, unknown>;
		const expected = captureAssociation(statement.association);
		if (
			!expected ||
			authorityId !== expected.authorityId ||
			pool !== expected.pool ||
			audienceId !== expected.audienceId ||
			groupId !== expected.groupId ||
			deviceId !== expected.deviceId ||
			execId !== expected.execId ||
			!isSafe(decidedAtMs) ||
			!isSafe(units) ||
			!validBalance(expected.pool, ratePerMin, capacityUnits, units, granted)
		)
			return null;
		return { status: granted === 1 ? "reserved" : "denied", decidedAtMs, units };
	} catch {
		return null;
	}
}
