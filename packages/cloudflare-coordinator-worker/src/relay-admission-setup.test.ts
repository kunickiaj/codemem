import { describe, expect, it } from "vitest";
import {
	isRelayAdmissionRaceAbort,
	planRelayAdmissionSetup,
	type RelayAdmissionSnapshot,
	type RelayAdmissionTarget,
} from "./relay-admission-setup.js";

const A = "a".repeat(64);
const OLD_AUDIENCE = "b".repeat(64);
const NEW_AUDIENCE = "c".repeat(64);
const POOLS = ["relay-route", "relay-registration"] as const;

type Row = RelayAdmissionSnapshot["allocations"][number];
const row = (pool: string, audience: string, group: string, rate: number, burst: number): Row => ({
	pool,
	audience_id: audience,
	group_id: group,
	rate_per_min: rate,
	burst,
});

/** The rows a completed setup leaves for `groups` at one audience, at revision 1. */
function setUp(groups: readonly string[], audience = OLD_AUDIENCE): RelayAdmissionSnapshot {
	const n = groups.length;
	return {
		policy: { revision: 1, state: "enabled" },
		audienceState: "enabled",
		realms: new Map(groups.map((group) => [group, "enabled"])),
		allocations: [
			row("authority", "", "", 240 * n, 128 * n),
			row("device", "", "", 96, 16),
			row("device-registration", "", "", 2, 2),
			...POOLS.flatMap((pool) => [
				row(pool, audience, "", 120 * n, 64 * n),
				...groups.map((group) => row(pool, audience, group, 120, 64)),
			]),
		],
	};
}

/** Replaces stored allocation rows that share a pool, audience and group. */
function withRows(snapshot: RelayAdmissionSnapshot, ...rows: Row[]): RelayAdmissionSnapshot {
	const key = (r: Row) => `${r.pool}|${r.audience_id}|${r.group_id}`;
	const replaced = new Set(rows.map(key));
	return {
		...snapshot,
		allocations: [...snapshot.allocations.filter((r) => !replaced.has(key(r))), ...rows],
	};
}

const target = (groups: readonly string[], audience = OLD_AUDIENCE): RelayAdmissionTarget => ({
	authorityId: A,
	audienceId: audience,
	groupIds: groups,
});

/** Each statement as its verb and table, then its bound values. */
function shape(plan: ReturnType<typeof planRelayAdmissionSetup>) {
	if (!plan.ok) return plan;
	return {
		policyRevision: plan.value.policyRevision,
		statements: plan.value.statements.map(({ sql, values }) => {
			const [, verb, table] = /^(INSERT INTO|UPDATE) (\w+)/.exec(sql) ?? [];
			return [`${verb === "UPDATE" ? "update" : "insert"} ${table}`, ...values];
		}),
	};
}

const RAISE = "update admission_budget_allocations";
const ADD = "insert admission_budget_allocations";
const BUMP = "update relay_admission_authority_policy";
const REALM = "insert relay_admission_realms";

const CASES: readonly [string, RelayAdmissionTarget, RelayAdmissionSnapshot, unknown][] = [
	[
		"a key rotation raises the authority before the new parents and children",
		target(["g1", "g2"], NEW_AUDIENCE),
		{ ...setUp(["g1", "g2"]), audienceState: null },
		{
			policyRevision: 2,
			statements: [
				[BUMP, A, 2],
				["insert relay_admission_audiences", A, NEW_AUDIENCE, 2],
				[RAISE, A, "authority", "", "", 960, 512, 480, 256],
				[ADD, A, "relay-route", NEW_AUDIENCE, "", 240, 128],
				[ADD, A, "relay-registration", NEW_AUDIENCE, "", 240, 128],
				[ADD, A, "relay-route", NEW_AUDIENCE, "g1", 120, 64],
				[ADD, A, "relay-route", NEW_AUDIENCE, "g2", 120, 64],
				[ADD, A, "relay-registration", NEW_AUDIENCE, "g1", 120, 64],
				[ADD, A, "relay-registration", NEW_AUDIENCE, "g2", 120, 64],
			],
		},
	],
	[
		"a hand-lowered child stays 60/32 while its parent rises to cover a new group",
		target(["g1", "g2"]),
		withRows(setUp(["g1"]), row("relay-route", OLD_AUDIENCE, "g1", 60, 32)),
		{
			policyRevision: 2,
			statements: [
				[BUMP, A, 2],
				[REALM, A, "g2", 2],
				[RAISE, A, "authority", "", "", 420, 224, 240, 128],
				[RAISE, A, "relay-route", OLD_AUDIENCE, "", 180, 96, 120, 64],
				[RAISE, A, "relay-registration", OLD_AUDIENCE, "", 240, 128, 120, 64],
				[ADD, A, "relay-route", OLD_AUDIENCE, "g2", 120, 64],
				[ADD, A, "relay-registration", OLD_AUDIENCE, "g2", 120, 64],
			],
		},
	],
	[
		"a disabled realm stays disabled and nothing is written",
		target(["g1", "g2"]),
		{
			...setUp(["g1", "g2"]),
			realms: new Map([
				["g1", "enabled"],
				["g2", "disabled"],
			]),
		},
		{ policyRevision: 1, statements: [] },
	],
	[
		"a closed pool with no new child is left closed",
		target(["g1"]),
		withRows(
			setUp(["g1"]),
			row("relay-registration", OLD_AUDIENCE, "", 0, 0),
			row("relay-registration", OLD_AUDIENCE, "g1", 0, 0),
		),
		{ policyRevision: 1, statements: [] },
	],
	[
		"a closed pool refuses a new group even while the other pool is open",
		target(["g1", "g2"]),
		withRows(
			setUp(["g1"]),
			row("relay-registration", OLD_AUDIENCE, "", 0, 0),
			row("relay-registration", OLD_AUDIENCE, "g1", 0, 0),
		),
		{ ok: false, error: "relay_budget_closed" },
	],
	[
		"a parent burst beyond the schema ceiling is refused",
		target(["g1", "g2"]),
		withRows(
			setUp(["g1"]),
			row("relay-route", OLD_AUDIENCE, "", 120, 150_119_987_570),
			row("relay-route", OLD_AUDIENCE, "g1", 120, 150_119_987_570),
		),
		{ ok: false, error: "relay_budget_ceiling" },
	],
	[
		"a raise with no child to admit, from an inconsistent snapshot, is refused",
		target(["g1"]),
		withRows(setUp(["g1"]), row("relay-route", OLD_AUDIENCE, "", 60, 32)),
		{ ok: false, error: "relay_admission_conflict" },
	],
	[
		"a revoked audience is refused",
		target(["g1"]),
		{ ...setUp(["g1"]), audienceState: "revoked" },
		{ ok: false, error: "relay_audience_revoked" },
	],
];

describe("relay admission setup plan", () => {
	it.each(CASES)("%s", (_name, planTarget, snapshot, expected) => {
		// Act
		const plan = planRelayAdmissionSetup(planTarget, snapshot);
		// Assert
		expect(shape(plan)).toEqual(expected);
	});

	it("bumps a disabled policy's revision and never writes its state", () => {
		// Arrange
		const snapshot = { ...setUp(["g1"]), policy: { revision: 4, state: "disabled" } };
		// Act
		const plan = planRelayAdmissionSetup(target(["g1", "g2"]), snapshot);
		// Assert
		if (!plan.ok) throw new Error(plan.error);
		const [policy, realm] = plan.value.statements;
		expect(plan.value.policyRevision).toBe(5);
		expect([policy?.values, realm?.values]).toEqual([
			[A, 5],
			[A, "g2", 5],
		]);
		expect(policy?.sql).not.toContain("operator_state");
	});

	it("raises only a row that still holds its snapshot values", () => {
		// Arrange: a stored rate above the need is kept while the burst rises.
		const snapshot = withRows(setUp(["g1"]), row("relay-route", OLD_AUDIENCE, "", 300, 64));
		// Act
		const plan = planRelayAdmissionSetup(target(["g1", "g2"]), snapshot);
		// Assert
		if (!plan.ok) throw new Error(plan.error);
		const raises = plan.value.statements.filter(({ sql }) => sql.startsWith("UPDATE admission"));
		expect(raises.map(({ values }) => values)).toEqual([
			[A, "authority", "", "", 540, 256, 240, 128],
			[A, "relay-route", OLD_AUDIENCE, "", 300, 128, 300, 64],
			[A, "relay-registration", OLD_AUDIENCE, "", 240, 128, 120, 64],
		]);
		for (const { sql } of raises) {
			expect(sql).toContain("SET rate_per_min = ?5, burst = ?6");
			expect(sql).toContain("AND rate_per_min = ?7 AND burst = ?8");
			expect(sql).not.toContain("MAX(");
		}
	});

	it("writes the fresh profile in trigger order", () => {
		// Act
		const plan = planRelayAdmissionSetup(target(["g1"]), {
			policy: null,
			audienceState: null,
			realms: new Map(),
			allocations: [],
		});
		// Assert
		expect(shape(plan)).toEqual({
			policyRevision: 1,
			statements: [
				["insert relay_admission_authority_policy", A],
				["insert relay_admission_audiences", A, OLD_AUDIENCE, 1],
				[REALM, A, "g1", 1],
				[ADD, A, "authority", "", "", 240, 128],
				[ADD, A, "device", "", "", 96, 16],
				[ADD, A, "device-registration", "", "", 2, 2],
				[ADD, A, "relay-route", OLD_AUDIENCE, "", 120, 64],
				[ADD, A, "relay-registration", OLD_AUDIENCE, "", 120, 64],
				[ADD, A, "relay-route", OLD_AUDIENCE, "g1", 120, 64],
				[ADD, A, "relay-registration", OLD_AUDIENCE, "g1", 120, 64],
			],
		});
	});
});

const OBSERVED =
	"D1_ERROR: relay_policy_revision: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)";

describe("relay admission race abort", () => {
	it.each([
		["the observed D1 trigger abort", new Error(OBSERVED), true],
		[
			"the same abort on the cause only",
			new Error("D1_ERROR", { cause: new Error("budget_allocation_hierarchy: SQLITE_CONSTRAINT") }),
			true,
		],
		[
			"a permanent-row trigger",
			new Error("D1_ERROR: budget_allocation_permanent: SQLITE_CONSTRAINT"),
			false,
		],
		["a trigger name without a constraint code", new Error("relay_policy_revision failed"), false],
		[
			"a prefixed lookalike",
			new Error("D1_ERROR: xrelay_realm_revision: SQLITE_CONSTRAINT"),
			false,
		],
		["a thrown string", OBSERVED, false],
	])("classifies %s", (_name, error, expected) => {
		// Act + Assert
		expect(isRelayAdmissionRaceAbort(error)).toBe(expected);
	});
});
