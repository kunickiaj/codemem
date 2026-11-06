import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
	AUTH_V2_SCHEMA_READINESS_SQL,
	readConnectionSchemaState,
} from "../../core/src/coordinator-account-connection-schema.js";
import {
	checkHeadlessCodeEntry,
	HEADLESS_CODE_ENTRY_CLIENT_LIMIT,
	HEADLESS_CODE_ENTRY_WINDOW_MS,
	recordHeadlessCodeEntryFailure,
} from "../../core/src/coordinator-auth-headless-code-limits.js";
import {
	HEADLESS_CODE_LIMITS_TABLE,
	HEADLESS_LINK_PROVENANCE_TABLE,
	HEADLESS_LINK_SCHEMA_STATEMENTS,
	readHeadlessLinkBackend,
} from "../../core/src/coordinator-auth-headless-schema.js";
import { createD1AuthLinkBackend } from "../../core/src/d1-coordinator-store.js";

const db = env.COORDINATOR_DB;
const T0 = 1_800_000_000_000;
const entry = (nowMs: number) => ({ coordinatorId: "native-headless", clientKey: "192.0.2.10", nowMs });

async function readiness() {
	return {
		v2: await db.prepare(AUTH_V2_SCHEMA_READINESS_SQL).first(),
		connections: await readConnectionSchemaState(createD1AuthLinkBackend(db)),
	};
}

it("native D1 migrations create both headless tables", async () => {
	// Arrange
	const backend = createD1AuthLinkBackend(db);
	// Act / Assert: headless routes stay off unless this check sees both migrated tables.
	expect(await readHeadlessLinkBackend(backend)).toBe(backend);
});

it("leaves existing auth readiness unchanged with or without the headless tables", async () => {
	// Arrange
	const withTables = await readiness();
	await db.batch([
		db.prepare(`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}`),
		db.prepare(`DROP TABLE ${HEADLESS_LINK_PROVENANCE_TABLE}`),
	]);
	try {
		// Act
		const withoutTables = await readiness();
		// Assert
		expect(withoutTables).toEqual(withTables);
		expect(await readHeadlessLinkBackend(createD1AuthLinkBackend(db))).toBeNull();
	} finally {
		await db.batch(HEADLESS_LINK_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
	}
});

it("counts concurrent failures from two native D1 backends against one window", async () => {
	// Arrange
	const a = createD1AuthLinkBackend(db);
	const b = createD1AuthLinkBackend(db);
	const half = HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2;
	// Act: every failure lands exactly at the boundary of a window that started earlier.
	await recordHeadlessCodeEntryFailure(a, entry(T0 - HEADLESS_CODE_ENTRY_WINDOW_MS));
	await Promise.all(
		[...Array(half).fill(a), ...Array(half).fill(b)].map((backend) =>
			recordHeadlessCodeEntryFailure(backend, entry(T0)),
		),
	);
	// Assert
	const rows = await db
		.prepare(`SELECT scope, window_start_ms, failures FROM ${HEADLESS_CODE_LIMITS_TABLE} ORDER BY scope`)
		.all();
	expect(rows.results).toEqual([
		{ scope: "client", window_start_ms: T0, failures: HEADLESS_CODE_ENTRY_CLIENT_LIMIT },
		{ scope: "coordinator", window_start_ms: T0, failures: HEADLESS_CODE_ENTRY_CLIENT_LIMIT },
	]);
	expect(await checkHeadlessCodeEntry(b, entry(T0 + 1))).toEqual({
		allowed: false,
		retryAfterMs: HEADLESS_CODE_ENTRY_WINDOW_MS - 1,
	});
});
