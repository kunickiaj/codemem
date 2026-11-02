import {
	ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS,
	ADMISSION_BUDGET_POOLS,
} from "./admission-budget-allocation-schema.js";

/** Inert definitions, never installed at startup by this module. */
export const ADMISSION_BUDGET_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	...ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS,
	`CREATE TABLE IF NOT EXISTS admission_budget_buckets (
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
  AND (pool <> 'authority' OR group_id = '')
  AND (pool NOT IN ('device','device-registration') OR length(CAST(group_id AS BLOB)) >= 1)),
 device_id TEXT NOT NULL CHECK (typeof(device_id) = 'text' AND instr(device_id,char(0)) = 0
  AND ((pool IN ('device','device-registration') AND length(CAST(device_id AS BLOB)) BETWEEN 1 AND 64
   AND device_id NOT GLOB '*[^!-~]*')
  OR (pool NOT IN ('device','device-registration') AND device_id = ''))),
 units INTEGER NOT NULL CHECK (typeof(units) = 'integer' AND units BETWEEN 0 AND last_capacity),
 refilled_at_ms INTEGER NOT NULL CHECK (typeof(refilled_at_ms) = 'integer' AND refilled_at_ms BETWEEN 0 AND 9007199254740991),
 last_rate INTEGER NOT NULL CHECK (typeof(last_rate) = 'integer' AND last_rate BETWEEN 0 AND 9007199254740991),
 last_capacity INTEGER NOT NULL CHECK (typeof(last_capacity) = 'integer'
  AND last_capacity BETWEEN 0 AND 9007199254740991 AND last_capacity % 60000 = 0),
 exec_id TEXT NOT NULL CHECK (typeof(exec_id) = 'text' AND length(CAST(exec_id AS BLOB)) = 32
  AND exec_id NOT GLOB '*[^0-9a-f]*' AND instr(exec_id,char(0)) = 0),
 granted INTEGER NOT NULL CHECK (typeof(granted) = 'integer' AND granted IN (0,1)),
 CHECK ((last_rate = 0) = (last_capacity = 0)),
 CHECK (pool <> 'device' OR (last_rate <= 96 AND last_capacity <= 960000)),
 CHECK (pool <> 'device-registration' OR (last_rate <= 2 AND last_capacity <= 120000)),
 CHECK ((granted = 1 AND last_rate > 0 AND units <= last_capacity - 60000)
  OR (granted = 0 AND units < 60000)),
 PRIMARY KEY (authority_id,pool,audience_id,group_id,device_id)
 ) WITHOUT ROWID;`,
	`CREATE TRIGGER IF NOT EXISTS admission_budget_bucket_allocation BEFORE INSERT ON admission_budget_buckets
 WHEN NOT EXISTS (SELECT 1 FROM admission_budget_allocations p
 WHERE p.authority_id = NEW.authority_id AND p.pool = NEW.pool AND p.audience_id = NEW.audience_id
 AND p.group_id = CASE WHEN NEW.pool IN ('device','device-registration') THEN '' ELSE NEW.group_id END)
 BEGIN SELECT RAISE(ABORT,'budget_bucket_allocation'); END;`,
	`CREATE TRIGGER IF NOT EXISTS admission_budget_bucket_update BEFORE UPDATE ON admission_budget_buckets
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.pool IS NOT OLD.pool
 OR NEW.audience_id IS NOT OLD.audience_id OR NEW.group_id IS NOT OLD.group_id OR NEW.device_id IS NOT OLD.device_id
 OR NEW.refilled_at_ms < OLD.refilled_at_ms OR NEW.exec_id IS OLD.exec_id
 BEGIN SELECT RAISE(ABORT,'budget_bucket_update'); END;`,
	`CREATE TRIGGER IF NOT EXISTS admission_budget_bucket_delete BEFORE DELETE ON admission_budget_buckets
 BEGIN SELECT RAISE(ABORT,'budget_bucket_permanent'); END;`,
]);
