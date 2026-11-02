export const ADMISSION_BUDGET_POOLS = Object.freeze([
	"authority",
	"relay-route",
	"relay-registration",
	"traversal",
	"device",
	"device-registration",
] as const);
export type AdmissionBudgetPool = (typeof ADMISSION_BUDGET_POOLS)[number];

const INGRESS = "'relay-route','relay-registration','traversal'";
// Each committed child sum fits a safe-integer parent. Adding one safe value still
// fits SQLite's signed integer range before an excessive allocation is rejected.
const INVALID_HIERARCHY = `(NEW.pool <> 'authority' AND NOT EXISTS (
 SELECT 1 FROM admission_budget_allocations r WHERE r.authority_id = NEW.authority_id
 AND r.pool = 'authority' AND r.audience_id = '' AND r.group_id = ''))
 OR (NEW.group_id <> '' AND NOT EXISTS (
 SELECT 1 FROM admission_budget_allocations p WHERE p.authority_id = NEW.authority_id
 AND p.pool = NEW.pool AND p.audience_id = NEW.audience_id AND p.group_id = ''))
 OR EXISTS (SELECT 1 FROM admission_budget_allocations p
 WHERE p.authority_id = NEW.authority_id AND p.group_id = '' AND (
 (p.pool = 'authority' AND (
  p.rate_per_min < (SELECT COALESCE(SUM(c.rate_per_min),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool IN (${INGRESS}) AND c.group_id = '')
  OR p.burst < (SELECT COALESCE(SUM(c.burst),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool IN (${INGRESS}) AND c.group_id = '')))
 OR (p.pool IN (${INGRESS}) AND (
  p.rate_per_min < (SELECT COALESCE(SUM(c.rate_per_min),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool = p.pool
    AND c.audience_id = p.audience_id AND c.group_id <> '')
  OR p.burst < (SELECT COALESCE(SUM(c.burst),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool = p.pool
    AND c.audience_id = p.audience_id AND c.group_id <> '')))))`;

/** Inert metadata only. Positive allocations require separate trusted provisioning. */
export const ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	`CREATE TABLE IF NOT EXISTS admission_budget_allocations (
 authority_id TEXT NOT NULL CHECK (typeof(authority_id) = 'text'
  AND length(CAST(authority_id AS BLOB)) = 64 AND authority_id NOT GLOB '*[^0-9a-f]*'
  AND instr(authority_id,char(0)) = 0),
 pool TEXT NOT NULL CHECK (pool IN (${ADMISSION_BUDGET_POOLS.map((pool) => `'${pool}'`).join(",")})),
 audience_id TEXT NOT NULL CHECK (typeof(audience_id) = 'text' AND instr(audience_id,char(0)) = 0
  AND ((pool IN ('relay-route','relay-registration') AND length(CAST(audience_id AS BLOB)) = 64
   AND audience_id NOT GLOB '*[^0-9a-f]*')
  OR (pool NOT IN ('relay-route','relay-registration') AND audience_id = ''))),
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text' AND instr(group_id,char(0)) = 0
  AND length(CAST(group_id AS BLOB)) <= 128
  AND (pool IN (${INGRESS}) OR group_id = '')),
 rate_per_min INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rate_per_min) = 'integer'
  AND rate_per_min BETWEEN 0 AND 9007199254740991),
 burst INTEGER NOT NULL DEFAULT 0 CHECK (typeof(burst) = 'integer' AND burst BETWEEN 0 AND 150119987579),
 CHECK ((rate_per_min = 0) = (burst = 0)),
 CHECK (pool <> 'device' OR (rate_per_min <= 96 AND burst <= 16)),
 CHECK (pool <> 'device-registration' OR (rate_per_min <= 2 AND burst <= 2)),
 PRIMARY KEY (authority_id,pool,audience_id,group_id)
 ) WITHOUT ROWID;`,
	`CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_collision
 BEFORE INSERT ON admission_budget_allocations
 WHEN EXISTS (SELECT 1 FROM admission_budget_allocations p WHERE p.authority_id = NEW.authority_id
 AND p.pool = NEW.pool AND p.audience_id = NEW.audience_id AND p.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT,'budget_allocation_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_keys
 BEFORE UPDATE ON admission_budget_allocations
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.pool IS NOT OLD.pool
 OR NEW.audience_id IS NOT OLD.audience_id OR NEW.group_id IS NOT OLD.group_id
 BEGIN SELECT RAISE(ABORT,'budget_allocation_keys'); END;`,
	...(["INSERT", "UPDATE"] as const).map(
		(
			operation,
		) => `CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_${operation.toLowerCase()}
 AFTER ${operation} ON admission_budget_allocations WHEN ${INVALID_HIERARCHY}
 BEGIN SELECT RAISE(ABORT,'budget_allocation_hierarchy'); END;`,
	),
	`CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_delete BEFORE DELETE ON admission_budget_allocations
 BEGIN SELECT RAISE(ABORT,'budget_allocation_permanent'); END;`,
]);
