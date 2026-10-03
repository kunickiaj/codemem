CREATE TABLE IF NOT EXISTS coordinator_auth_signin_purge_floors (
 coordinator_id TEXT NOT NULL PRIMARY KEY CHECK (length(coordinator_id) BETWEEN 1 AND 256),
 purged_through_created_at_ms INTEGER NOT NULL CHECK (typeof(purged_through_created_at_ms) = 'integer' AND purged_through_created_at_ms BETWEEN 0 AND 9007199254140991)
);
