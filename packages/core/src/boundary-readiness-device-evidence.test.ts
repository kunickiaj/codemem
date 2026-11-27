import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupReadinessRequest } from "./boundary-readiness-device-evidence.js";
import { submitGroupBoundaryReadiness } from "./coordinator-boundary-readiness-client.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { connect, type Database } from "./db.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import { cacheScope, cacheWireSnapshot } from "./scope-membership-cache-test-fixtures.js";
import { verifySignature } from "./sync-auth.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";

const authority = "https://coordinator.example.test";
const group = "group-a";
const generation = "bb29cad9-89d9-4fef-9d17-b1e8088abec9";
const config = {
	sync_enabled: true,
	sync_coordinator_url: authority,
	sync_coordinator_groups: [group],
	sync_boundary_migration: "on",
};
const transport = vi.fn<typeof fetch>();
let directory: string;
let db: Database;
let input: GroupReadinessRequest;
let deviceId: string;
let publicKey: string;
let acknowledgement: Record<string, unknown>;
let configPath: string;

async function refresh(catalog: object, members?: object) {
	transport.mockResolvedValueOnce(
		Response.json({ version: 1, items: members ? [cacheScope()] : [], ...catalog }),
	);
	if (members)
		transport.mockResolvedValueOnce(Response.json({ ...cacheWireSnapshot(), ...members }));
	const result = await refreshScopeMembershipCache(db, {
		remoteUrl: authority,
		groupIds: [group],
		keysDir: input.keysDir,
		dbPath: input.dbPath,
	});
	expect(result.status).toBe("refreshed");
	transport.mockClear();
}

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "group-readiness-"));
	configPath = join(directory, "config.json");
	const dbPath = join(directory, "local.sqlite");
	const keysDir = join(directory, "keys");
	for (const key of [
		"SYNC_PROJECTS_INCLUDE",
		"SYNC_PROJECTS_EXCLUDE",
		"SYNC_BOUNDARY_MIGRATION",
		"SYNC_COORDINATOR_URL",
		"SYNC_COORDINATOR_GROUP",
		"SYNC_COORDINATOR_GROUPS",
		"SYNC_ENABLED",
		"DEVICE_ID",
	])
		vi.stubEnv(`CODEMEM_${key}`, undefined);
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	writeFileSync(configPath, JSON.stringify(config));
	db = connect(dbPath);
	[deviceId] = ensureDeviceIdentity(db, { keysDir });
	publicKey = loadPublicKey(keysDir) ?? "";
	db.prepare(`INSERT INTO scope_membership_cache_state(coordinator_id, group_id,last_refresh_at,last_success_at,updated_at,refresh_revision)
		VALUES(?,?,'now','now','now',8)`).run(authority, group);
	input = {
		dbPath,
		keysDir,
		configPath,
		coordinatorUrl: authority,
		groupId: group,
		groupGeneration: generation,
		sequence: 7,
		refreshRevision: 9,
	};
	acknowledgement = {
		version: 2,
		status: "stored",
		sequence: 7,
		rejected: [],
		device_id: deviceId,
		key_id: await ed25519KeyId(publicKey),
		group_id: group,
		group_generation: generation,
	};
	transport.mockReset().mockImplementation(async () => Response.json(acknowledgement));
	vi.stubGlobal("fetch", transport);
	await refresh({ group_generation: generation });
});

afterEach(() => {
	db?.close();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function sent() {
	expect(transport).toHaveBeenCalledTimes(1);
	const [url, init] = transport.mock.calls[0] ?? [];
	if (!init || !(init.body instanceof Uint8Array)) throw new Error("expected signed bytes");
	const target = new URL(String(url));
	const bodyBytes = Buffer.from(init.body);
	const body = JSON.parse(bodyBytes.toString("utf8"));
	const headers = new Headers(init.headers);
	return { body, bodyBytes, init, headers, target };
}

it.each([
	[
		"prior-generation catalogue",
		{ group_generation: "dad7131c-493b-4979-98a6-eef2339801aa" },
		undefined,
	],
	["legacy catalogue", {}, undefined],
	[
		"mixed-generation refresh",
		{ group_generation: generation },
		{ group_generation: "dad7131c-493b-4979-98a6-eef2339801aa" },
	],
] as const)(
	"sends nothing after a %s even at its exact revision",
	async (_label, catalog, members) => {
		await refresh(catalog, members);
		expect(await submitGroupBoundaryReadiness({ ...input, refreshRevision: 10 })).toEqual({
			kind: "failed",
			reason: "inventory_unavailable",
		});
		expect(transport).not.toHaveBeenCalled();
	},
);

it("an older writer refreshing without a generation cannot preserve the prior observation", async () => {
	db.exec(
		"UPDATE scope_membership_cache_state SET last_refresh_at='later', last_success_at='later', updated_at='later'",
	);
	expect(await submitGroupBoundaryReadiness(input)).toEqual({
		kind: "failed",
		reason: "inventory_unavailable",
	});
	expect(transport).not.toHaveBeenCalled();
});

it.each(["same-generation refresh", "generation invalidation"] as const)(
	"requires recollection if a %s commits during key hashing",
	async (change) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return digest(...args);
		});
		const pending = submitGroupBoundaryReadiness(input);
		try {
			await entered.promise;
			if (change === "same-generation refresh") await refresh({ group_generation: generation });
			else db.exec("UPDATE scope_membership_cache_state SET updated_at='later'");
		} finally {
			release.resolve();
			spy.mockRestore();
		}
		const result = await pending;
		expect(transport).not.toHaveBeenCalled();
		expect(result).toEqual({ kind: "failed", reason: "recollect_required" });
		if (change === "same-generation refresh") {
			db.exec(
				`INSERT INTO sync_peers(peer_device_id,created_at,projects_exclude_json) VALUES ('peer','now','["restricted"]')`,
			);
			await submitGroupBoundaryReadiness({ ...input, refreshRevision: 10 });
			expect(sent().body).toMatchObject({
				group_generation: generation,
				scope_refresh_revision: 10,
				filter_evidence: "present",
			});
		}
	},
);

it("signs the device's generation, local refresh, sequence, filter evidence and fitted inventory together", async () => {
	db.exec(`INSERT INTO replication_scopes(scope_id,label,kind,authority_type,coordinator_id,group_id,created_at,updated_at)
		VALUES ('source','local label','team','coordinator','${authority}','${group}','now','now');
		INSERT INTO project_scope_mappings(workspace_identity,project_pattern,scope_id,created_at,updated_at)
		VALUES ('repository:private-label','*','source','now','now');
		INSERT INTO sessions(id,started_at,project,metadata_json) VALUES(1,'now','private-label','{"codemem_repository_identity":"repository:private-label"}');
		INSERT INTO memory_items(session_id,kind,title,body_text,created_at,updated_at,import_key,scope_id)
		VALUES(1,'discovery','private-title','private-body','now','now','stable-key','source');
		INSERT INTO sync_peers(peer_device_id,created_at,projects_exclude_json) VALUES ('b','now','["private-filter"]')`);
	const result = await submitGroupBoundaryReadiness(input);
	expect(result).toEqual({ kind: "stored", sequence: 7, rejected: [] });
	const { body, bodyBytes, init, target, headers } = sent();
	expect(target.href).toBe(`${authority}/v1/boundary-readiness?group_id=group-a`);
	expect(init.redirect).toBe("error");
	expect(headers.has("X-Codemem-Coordinator-Admin")).toBe(false);
	expect(body).toEqual({
		version: 2,
		device_id: deviceId,
		key_id: acknowledgement.key_id,
		group_id: group,
		coordinator_id: authority,
		group_generation: generation,
		sequence: 7,
		scope_refresh_revision: 9,
		filter_evidence: "present",
		omitted_projects: 0,
		projects: [
			{
				source_scope_id: "source",
				boundary_scope_id: expect.stringMatching(/^managed-project:[0-9a-f]{64}$/u),
				state: "waiting",
				own_rows_in_source: 1,
				own_rows_in_boundary: 0,
			},
		],
	});
	expect(bodyBytes.toString("utf8")).not.toContain("private-");
	const signed = {
		method: "POST",
		pathWithQuery: target.pathname + target.search,
		publicKey,
		deviceId,
		timestamp: headers.get("X-Opencode-Timestamp") ?? "",
		nonce: headers.get("X-Opencode-Nonce") ?? "",
		signature: headers.get("X-Opencode-Signature") ?? "",
	};
	expect(verifySignature({ ...signed, bodyBytes })).toBe(true);
	for (const changed of [
		{ group_generation: "different" },
		{ group_id: "group-b" },
		{ filter_evidence: "none" },
		{ sequence: 8 },
		{ projects: [] },
	]) {
		expect(
			verifySignature({
				...signed,
				bodyBytes: Buffer.from(JSON.stringify({ ...body, ...changed })),
			}),
		).toBe(false);
	}
});

describe("a device with no locally authored Project still reports its restrictions", () => {
	it.each([
		["no local restrictions", "", "none"],
		[
			"a removed pairing",
			`INSERT INTO peer_project_filter_retention(peer_device_id,projects_include_json) VALUES ('removed','["hidden"]')`,
			"present",
		],
		[
			"an active template",
			`INSERT INTO coordinator_group_preferences(coordinator_id,group_id,auto_seed_scope,projects_include_json,updated_at) VALUES ('other','another-group',1,'["hidden"]','now')`,
			"present",
		],
		[
			"a disabled template",
			`INSERT INTO coordinator_group_preferences(coordinator_id,group_id,auto_seed_scope,projects_include_json,updated_at) VALUES ('other','another-group',0,'["hidden"]','now')`,
			"none",
		],
		[
			"an unreadable list",
			`INSERT INTO sync_peers(peer_device_id,created_at,projects_exclude_json) VALUES ('b','now','invalid')`,
			"unknown",
		],
		["missing retention storage", "DROP TABLE peer_project_filter_retention", "unknown"],
		[
			"one missing and one restricted source",
			`INSERT INTO sync_peers(peer_device_id,created_at,projects_exclude_json) VALUES ('b','now','["hidden"]'); DROP TABLE peer_project_filter_retention`,
			"present",
		],
	])("classifies %s", async (_name, sql, expected) => {
		if (sql) db.exec(sql);
		await submitGroupBoundaryReadiness(input);
		expect(sent().body).toMatchObject({ projects: [], filter_evidence: expected });
	});

	it.each([
		["saved", ["private-filter"], undefined, "present"],
		["environment", [], "private-filter", "present"],
		["empty environment override", ["private-filter"], "", "none"],
		["invalid setting", { unexpected: true }, undefined, "unknown"],
	] as const)("uses the %s setting", async (_name, setting, env, expected) => {
		writeFileSync(configPath, JSON.stringify({ ...config, sync_projects_include: setting }));
		vi.stubEnv("CODEMEM_SYNC_PROJECTS_INCLUDE", env);
		await submitGroupBoundaryReadiness(input);
		expect(sent().body.filter_evidence).toBe(expected);
	});
});

describe("no readiness when local requirements are missing", () => {
	it.each([
		{ sync_boundary_migration: "off" },
		{ sync_boundary_migration: "report" },
		{ sync_enabled: false },
		{ sync_coordinator_url: "" },
		{ sync_coordinator_url: "https://other.example.test" },
		{ sync_coordinator_groups: ["another"] },
	])("sends nothing for %j", async (overrides) => {
		writeFileSync(configPath, JSON.stringify({ ...config, ...overrides }));
		expect(await submitGroupBoundaryReadiness(input)).toEqual({
			kind: "failed",
			reason: "inventory_unavailable",
		});
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		"DELETE FROM scope_membership_cache_state",
		"UPDATE scope_membership_cache_state SET refresh_revision=10",
		"UPDATE scope_membership_cache_state SET last_error='unavailable'",
		"UPDATE scope_membership_cache_state SET last_success_at=NULL",
		"DELETE FROM sync_device",
		"DROP TABLE project_scope_mappings",
	])("refuses an incomplete snapshot: %s", async (sql) => {
		db.exec(sql);
		expect(await submitGroupBoundaryReadiness(input)).toEqual({
			kind: "failed",
			reason: "inventory_unavailable",
		});
		expect(transport).not.toHaveBeenCalled();
	});

	it("does not create a missing database", async () => {
		const dbPath = join(directory, "missing.sqlite");
		expect(await submitGroupBoundaryReadiness({ ...input, dbPath })).toMatchObject({
			kind: "failed",
		});
		expect(existsSync(dbPath)).toBe(false);
		expect(transport).not.toHaveBeenCalled();
	});

	it("does not disclose inventory to a configured HTTP coordinator", async () => {
		const http = "http://coordinator.example.test";
		writeFileSync(configPath, JSON.stringify({ ...config, sync_coordinator_url: http }));
		db.prepare("UPDATE scope_membership_cache_state SET coordinator_id=?").run(http);
		expect(await submitGroupBoundaryReadiness({ ...input, coordinatorUrl: http })).toEqual({
			kind: "failed",
			reason: "invalid_input",
		});
		expect(transport).not.toHaveBeenCalled();
	});
	it("refuses an unrelated private key", async () => {
		const other = connect(join(directory, "other.sqlite"));
		const keysDir = join(directory, "other-keys");
		try {
			ensureDeviceIdentity(other, { keysDir });
		} finally {
			other.close();
		}
		expect(await submitGroupBoundaryReadiness({ ...input, keysDir })).toEqual({
			kind: "failed",
			reason: "signing_failed",
		});
		expect(transport).not.toHaveBeenCalled();
	});
	it("does not treat damaged configuration as empty", async () => {
		writeFileSync(configPath, "{broken");
		expect(await submitGroupBoundaryReadiness(input)).toMatchObject({ kind: "failed" });
		expect(transport).not.toHaveBeenCalled();
	});
	it.each([
		{ groupGeneration: "" },
		{ groupGeneration: "unissued" },
		{ refreshRevision: 0 },
		{ sequence: 0 },
	])("rejects %j before sending", async (overrides) => {
		expect(await submitGroupBoundaryReadiness({ ...input, ...overrides })).toEqual({
			kind: "failed",
			reason: "invalid_input",
		});
		expect(transport).not.toHaveBeenCalled();
	});
});

it.each([
	{ version: 1 },
	{ key_id: "other-key" },
	{ group_generation: "other" },
	{ group_id: "other" },
	{ device_id: "other" },
])("rejects a mismatched acknowledgement %j without downgrade or retry", async (overrides) => {
	transport.mockResolvedValueOnce(Response.json({ ...acknowledgement, ...overrides }));
	expect(await submitGroupBoundaryReadiness(input)).toEqual({
		kind: "failed",
		reason: "invalid_response",
	});
	expect(transport).toHaveBeenCalledTimes(1);
});
