import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";

// Only disposable test databases create this table. It mirrors the nonce ledger's
// timestamp and primary key without extending the ordinary coordinator schema.
export const RELAY_CLOCK_TEST_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS relay_clock_test_nonces (
	device_id TEXT NOT NULL,
	nonce TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (device_id, nonce)
)`;

export const RELAY_CLOCK_TEST_CLEAR_SQL = "DELETE FROM relay_clock_test_nonces";
export const RELAY_CLOCK_TEST_ROWS_SQL =
	"SELECT device_id, nonce, created_at FROM relay_clock_test_nonces";

// All runtime values are bound. Only the trusted source clock fragment is embedded.
// The WHERE also disambiguates SQLite's INSERT SELECT / ON CONFLICT grammar.
export const RELAY_CLOCK_TEST_INSERT_SQL = `
INSERT INTO relay_clock_test_nonces (device_id, nonce, created_at)
SELECT ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE ${RELAY_ADMISSION_CLOCK_SQL} >= 0 AND ${RELAY_ADMISSION_CLOCK_SQL} < ?4
ON CONFLICT(device_id, nonce) DO NOTHING
RETURNING device_id AS deviceId, nonce, ?3 AS attemptId,
	${RELAY_ADMISSION_CLOCK_SQL} AS decidedAtMs, created_at AS createdAt`;
