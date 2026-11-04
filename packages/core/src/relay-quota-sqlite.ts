import { RELAY_ADMISSION_CLOCK_SQL as CLOCK } from "./relay-admission-clock.js";
import type { RelayAdmissionBudgetStatus } from "./relay-admission-decision.js";
import type { RelayQuotaPort } from "./relay-server.js";

/** Structural synchronous SQLite boundary. This database belongs only to the relay. */
export interface RelayQuotaDatabase {
	prepare(sql: string): {
		get(...bindings: (string | number)[]): unknown;
		run(...bindings: (string | number)[]): unknown;
	};
	exec(sql: string): unknown;
	transaction<T>(operation: () => T): { immediate(): T };
}
type Purpose = "upgrade" | "control" | "open" | "traffic";
type Scope = "service" | "realm" | "device" | "pair";
type Request = Parameters<RelayQuotaPort["reserve"]>[0];
type QuotaRequest = Omit<Request, "purpose"> & { readonly purpose: Purpose };
export interface SqliteRelayQuotaPort extends RelayQuotaPort {
	reserveUpgrade(signal: AbortSignal): Promise<RelayAdmissionBudgetStatus>;
}
export interface RelayQuotaAllocation {
	readonly ratePerMinute: number;
	readonly burst: number;
}
export type RelayQuotaProfile = Readonly<
	Partial<Record<Purpose, Readonly<Partial<Record<Scope, RelayQuotaAllocation>>>>>
>;

const MiB = 1024 * 1024;
const CEILINGS: Record<Purpose, Record<Scope, readonly [number, number]>> = {
	upgrade: { service: [120, 16], realm: [120, 16], device: [0, 0], pair: [0, 0] },
	control: { service: [120, 16], realm: [120, 16], device: [120, 16], pair: [0, 0] },
	open: { service: [1024, 1024], realm: [128, 128], device: [30, 4], pair: [20, 2] },
	traffic: {
		service: [1024 * MiB, 256 * MiB],
		realm: [128 * MiB, 64 * MiB],
		device: [64 * MiB, 40 * MiB],
		pair: [40 * MiB, 40 * MiB],
	},
};
const PURPOSES: Purpose[] = ["upgrade", "control", "open", "traffic"];
const SCOPES: Scope[] = ["service", "realm", "device", "pair"];
const DENIED = Symbol("relay quota denied");

function tightenPolicy(reference: "OLD" | "NEW", allocation = reference): string {
	return `UPDATE relay_quota_buckets SET
 last_rate = MIN(last_rate, ${allocation}.rate),
 last_capacity = MIN(last_capacity, ${allocation}.burst * 60000),
 balance = MIN(balance, ${allocation}.burst * 60000)
 WHERE purpose = ${reference}.purpose AND scope = ${reference}.scope AND ${allocation}.rate > 0;`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_quota_root (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 realm_id TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
 ) STRICT;
CREATE TABLE IF NOT EXISTS relay_quota_allocations (
 purpose TEXT NOT NULL CHECK(purpose IN ('upgrade','control','open','traffic')),
 scope TEXT NOT NULL CHECK(scope IN ('service','realm','device','pair')),
 rate INTEGER NOT NULL CHECK(rate BETWEEN 0 AND 1073741824),
 burst INTEGER NOT NULL CHECK(burst BETWEEN 0 AND 268435456),
 CHECK((rate = 0) = (burst = 0)),
 PRIMARY KEY(purpose,scope)
) STRICT;
CREATE TABLE IF NOT EXISTS relay_quota_buckets (
 purpose TEXT NOT NULL,
 scope TEXT NOT NULL,
 subject TEXT NOT NULL,
 balance INTEGER NOT NULL CHECK(balance BETWEEN 0 AND 16106127360000),
 refilled_at_ms INTEGER NOT NULL CHECK(refilled_at_ms BETWEEN 0 AND 9007199254740991),
 last_rate INTEGER NOT NULL CHECK(last_rate BETWEEN 0 AND 1073741824),
 last_capacity INTEGER NOT NULL CHECK(last_capacity BETWEEN 0 AND 16106127360000),
 CHECK(balance <= last_capacity),
 PRIMARY KEY(purpose,scope,subject)
 ) STRICT;
CREATE TRIGGER IF NOT EXISTS relay_quota_policy_insert
 AFTER INSERT ON relay_quota_allocations BEGIN ${tightenPolicy("NEW")} END;
CREATE TRIGGER IF NOT EXISTS relay_quota_policy_update
 AFTER UPDATE ON relay_quota_allocations BEGIN
 ${tightenPolicy("OLD")}
 ${tightenPolicy("OLD", "NEW")}
 ${tightenPolicy("NEW")}
 END;
CREATE TRIGGER IF NOT EXISTS relay_quota_policy_delete
 BEFORE DELETE ON relay_quota_allocations BEGIN ${tightenPolicy("OLD")} END;`;

const RECONCILE_POLICY = `UPDATE relay_quota_buckets AS b SET
 last_rate = MIN(last_rate, (SELECT a.rate FROM relay_quota_allocations a
  WHERE a.purpose = b.purpose AND a.scope = b.scope)),
 last_capacity = MIN(last_capacity, (SELECT a.burst * 60000 FROM relay_quota_allocations a
  WHERE a.purpose = b.purpose AND a.scope = b.scope)),
 balance = MIN(balance, (SELECT a.burst * 60000 FROM relay_quota_allocations a
  WHERE a.purpose = b.purpose AND a.scope = b.scope))
 WHERE EXISTS (SELECT 1 FROM relay_quota_allocations a
  WHERE a.purpose = b.purpose AND a.scope = b.scope AND a.rate > 0);`;

/** Explicit installation. Existing floors only tighten. No profile or enabled policy is created. */
export function initializeRelayQuotaSchema(database: RelayQuotaDatabase): void {
	database
		.transaction(() => {
			database.exec(SCHEMA);
			// Zero or missing allocations pause admission without erasing positive history.
			// Older databases may have a committed tightening that no successful reservation retained.
			database.exec(RECONCILE_POLICY);
		})
		.immediate();
}

function requireQuotaProtection(database: RelayQuotaDatabase): void {
	const value = database
		.prepare(`SELECT COUNT(*) AS installed FROM sqlite_schema
 WHERE type = 'trigger' AND tbl_name = 'relay_quota_allocations'
 AND name IN ('relay_quota_policy_insert', 'relay_quota_policy_update', 'relay_quota_policy_delete')`)
		.get();
	if (!value || typeof value !== "object" || (value as { installed?: unknown }).installed !== 3)
		throw new Error("Relay quota policy protection unavailable");
}

function validRealm(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function validDevice(value: unknown): value is string {
	return typeof value === "string" && /^[\x21-\x7e]{1,64}$/.test(value);
}
function readAllocation(profile: RelayQuotaProfile, purpose: Purpose, scope: Scope) {
	const allocation = profile[purpose]?.[scope] ?? { ratePerMinute: 0, burst: 0 };
	const { ratePerMinute: rate, burst } = allocation;
	const [maxRate, maxBurst] = CEILINGS[purpose][scope];
	if (
		!Number.isSafeInteger(rate) ||
		!Number.isSafeInteger(burst) ||
		rate < 0 ||
		burst < 0 ||
		rate > maxRate ||
		burst > maxBurst ||
		(rate === 0) !== (burst === 0)
	)
		throw new Error("Invalid relay quota allocation");
	return { purpose, scope, rate, burst };
}

/** Disposable local fixtures only. Insert once, default disabled and zero.
 * Reprovisioning an existing root fails rather than replacing policy or counters.
 * Parent allocations intersect every request, so children cannot multiply capacity.
 */
export function provisionLocalRelayQuota(
	database: RelayQuotaDatabase,
	options: { readonly realmId: string; readonly profile?: RelayQuotaProfile },
): void {
	if (!validRealm(options.realmId)) throw new Error("Invalid relay quota realm");
	const allocations = PURPOSES.flatMap((purpose) =>
		SCOPES.map((scope) => readAllocation(options.profile ?? {}, purpose, scope)),
	);
	database
		.transaction(() => {
			database
				.prepare("INSERT INTO relay_quota_root(singleton,realm_id,enabled) VALUES(1,?,0)")
				.run(options.realmId);
			const insert = database.prepare(
				"INSERT INTO relay_quota_allocations(purpose,scope,rate,burst) VALUES(?,?,?,?)",
			);
			for (const { purpose, scope, rate, burst } of allocations)
				insert.run(purpose, scope, rate, burst);
		})
		.immediate();
}

/** Explicit operator switch. Neither switching nor recreating an adapter resets counters. */
export function setRelayQuotaEnabled(
	database: RelayQuotaDatabase,
	options: { readonly realmId: string; readonly enabled: boolean },
): void {
	if (!validRealm(options.realmId) || typeof options.enabled !== "boolean")
		throw new Error("Invalid relay quota switch");
	database
		.prepare("UPDATE relay_quota_root SET enabled = ? WHERE singleton = 1 AND realm_id = ?")
		.run(Number(options.enabled), options.realmId);
}

// Fixed-point tokens: one requested unit costs 60,000 balance units. As in the
// admission budget, compare time-to-fill before multiplying to avoid overflow.
// Historical minima prevent policy recreation/epoch changes from minting tokens.
const OLD = "relay_quota_buckets";
const CAPACITY = `MIN(${OLD}.last_capacity,excluded.last_capacity)`;
const RATE = `MIN(${OLD}.last_rate,excluded.last_rate)`;
const BALANCE = `MIN(${OLD}.balance,${CAPACITY})`;
const ELAPSED = `(? - ${OLD}.refilled_at_ms)`;
const NEED = `(${CAPACITY} - ${BALANCE})`;
const SETTLED = `(CASE WHEN ${RATE} = 0 THEN ${BALANCE}
 WHEN ${ELAPSED} >= (${NEED} + ${RATE} - 1) / ${RATE} THEN ${CAPACITY}
 ELSE ${BALANCE} + ${ELAPSED} * ${RATE} END)`;
const RESERVE = `INSERT INTO relay_quota_buckets
 (purpose,scope,subject,balance,refilled_at_ms,last_rate,last_capacity)
 VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(purpose,scope,subject) DO UPDATE SET
 balance = ${SETTLED} - ?, refilled_at_ms = ?,
 last_rate = ${RATE},last_capacity = ${CAPACITY}
 WHERE ? >= ${OLD}.refilled_at_ms AND ${SETTLED} >= ?
 RETURNING balance`;

function validRequest(request: Request, realmId: string): boolean {
	if (
		request.realmId !== realmId ||
		!["control", "open", "traffic"].includes(request.purpose) ||
		!Number.isSafeInteger(request.units) ||
		request.units <= 0 ||
		request.units > 256 * MiB
	)
		return false;
	if (request.purpose === "control")
		return (
			(request.deviceId === "" || validDevice(request.deviceId)) && request.peerDeviceId === null
		);
	return (
		validDevice(request.deviceId) &&
		validDevice(request.peerDeviceId) &&
		request.deviceId !== request.peerDeviceId
	);
}

function requestScopes(request: QuotaRequest): readonly (readonly [Scope, string])[] {
	const scopes: [Scope, string][] = [
		["service", ""],
		["realm", ""],
	];
	if (request.deviceId !== "") scopes.push(["device", request.deviceId]);
	if (request.peerDeviceId !== null) {
		scopes.push(["device", request.peerDeviceId]);
		scopes.push(["pair", JSON.stringify([request.deviceId, request.peerDeviceId].sort())]);
	}
	return scopes;
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw DENIED;
	return value as Record<string, unknown>;
}

function reserveBucket(
	database: RelayQuotaDatabase,
	request: QuotaRequest,
	scope: Scope,
	subject: string,
	now: number,
): void {
	const row = record(
		database
			.prepare(
				"SELECT rate AS ratePerMinute,burst FROM relay_quota_allocations WHERE purpose=? AND scope=?",
			)
			.get(request.purpose, scope),
	);
	const { rate, burst } = readAllocation(
		{ [request.purpose]: { [scope]: row } } as RelayQuotaProfile,
		request.purpose,
		scope,
	);
	if (rate === 0 || request.units > burst) throw DENIED;
	const cost = request.units * 60000;
	const capacity = burst * 60000;
	const result = record(
		database
			.prepare(RESERVE)
			.get(
				request.purpose,
				scope,
				subject,
				capacity - cost,
				now,
				rate,
				capacity,
				now,
				now,
				cost,
				now,
				now,
				now,
				now,
				cost,
			),
	);
	if (!Number.isSafeInteger(result.balance) || (result.balance as number) < 0) throw DENIED;
}

function reserveTransaction(
	database: RelayQuotaDatabase,
	request: QuotaRequest,
	signal: AbortSignal,
): RelayAdmissionBudgetStatus {
	requireQuotaProtection(database);
	const policy = record(
		database
			.prepare(
				`SELECT enabled,realm_id AS realmId,${CLOCK} AS now FROM relay_quota_root WHERE singleton=1`,
			)
			.get(),
	);
	if (policy.enabled !== 1 || policy.realmId !== request.realmId) throw DENIED;
	const now = policy.now;
	if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) throw DENIED;
	if (signal.aborted) throw DENIED;
	for (const [scope, subject] of requestScopes(request))
		reserveBucket(database, request, scope, subject, now);
	return "reserved";
}

interface RelayQuotaOptions {
	readonly database: RelayQuotaDatabase;
	readonly realmId: string;
	readonly enabled?: boolean;
}

/** No initialization, provisioning, retries, readback, refunds or application clock.
 * One immediate transaction charges all applicable scopes or rolls them all back.
 * A post-commit abort denies delivery but deliberately retains consumption.
 * Another connection's lock makes a reservation return "unknown" instead of waiting.
 */
export function createSqliteRelayQuota(options: RelayQuotaOptions): SqliteRelayQuotaPort {
	return createRelayQuotaPort(options, { lockWait: "disable" });
}

/**
 * Internal: only for storage that no other writer can lock, such as a Durable
 * Object, whose SQL API rejects `PRAGMA busy_timeout`. On a shared SQLite file a
 * held lock would block the event loop instead of returning "unknown".
 */
export function createExclusiveWriterRelayQuota(options: RelayQuotaOptions): SqliteRelayQuotaPort {
	return createRelayQuotaPort(options, { lockWait: "impossible" });
}

function createRelayQuotaPort(
	options: RelayQuotaOptions,
	locking: { readonly lockWait: "disable" | "impossible" },
): SqliteRelayQuotaPort {
	const { database, realmId } = options;
	const enabled = options.enabled === true && validRealm(realmId);
	// A lock must deny promptly instead of blocking relay deadlines on the event loop.
	let available = true;
	if (enabled && locking.lockWait === "disable") {
		try {
			database.exec("PRAGMA busy_timeout = 0");
		} catch {
			available = false;
		}
	}
	async function reserve(
		request: QuotaRequest,
		signal: AbortSignal,
	): Promise<RelayAdmissionBudgetStatus> {
		try {
			if (!enabled || signal.aborted) return "denied";
			if (!available) return "unknown";
			const result = database
				.transaction(() => reserveTransaction(database, request, signal))
				.immediate();
			return signal.aborted ? "denied" : result;
		} catch (error) {
			return error === DENIED ? "denied" : "unknown";
		}
	}
	return Object.freeze({
		async reserve(request: Request, signal: AbortSignal): Promise<RelayAdmissionBudgetStatus> {
			try {
				const captured = { ...request };
				if (!validRequest(captured, realmId)) return "denied";
				return await reserve(captured, signal);
			} catch {
				return "unknown";
			}
		},
		reserveUpgrade: (signal: AbortSignal) =>
			reserve({ purpose: "upgrade", realmId, deviceId: "", peerDeviceId: null, units: 1 }, signal),
	});
}
