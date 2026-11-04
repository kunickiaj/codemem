import type { D1DatabaseLike } from "@codemem/core/internal/cloudflare-coordinator";
import { relayServiceAudienceId } from "./relay-admission-options.js";
import type { RelayRealmConfig } from "./relay-config.js";

export interface RelayBudget {
	readonly ratePerMin: number;
	readonly burst: number;
}

/**
 * Default one-group profile, repeated per configured group in both relay ingress
 * pools. 120 route checks per minute admit about 40 route opens per minute,
 * because each open needs source, relay and responder checks. That stays below
 * the contract's realm open ceiling of 128 per minute. Each group-'' parent is
 * the sum of its children and the authority is the sum of those parents, so one
 * group gives authority 240/128 and eight groups give 960/512 per audience pool
 * and 1,920/1,024 at the authority. Device limits are the schema ceilings, which
 * equal the contract's per-device bounds.
 */
export const RELAY_GROUP_INGRESS_BUDGET: RelayBudget = Object.freeze({
	ratePerMin: 120,
	burst: 64,
});
export const RELAY_DEVICE_BUDGETS: Readonly<Record<"device" | "device-registration", RelayBudget>> =
	Object.freeze({
		device: Object.freeze({ ratePerMin: 96, burst: 16 }),
		"device-registration": Object.freeze({ ratePerMin: 2, burst: 2 }),
	});
const RELAY_INGRESS_POOLS = ["relay-route", "relay-registration"] as const;
const PARENT_INGRESS_POOLS = new Set<string>([...RELAY_INGRESS_POOLS, "traversal"]);
/** The allocation table's burst CHECK. Rates share the safe-integer limit. */
const MAX_BURST = 150_119_987_579;

export type RelayAdmissionSetupError =
	| "relay_audience_revoked"
	| "relay_budget_closed"
	| "relay_budget_ceiling"
	| "relay_admission_conflict";

interface AllocationRow {
	readonly pool: string;
	readonly audience_id: string;
	readonly group_id: string;
	readonly rate_per_min: number;
	readonly burst: number;
}

export interface RelayAdmissionSnapshot {
	readonly policy: { readonly revision: number; readonly state: string } | null;
	/** Stored state of the configured audience, or null when it has no row. */
	readonly audienceState: string | null;
	/** Stored realms of this authority, group ID to operator state. */
	readonly realms: ReadonlyMap<string, string>;
	readonly allocations: readonly AllocationRow[];
}

export interface RelayAdmissionTarget {
	readonly authorityId: string;
	readonly audienceId: string;
	readonly groupIds: readonly string[];
}

interface Statement {
	readonly sql: string;
	readonly values: readonly (string | number)[];
}

type Planned<T> = { readonly ok: true; readonly value: T } | Failed;
type Failed = { readonly ok: false; readonly error: RelayAdmissionSetupError };

export type RelayAdmissionPlan = Planned<{
	readonly statements: readonly Statement[];
	readonly policyRevision: number;
}>;

const POLICY_INSERT =
	"INSERT INTO relay_admission_authority_policy(authority_id,policy_revision,operator_state) VALUES (?1,1,'enabled')";
// The literal next revision reaches the update trigger, which aborts a stale batch.
const POLICY_BUMP =
	"UPDATE relay_admission_authority_policy SET policy_revision = ?2 WHERE authority_id = ?1";
const AUDIENCE_INSERT =
	"INSERT INTO relay_admission_audiences(authority_id,audience_id,state,changed_revision) VALUES (?1,?2,'enabled',?3)";
const REALM_INSERT =
	"INSERT INTO relay_admission_realms(authority_id,group_id,operator_state,changed_revision) VALUES (?1,?2,'enabled',?3)";
const ALLOCATION_INSERT =
	"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?1,?2,?3,?4,?5,?6)";
// Compare-and-swap against the snapshot (?7, ?8). A row an operator changed after
// the snapshot, for example closed to 0/0, matches nothing and is left as stored.
const ALLOCATION_RAISE = `UPDATE admission_budget_allocations
 SET rate_per_min = ?5, burst = ?6
 WHERE authority_id = ?1 AND pool = ?2 AND audience_id = ?3 AND group_id = ?4
 AND rate_per_min = ?7 AND burst = ?8`;
const READ_POLICY =
	"SELECT policy_revision, operator_state FROM relay_admission_authority_policy WHERE authority_id = ?1";
const READ_AUDIENCE =
	"SELECT state FROM relay_admission_audiences WHERE authority_id = ?1 AND audience_id = ?2";
const READ_REALMS =
	"SELECT group_id, operator_state FROM relay_admission_realms WHERE authority_id = ?1";
const READ_ALLOCATIONS =
	"SELECT pool, audience_id, group_id, rate_per_min, burst FROM admission_budget_allocations WHERE authority_id = ?1";

const failed = (error: RelayAdmissionSetupError): Failed => ({ ok: false, error });

/**
 * Policy, audience and realm rows. Inserts use the next policy revision, which
 * the same batch publishes first, as the metadata triggers require. Stored rows,
 * including disabled ones and realms no longer configured, are never changed.
 */
function planMetadata(target: RelayAdmissionTarget, snapshot: RelayAdmissionSnapshot) {
	if (snapshot.audienceState === "revoked") return failed("relay_audience_revoked");
	const { authorityId, audienceId } = target;
	const groups = target.groupIds.filter((group) => !snapshot.realms.has(group));
	const current = snapshot.policy?.revision ?? 0;
	if (snapshot.policy && snapshot.audienceState !== null && groups.length === 0)
		return { ok: true as const, value: { statements: [], policyRevision: current } };
	const revision = current + 1;
	if (!Number.isSafeInteger(revision)) return failed("relay_budget_ceiling");
	const policy = snapshot.policy
		? { sql: POLICY_BUMP, values: [authorityId, revision] }
		: { sql: POLICY_INSERT, values: [authorityId] };
	const audience =
		snapshot.audienceState === null
			? [{ sql: AUDIENCE_INSERT, values: [authorityId, audienceId, revision] }]
			: [];
	const realms = groups.map((group) => ({
		sql: REALM_INSERT,
		values: [authorityId, group, revision],
	}));
	return {
		ok: true as const,
		value: { statements: [policy, ...audience, ...realms], policyRevision: revision },
	};
}

const keyOf = (pool: string, audience: string, group: string) => `${pool}|${audience}|${group}`;
const sum = (budgets: readonly RelayBudget[]): RelayBudget => ({
	ratePerMin: budgets.reduce((total, budget) => total + budget.ratePerMin, 0),
	burst: budgets.reduce((total, budget) => total + budget.burst, 0),
});
const covers = (stored: RelayBudget, need: RelayBudget) =>
	stored.ratePerMin >= need.ratePerMin && stored.burst >= need.burst;

const larger = (a: RelayBudget, b: RelayBudget): RelayBudget => ({
	ratePerMin: Math.max(a.ratePerMin, b.ratePerMin),
	burst: Math.max(a.burst, b.burst),
});

/**
 * Inserts a missing row at `need`, or raises a stored row to cover `need` only
 * if it still holds its snapshot values. A stored 0/0 row is an operator
 * closure, so it is never reopened here.
 */
function fit(
	authorityId: string,
	slot: { pool: string; audience: string; group: string },
	stored: RelayBudget | undefined,
	need: RelayBudget,
): Planned<Statement | null> {
	if (stored && covers(stored, need)) return { ok: true, value: null };
	if (stored && stored.ratePerMin === 0) return failed("relay_budget_closed");
	if (!Number.isSafeInteger(need.ratePerMin) || need.burst > MAX_BURST)
		return failed("relay_budget_ceiling");
	const key = [authorityId, slot.pool, slot.audience, slot.group];
	if (!stored)
		return {
			ok: true,
			value: { sql: ALLOCATION_INSERT, values: [...key, need.ratePerMin, need.burst] },
		};
	const raised = larger(stored, need);
	return {
		ok: true,
		value: {
			sql: ALLOCATION_RAISE,
			values: [...key, raised.ratePerMin, raised.burst, stored.ratePerMin, stored.burst],
		},
	};
}

const budgetOf = (row: AllocationRow): RelayBudget => ({
	ratePerMin: row.rate_per_min,
	burst: row.burst,
});
const budgetsOf = (rows: readonly AllocationRow[]): Map<string, RelayBudget> =>
	new Map(rows.map((row) => [keyOf(row.pool, row.audience_id, row.group_id), budgetOf(row)]));
/**
 * Parent then new children for one relay ingress pool at the configured
 * audience. The parent must cover every stored child, including groups no longer
 * configured, plus each new child. `total` is the parent after this batch.
 */
function planIngressPool(
	target: RelayAdmissionTarget,
	rows: readonly AllocationRow[],
	pool: (typeof RELAY_INGRESS_POOLS)[number],
): Planned<{ parent: Statement | null; children: Statement[]; total: RelayBudget }> {
	const { authorityId, audienceId } = target;
	const stored = budgetsOf(rows);
	const added = target.groupIds.filter((group) => !stored.has(keyOf(pool, audienceId, group)));
	const siblings = rows.filter(
		(row) => row.pool === pool && row.audience_id === audienceId && row.group_id !== "",
	);
	const need = sum([...siblings.map(budgetOf), ...added.map(() => RELAY_GROUP_INGRESS_BUDGET)]);
	const current = stored.get(keyOf(pool, audienceId, ""));
	const parent = fit(authorityId, { pool, audience: audienceId, group: "" }, current, need);
	if (!parent.ok) return parent;
	const { ratePerMin, burst } = RELAY_GROUP_INGRESS_BUDGET;
	const children = added.map((group) => ({
		sql: ALLOCATION_INSERT,
		values: [authorityId, pool, audienceId, group, ratePerMin, burst],
	}));
	const total = current ? larger(current, need) : need;
	return { ok: true, value: { parent: parent.value, children, total } };
}

/**
 * Allocation rows, ordered so every statement passes the AFTER hierarchy
 * triggers: the authority covers the raised parents, the parents cover their new
 * children, and device rows follow the authority. Child and device rows are only
 * inserted, never raised.
 */
function planBudgets(target: RelayAdmissionTarget, rows: readonly AllocationRow[]) {
	const { authorityId, audienceId } = target;
	const pools = RELAY_INGRESS_POOLS.map((pool) => planIngressPool(target, rows, pool));
	const parents: Statement[] = [];
	const children: Statement[] = [];
	const totals: RelayBudget[] = [];
	for (const pool of pools) {
		if (!pool.ok) return pool;
		if (pool.value.parent) parents.push(pool.value.parent);
		children.push(...pool.value.children);
		totals.push(pool.value.total);
	}
	// Every other group-'' ingress parent, such as an earlier audience, still counts.
	const planned = new Set(RELAY_INGRESS_POOLS.map((pool) => keyOf(pool, audienceId, "")));
	const others = rows.filter(
		(row) =>
			row.group_id === "" &&
			PARENT_INGRESS_POOLS.has(row.pool) &&
			!planned.has(keyOf(row.pool, row.audience_id, "")),
	);
	const stored = budgetsOf(rows);
	const authority = fit(
		authorityId,
		{ pool: "authority", audience: "", group: "" },
		stored.get(keyOf("authority", "", "")),
		sum([...totals, ...others.map(budgetOf)]),
	);
	if (!authority.ok) return authority;
	const devices = Object.entries(RELAY_DEVICE_BUDGETS)
		.filter(([pool]) => !stored.has(keyOf(pool, "", "")))
		.map(([pool, budget]) => ({
			sql: ALLOCATION_INSERT,
			values: [authorityId, pool, "", "", budget.ratePerMin, budget.burst],
		}));
	const head = authority.value ? [authority.value] : [];
	// A raise that matched no row writes nothing, so the batch relies on a later
	// trigger to abort. Every child insert fires the AFTER INSERT hierarchy
	// trigger, which rechecks the authority against all ingress parents and every
	// parent against its children. A raise is only needed to admit a new child, so
	// a plan with a raise and no child insert comes from an inconsistent snapshot.
	const raises = [...head, ...parents].some((statement) => statement.sql === ALLOCATION_RAISE);
	if (raises && children.length === 0) return failed("relay_admission_conflict");
	return { ok: true as const, value: [...head, ...devices, ...parents, ...children] };
}

/** Pure plan from one consistent snapshot. An empty statement list means nothing to write. */
export function planRelayAdmissionSetup(
	target: RelayAdmissionTarget,
	snapshot: RelayAdmissionSnapshot,
): RelayAdmissionPlan {
	const metadata = planMetadata(target, snapshot);
	if (!metadata.ok) return metadata;
	const budgets = planBudgets(target, snapshot.allocations);
	if (!budgets.ok) return budgets;
	return {
		ok: true,
		value: {
			statements: [...metadata.value.statements, ...budgets.value],
			policyRevision: metadata.value.policyRevision,
		},
	};
}

function resultRows<T>(result: unknown): T[] {
	const rows = (result as { results?: unknown } | null)?.results;
	if (!Array.isArray(rows)) throw new Error("relay_admission_read_failed");
	return rows as T[];
}

type Batch = NonNullable<D1DatabaseLike["batch"]>;

function batchOf(db: D1DatabaseLike): Batch {
	const batch = db.batch?.bind(db);
	if (!batch) throw new Error("relay_admission_batch_unavailable");
	return batch;
}

/** One read batch, so the plan starts from a single consistent snapshot. */
export async function readRelayAdmissionSnapshot(
	db: D1DatabaseLike,
	target: RelayAdmissionTarget,
): Promise<RelayAdmissionSnapshot> {
	const { authorityId, audienceId } = target;
	const [policy, audience, realms, allocations] = await batchOf(db)([
		db.prepare(READ_POLICY).bind(authorityId),
		db.prepare(READ_AUDIENCE).bind(authorityId, audienceId),
		db.prepare(READ_REALMS).bind(authorityId),
		db.prepare(READ_ALLOCATIONS).bind(authorityId),
	]);
	const [policyRow] = resultRows<{ policy_revision: number; operator_state: string }>(policy);
	const [audienceRow] = resultRows<{ state: string }>(audience);
	return {
		policy: policyRow
			? { revision: policyRow.policy_revision, state: policyRow.operator_state }
			: null,
		audienceState: audienceRow?.state ?? null,
		realms: new Map(
			resultRows<{ group_id: string; operator_state: string }>(realms).map((row) => [
				row.group_id,
				row.operator_state,
			]),
		),
		allocations: resultRows<AllocationRow>(allocations),
	};
}

/**
 * RAISE messages of the metadata and allocation triggers that a concurrent
 * writer or a stale snapshot can reach. Local D1 reports a trigger abort as
 * "D1_ERROR: relay_policy_revision: SQLITE_CONSTRAINT (extended:
 * SQLITE_CONSTRAINT_TRIGGER)", with the same text minus the prefix as its cause.
 */
export const RELAY_ADMISSION_RACE_ABORTS: ReadonlySet<string> = new Set([
	"relay_policy_collision",
	"relay_policy_revision",
	"relay_audience_collision",
	"relay_audience_revision",
	"relay_realm_collision",
	"relay_realm_revision",
	"budget_allocation_collision",
	"budget_allocation_hierarchy",
]);
/** The RAISE text sits directly before SQLite's constraint code. */
const RAISE_TEXT = /(?:^|: )([a-z_]+): SQLITE_CONSTRAINT\b/;

/** True only when the D1 error names one of the trigger aborts above. */
export function isRelayAdmissionRaceAbort(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const cause = error.cause instanceof Error ? error.cause.message : "";
	return [error.message, cause].some((message) => {
		const name = RAISE_TEXT.exec(message)?.[1];
		return name !== undefined && RELAY_ADMISSION_RACE_ABORTS.has(name);
	});
}

export type RelayAdmissionSetupResult =
	| { readonly ok: true; readonly body: Record<string, unknown> }
	| Failed;

export async function relayAdmissionTarget(
	config: RelayRealmConfig,
): Promise<RelayAdmissionTarget> {
	return {
		authorityId: config.authorityId,
		audienceId: await relayServiceAudienceId(config),
		groupIds: [...config.realms.values()],
	};
}

/**
 * Plans from `snapshot` and writes the plan in one atomic batch. A plan from a
 * stale snapshot reaches a trigger and returns relay_admission_conflict.
 */
export async function applyRelayAdmissionSetup(
	db: D1DatabaseLike,
	config: RelayRealmConfig,
	target: RelayAdmissionTarget,
	snapshot: RelayAdmissionSnapshot,
): Promise<RelayAdmissionSetupResult> {
	const plan = planRelayAdmissionSetup(target, snapshot);
	if (!plan.ok) return plan;
	const { statements, policyRevision } = plan.value;
	if (statements.length > 0) {
		try {
			await batchOf(db)(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)));
		} catch (error) {
			if (isRelayAdmissionRaceAbort(error)) return failed("relay_admission_conflict");
			throw error;
		}
	}
	return {
		ok: true,
		body: {
			authority_id: target.authorityId,
			audience_id: target.audienceId,
			policy_revision: policyRevision,
			policy_state: snapshot.policy?.state ?? "enabled",
			changed: statements.length > 0,
			realms: [...config.realms].map(([realmId, groupId]) => ({
				realm_id: realmId,
				group_id: groupId,
				operator_state: snapshot.realms.get(groupId) ?? "enabled",
			})),
			// Readiness has its own writer, so a fresh setup still denies every check.
			readiness: "not_written",
		},
	};
}

/**
 * Writes the authority policy, audience, realm rows and admission budget
 * allocations for the Worker's relay config in one atomic batch. A repeated call
 * with the same config writes nothing. Readiness rows are never written here.
 */
export async function provisionRelayAdmission(
	db: D1DatabaseLike,
	config: RelayRealmConfig,
): Promise<RelayAdmissionSetupResult> {
	const target = await relayAdmissionTarget(config);
	const snapshot = await readRelayAdmissionSnapshot(db, target);
	return applyRelayAdmissionSetup(db, config, target, snapshot);
}
