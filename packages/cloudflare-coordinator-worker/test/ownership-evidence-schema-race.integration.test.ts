import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureControllerHistory } from "../../core/src/coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { CoordinatorDeviceOwnershipEvidence } from "../../core/src/coordinator-device-ownership-evidence.js";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { readLegacyOwnerResolutionSchemaState } from "../../core/src/coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS } from "../../core/src/coordinator-legacy-owner-resolution-schema.js";

const db = env.COORDINATOR_DB;
const table = "coordinator_legacy_owner_resolutions";
const extraTrigger = "unexpected_ownership_evidence_trigger";
const drops = [
	{
		name: "immutability trigger",
		object: "legacy_owner_resolution_immutable_update",
		sql: "DROP TRIGGER legacy_owner_resolution_immutable_update",
	},
	{
		name: "required index",
		object: "idx_legacy_owner_resolutions_device",
		sql: "DROP INDEX idx_legacy_owner_resolutions_device",
	},
] as const;
type CatalogRow = [type: string, name: string, table: string, sql: string];
const groups: string[] = [];

async function restoreSchema() {
	await db.batch(LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}

async function catalog() {
	const { results } = await db
		.prepare(
			"SELECT json_array(type,name,tbl_name,sql) AS row FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL ORDER BY row",
		)
		.bind(table)
		.all<{ row: string }>();
	return results.map(({ row }) => JSON.parse(row) as CatalogRow);
}

async function tableData() {
	const { results } = await db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,4) <> '_cf_' AND name NOT GLOB 'sqlite_*' ORDER BY name",
		)
		.all<{ name: string }>();
	return Promise.all(
		results.map(async ({ name }) => [
			name,
			(await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).results,
		]),
	);
}

// Execute every proof on the native binding; hooks only interleave actual DDL.
function evidenceBackend(
	hooks: { afterReadiness?: () => Promise<unknown>; afterCapture?: () => Promise<unknown> } = {},
) {
	const observed = {
		readiness: [] as { type: string; sql: string }[][],
		captured: [] as CatalogRow[][],
		atomic: [] as unknown[],
	};
	const backend = {
		async first<T>(statement: AuthLinkStatement): Promise<T | null> {
			const result = await db
				.prepare(statement.sql)
				.bind(...statement.values)
				.first<T>();
			if (statement.sql.includes("AS objects")) {
				observed.readiness.push(JSON.parse((result as { objects: string }).objects));
				if (observed.readiness.length === 1) await hooks.afterReadiness?.();
			} else if (statement.sql.includes("AS matches")) {
				observed.atomic.push(result);
			}
			return result;
		},
		async all<T>(statement: AuthLinkStatement): Promise<T[]> {
			const { results } = await db
				.prepare(statement.sql)
				.bind(...statement.values)
				.all<T>();
			if (statement.sql.includes("json_array(type,name,tbl_name,sql)")) {
				observed.captured.push(
					(results as { category: string; row: string }[])
						.filter(({ category }) => category === "schema")
						.map(({ row }) => JSON.parse(row) as CatalogRow),
				);
				await hooks.afterCapture?.();
			}
			return results;
		},
	};
	return { backend, observed };
}

async function subject() {
	const coordinatorId = randomUUID();
	const groupId = randomUUID();
	groups.push(groupId);
	const actualSigner = {
		groupId,
		deviceId: randomUUID(),
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
	};
	const store = new D1CoordinatorStore(db);
	await store.createGroup(groupId, "Synthetic schema race fixture");
	await store.enrollDevice(groupId, actualSigner);
	const verifiedHistory = await captureControllerHistory(
		{ coordinatorId, ...actualSigner },
		async <T>(sql: string, values: string[]) =>
			(
				await db
					.prepare(sql)
					.bind(...values)
					.all<T>()
			).results,
	);
	return { coordinatorId, input: { canonicalOwnerId: "owner-a", actualSigner, verifiedHistory } };
}

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(async () => {
	try {
		await db.prepare(`DROP TRIGGER IF EXISTS ${extraTrigger}`).run();
		await restoreSchema();
		for (const groupId of groups.splice(0)) {
			await db.batch([
				db.prepare("DELETE FROM enrolled_devices WHERE group_id=?").bind(groupId),
				db.prepare("DELETE FROM groups WHERE group_id=?").bind(groupId),
			]);
		}
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});

it("native stable ready catalog collects without table writes at default SQL limits", async () => {
	// Arrange: empty history and receipt sets still require a valid captured schema.
	const { coordinatorId, input } = await subject();
	const { backend, observed } = evidenceBackend();
	const reader = new CoordinatorDeviceOwnershipEvidence(backend, { coordinatorId });
	const initial = await catalog();
	const before = await tableData();
	expect(await readLegacyOwnerResolutionSchemaState(evidenceBackend().backend)).toBe("ready");
	// Act
	const result = await reader.collect(input);
	// Assert: native evaluation of the full atomic query succeeds, not a mocked proof.
	expect(observed.captured).toEqual([initial]);
	expect(observed.atomic).toEqual([{ matches: 1 }]);
	expect(await tableData()).toEqual(before);
	expect(result).toMatchObject({ kind: "collected", decision: "compatible" });
});

it.for([
	...drops,
	{
		name: "unsupported extra trigger",
		object: extraTrigger,
		sql: `CREATE TRIGGER ${extraTrigger} AFTER INSERT ON ${table} BEGIN SELECT 1; END`,
	},
])("native rejects $name changed between readiness and capture", async (change) => {
	// Arrange: mutate only after the real successful readiness query has returned.
	const { coordinatorId, input } = await subject();
	const initial = await catalog();
	let changed: CatalogRow[] = [];
	const { backend, observed } = evidenceBackend({
		afterReadiness: async () => {
			await db.prepare(change.sql).run();
			changed = await catalog();
		},
	});
	const reader = new CoordinatorDeviceOwnershipEvidence(backend, { coordinatorId });
	const before = await tableData();
	expect(await readLegacyOwnerResolutionSchemaState(evidenceBackend().backend)).toBe("ready");
	// Act
	const result = await reader.collect(input);
	// Assert: accepted readiness rows precede the actual unsupported captured rowset.
	expect(observed.readiness[0]).toEqual(
		expect.arrayContaining(initial.map(([type, , , sql]) => ({ type, sql }))),
	);
	expect(changed).not.toEqual(initial);
	expect(observed.captured).toEqual([changed]);
	expect(await readLegacyOwnerResolutionSchemaState(evidenceBackend().backend)).toBe("unsupported");
	expect(await tableData()).toEqual(before);
	expect(result).toEqual({ kind: "unavailable", authorizationUnavailable: true });
});

it.for(drops)("native rejects captured missing $name despite later restoration", async (change) => {
	// Arrange: a later ready catalog must not replace validation of captured rows.
	const { coordinatorId, input } = await subject();
	const initial = await catalog();
	const { backend, observed } = evidenceBackend({
		afterReadiness: () => db.prepare(change.sql).run(),
		afterCapture: restoreSchema,
	});
	const reader = new CoordinatorDeviceOwnershipEvidence(backend, { coordinatorId });
	const before = await tableData();
	// Act
	const result = await reader.collect(input);
	// Assert: reject before atomic comparison and before producing a recheck token.
	expect(observed.captured).toEqual([initial.filter(([, name]) => name !== change.object)]);
	expect(await catalog()).toEqual(initial);
	expect(await readLegacyOwnerResolutionSchemaState(evidenceBackend().backend)).toBe("ready");
	expect(await tableData()).toEqual(before);
	expect(result).toEqual({ kind: "unavailable", authorizationUnavailable: true });
	expect(result).not.toHaveProperty("recheckSnapshot");
	expect(observed.atomic).toEqual([]);
});
