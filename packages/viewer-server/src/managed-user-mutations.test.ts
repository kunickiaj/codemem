import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, ensureScopeBackfillScopes, initTestSchema, MemoryStore } from "@codemem/core";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	forgetMemoryCommand,
	rememberMemoryCommand,
	showMemoryCommand,
} from "../../cli/src/commands/memory.js";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { refreshManagedScopeFixture } from "../../core/src/managed-scope-test-fixtures.js";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { createCodememMcpServer } from "../../mcp-server/src/index.js";
import { memoryRoutes } from "./routes/memory.js";
import { memoryToolRoutes } from "./routes/memory-tools.js";
import { syncRoutes } from "./routes/sync.js";

type Tool = {
	handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};
type State = "active" | "revoked" | "missing proof" | "wrong key";
let directory: string;
let dbPath: string;
let store: MemoryStore;
let historyId: number;
let app: Hono;
let tools: Record<string, Tool>;
let log: ReturnType<typeof vi.spyOn>;
let originalExitCode: typeof process.exitCode;

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
	directory = mkdtempSync(join(tmpdir(), "codemem-user-mutations-"));
	dbPath = join(directory, "memory.sqlite");
	const keysDir = join(directory, "keys");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_DEVICE_ID", "user-mutation-device");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network call");
		}),
	);
	const db = connect(dbPath);
	initTestSchema(db);
	const now = new Date().toISOString();
	db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
		coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		VALUES ('managed-write', 'Write fixture', 'managed_project', 'coordinator',
		'fixture-coordinator', 'fixture-group', 1, 'active', ?, ?)`).run(now, now);
	db.prepare(`INSERT INTO project_scope_mappings(project_pattern, scope_id, priority,
		source, created_at, updated_at) VALUES (?, 'managed-write', 10, 'test', ?, ?)`).run(
		process.cwd(),
		now,
		now,
	);
	await refreshManagedScopeFixture(db, {
		keysDir,
		deviceId: "user-mutation-device",
		scopeIds: ["managed-write"],
	});
	db.close();
	store = new MemoryStore(dbPath, { keysDir });
	// Author the history while authorized, rather than inferring authorship from labels.
	const sessionId = store.startSession({ cwd: process.cwd(), project: "write-project" });
	historyId = store.rememberForUser(sessionId, "decision", "Authorized history", "History body");
	store.endSession(sessionId);
	await store.flushPendingVectorWrites();
	app = new Hono()
		.route(
			"/",
			memoryRoutes(() => store),
		)
		.route(
			"/",
			memoryToolRoutes(() => store),
		)
		.route(
			"/",
			syncRoutes(() => store),
		);
	const server = createCodememMcpServer(store, {
		defaultProject: null,
		captureRetrievalLedger: false,
	});
	tools = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
	log = vi.spyOn(console, "log").mockImplementation(() => {});
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
});

afterEach(() => {
	store?.close();
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function snapshot() {
	return Object.fromEntries(
		["sessions", "memory_items", "replication_ops"].map((table) => [
			table,
			store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
		]),
	);
}

async function setState(state: State) {
	if (state === "revoked")
		store.db.prepare("UPDATE scope_memberships SET status = 'revoked'").run();
	if (state === "missing proof")
		store.db.prepare("DELETE FROM scope_membership_authorization_evidence").run();
	if (state === "wrong key")
		await refreshTestScopeRows(store.db, { [store.deviceId]: CANONICAL_PUBLIC_KEY });
}

async function mcp(name: string, args: Record<string, unknown>) {
	const result = await tools[name].handler(args);
	return JSON.parse(result.content[0].text);
}

function post(endpoint: string, body: Record<string, unknown>) {
	return app.request(`/api/memories/${endpoint}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function cli(command: typeof rememberMemoryCommand, args: string[]) {
	log.mockClear();
	process.exitCode = undefined;
	await command.parseAsync([...args, "--db-path", dbPath, "--json"], { from: "user" });
	return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

const remember = {
	kind: "decision",
	title: "New user memory",
	body: "New body",
	project: "write-project",
};
const rememberArgs = [
	"--kind",
	remember.kind,
	"--title",
	remember.title,
	"--body",
	remember.body,
	"--project",
	remember.project,
];

it.each<State>(["revoked", "missing proof", "wrong key"])(
	"hides managed authored history and refuses every user mutation with %s",
	async (state) => {
		// Arrange: remove current permission only after real V1-authorized authorship.
		await setState(state);
		const before = snapshot();
		// Act: denied managed history is hidden on all three user surfaces.
		const read = await app.request("/api/memory");
		const toolRead = await mcp("memory_get", { memory_id: historyId });
		const cliRead = await cli(showMemoryCommand, [String(historyId)]);
		// Assert: authorship does not bypass managed read authorization.
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({
			items: [],
		});
		expect(toolRead).toEqual({ error: "not_found" });
		expect(cliRead).toEqual({
			error: "not_found",
			message: `Memory ${historyId} not found`,
		});
		expect(process.exitCode).toBe(1);
		expect(snapshot()).toEqual(before);
		// Act/Assert: preserve each endpoint's existing failure contract and all content rows.
		const remembered = await post("remember", remember);
		expect(remembered.status).toBe(403);
		expect(await remembered.json()).toEqual({ error: "unauthorized_scope" });
		expect(snapshot()).toEqual(before);
		for (const [endpoint, extra] of [
			["forget", {}],
			["visibility", { visibility: "private" }],
			["project", { project: "other-project" }],
		] as const) {
			const response = await post(endpoint, { memory_id: historyId, ...extra });
			expect(response.status, endpoint).toBe(404);
			expect(await response.json()).toEqual({ error: "memory not found" });
			expect(snapshot(), endpoint).toEqual(before);
		}
		expect(await mcp("memory_remember", remember)).toEqual({ error: "unauthorized_scope" });
		expect(snapshot()).toEqual(before);
		expect(await mcp("memory_forget", { memory_id: historyId })).toEqual({ error: "not_found" });
		expect(snapshot()).toEqual(before);
		expect(await cli(rememberMemoryCommand, rememberArgs)).toEqual({
			error: "remember_failed",
			message: "unauthorized_scope",
		});
		expect(process.exitCode).toBe(1);
		expect(snapshot()).toEqual(before);
		expect(await cli(forgetMemoryCommand, [String(historyId)])).toEqual({
			error: "not_found",
			message: `Memory ${historyId} not found`,
		});
		expect(process.exitCode).toBe(1);
		expect(snapshot()).toEqual(before);
	},
);

it("permits remember and historical mutations with active matching V1 proof", async () => {
	// Arrange: each surface receives distinct content to avoid deduplication.
	const before = snapshot();
	// Act.
	const viewer = await post("remember", { ...remember, title: "Viewer permitted" });
	const tool = await mcp("memory_remember", { ...remember, title: "MCP permitted" });
	const command = await cli(rememberMemoryCommand, [...rememberArgs, "--title", "CLI permitted"]);
	const project = await post("project", { memory_id: historyId, project: "other-project" });
	const visibility = await post("visibility", { memory_id: historyId, visibility: "private" });
	const forgotten = await post("forget", { memory_id: historyId });
	const toolForgotten = await mcp("memory_forget", { memory_id: tool.id });
	const cliForgotten = await cli(forgetMemoryCommand, [String(command.id)]);
	// Assert: the controls reach actual writes, not just successful read checks.
	expect(viewer.status).toBe(200);
	const viewerMemory = (await viewer.json()) as { id: number };
	for (const [id, active] of [
		[viewerMemory.id, 1],
		[tool.id, 0],
		[command.id, 0],
	]) {
		expect(
			store.db.prepare("SELECT scope_id, active FROM memory_items WHERE id = ?").get(id),
		).toEqual({ scope_id: "managed-write", active });
	}
	expect(tool.id).toBeGreaterThan(historyId);
	expect(command.id).toBeGreaterThan(historyId);
	expect(project.status).toBe(200);
	expect(visibility.status).toBe(200);
	expect(forgotten.status).toBe(200);
	expect(toolForgotten).toEqual({ status: "ok" });
	expect(cliForgotten).toEqual({ id: command.id, status: "forgotten" });
	expect(
		store.db
			.prepare(`SELECT m.active, m.visibility, s.project FROM memory_items m
					JOIN sessions s ON s.id = m.session_id WHERE m.id = ?`)
			.get(historyId),
	).toMatchObject({ active: 0, visibility: "private", project: "other-project" });
	expect(snapshot()).not.toEqual(before);
});

it.each(["local", "manual", "invite", "local-first", "private"])(
	"permits unmanaged %s writes without Google or retained proof",
	async (authority) => {
		// Arrange: convert the fixture to an unmanaged direct scope and remove managed evidence.
		if (authority === "local-first" || authority === "private") {
			store.db.prepare("DELETE FROM project_scope_mappings").run();
			await setState("revoked");
			const sessionId = store.startSession({ cwd: process.cwd(), project: "personal-project" });
			historyId = store.rememberForUser(sessionId, "decision", "Personal history", "Personal body");
			store.endSession(sessionId);
			if (authority === "private") store.updateMemoryVisibility(historyId, "private");
		} else {
			store.db
				.prepare(
					"UPDATE replication_scopes SET authority_type = ?, coordinator_id = NULL, group_id = NULL",
				)
				.run(authority);
		}
		await setState("missing proof");
		// Act.
		const response = await post("remember", remember);
		const visibility = await post("visibility", { memory_id: historyId, visibility: "private" });
		const project = await post("project", { memory_id: historyId, project: "other-project" });
		const forgotten = await post("forget", { memory_id: historyId });
		const tool = await mcp("memory_remember", { ...remember, title: "Unmanaged MCP" });
		const toolForgotten = await mcp("memory_forget", { memory_id: tool.id });
		const command = await cli(rememberMemoryCommand, [...rememberArgs, "--title", "Unmanaged CLI"]);
		const cliForgotten = await cli(forgetMemoryCommand, [String(command.id)]);
		// Assert: no account provider or coordinator is contacted.
		expect(response.status).toBe(200);
		expect(visibility.status).toBe(200);
		expect(project.status).toBe(200);
		expect(forgotten.status).toBe(200);
		expect(toolForgotten).toEqual({ status: "ok" });
		expect(cliForgotten).toEqual({ id: command.id, status: "forgotten" });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

function syncPost(endpoint: string, body: Record<string, unknown>) {
	return app.request(`/api/sync/${endpoint}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function seedMixedProjectBatch() {
	// Both rows were authored with actual permission. The first is now local-only.
	ensureScopeBackfillScopes(store.db);
	store.reassignMemoryScope(historyId, "local-default");
	const sessionId = store.startSession({
		cwd: process.cwd(),
		project: "write-project",
		metadata: { fixture: "batch session metadata" },
	});
	historyId = store.rememberForUser(sessionId, "decision", "Managed batch member", "Batch body");
	store.endSession(sessionId);
	pinProjectIdentity();
}

const fixtureProjectIdentity = "https://example.test/write/project.git";
function pinProjectIdentity() {
	store.db
		.prepare(`UPDATE sessions SET git_remote = ?,
		metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.codemem_repository_identity', ?)`)
		.run(fixtureProjectIdentity, fixtureProjectIdentity);
}

function seedLegacyHistory() {
	ensureScopeBackfillScopes(store.db);
	store.reassignMemoryScope(historyId, "legacy-shared-review");
	pinProjectIdentity();
}

it.each<State>(["revoked", "missing proof", "wrong key"])(
	"hides managed history and rolls back the entire project correction batch with %s",
	async (state) => {
		// Arrange: include a writable row before the unauthorized managed row.
		seedMixedProjectBatch();
		await setState(state);
		const before = snapshot();
		// Act.
		const response = await syncPost("projects/reassign-project", {
			workspace_identity: fixtureProjectIdentity,
			project: "corrected-project",
		});
		// Assert: project, revision, session metadata, and replication operations all roll back.
		expect(store.get(historyId)).toBeNull();
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "unauthorized_scope" });
		expect(snapshot()).toEqual(before);
	},
);

it("corrects the whole project batch with active actual-key V1 proof", async () => {
	// Arrange.
	seedMixedProjectBatch();
	const before = store.db.prepare("SELECT id, rev FROM memory_items ORDER BY id").all() as {
		id: number;
		rev: number;
	}[];
	// Act.
	const response = await syncPost("projects/reassign-project", {
		workspace_identity: fixtureProjectIdentity,
		project: "corrected-project",
	});
	// Assert.
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ moved_memory_count: 2, moved_session_count: 2 });
	for (const row of before) {
		expect(
			store.db.prepare("SELECT project, rev FROM memory_items WHERE id = ?").get(row.id),
		).toEqual({ project: "corrected-project", rev: row.rev + 1 });
	}
});

async function legacyPreview() {
	const response = await syncPost("legacy-shared-review/reassign", {
		workspace_identity: fixtureProjectIdentity,
		scope_id: "managed-write",
	});
	expect(response.status).toBe(409);
	const result = (await response.json()) as {
		error: string;
		preview: { confirmation_token: string };
	};
	expect(result.error).toBe("legacy_review_confirmation_required");
	expect(result.preview.confirmation_token).toEqual(expect.any(String));
	return result.preview.confirmation_token;
}

it.each<State>(["revoked", "missing proof", "wrong key"])(
	"rejects both legacy-review preview and previously confirmed commit with %s target proof",
	async (state) => {
		// Arrange: the token was issued while the target had actual-key V1 permission.
		seedLegacyHistory();
		const token = await legacyPreview();
		await setState(state);
		const before = snapshot();
		// Act/Assert: a raw active membership is insufficient after proof loss or key mismatch.
		for (const confirmed of [false, true]) {
			const response = await syncPost("legacy-shared-review/reassign", {
				workspace_identity: fixtureProjectIdentity,
				scope_id: "managed-write",
				confirmed_old_copies: confirmed,
				confirmation_token: token,
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: "local device is not a member of Sharing domain managed-write",
			});
			expect(snapshot()).toEqual(before);
		}
	},
);

it("requires the existing legacy-review token and reassigns with active V1 target proof", async () => {
	// Arrange.
	seedLegacyHistory();
	const token = await legacyPreview();
	const before = snapshot();
	// Act.
	const stale = await syncPost("legacy-shared-review/reassign", {
		workspace_identity: fixtureProjectIdentity,
		scope_id: "managed-write",
		confirmed_old_copies: true,
		confirmation_token: "stale-token",
	});
	// Assert: permission does not replace confirmation.
	expect(stale.status).toBe(400);
	expect(await stale.json()).toEqual({
		error: "legacy shared review group changed before reassignment; refresh and try again",
	});
	expect(snapshot()).toEqual(before);
	// Act.
	const response = await syncPost("legacy-shared-review/reassign", {
		workspace_identity: fixtureProjectIdentity,
		scope_id: "managed-write",
		confirmed_old_copies: true,
		confirmation_token: token,
	});
	// Assert.
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ reassigned_memory_count: 1 });
	expect(store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").get(historyId)).toEqual(
		{ scope_id: "managed-write" },
	);
});

function mappingRequest(tokens: string[] = []) {
	return app.request("/api/sync/sharing-domains/project-mappings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			workspace_identity: fixtureProjectIdentity,
			project_pattern: fixtureProjectIdentity,
			scope_id: "managed-write",
			confirmed_guardrail_tokens: tokens,
		}),
	});
}

async function mappingTokens() {
	const response = await mappingRequest();
	if (response.status === 200) return [];
	expect(response.status).toBe(409);
	return ((await response.json()) as { required_guardrail_tokens: string[] })
		.required_guardrail_tokens;
}

it.each<State>(["missing proof", "wrong key"])(
	"refuses public mapping relocation into managed scope with %s",
	async (state) => {
		// Arrange: remove configuration, not proof; then author a genuinely local memory.
		store.db.prepare("DELETE FROM project_scope_mappings").run();
		ensureScopeBackfillScopes(store.db);
		store.reassignMemoryScope(historyId, "local-default");
		const sessionId = store.startSession({ cwd: process.cwd(), project: "local-mapping-project" });
		historyId = store.rememberForUser(sessionId, "decision", "Local mapping memory", "Local body");
		store.endSession(sessionId);
		pinProjectIdentity();
		await setState(state);
		const before = snapshot();
		const mappings = store.db.prepare("SELECT * FROM project_scope_mappings").all();
		// Act: supply any existing scope-change confirmation challenge, never bypass it.
		const challenge = await mappingRequest();
		let response = challenge;
		if (challenge.status === 409) {
			const tokens = (await challenge.json()) as { required_guardrail_tokens: string[] };
			response = await mappingRequest(tokens.required_guardrail_tokens);
		}
		// Assert: mapping configuration cannot relocate content under denied target authority.
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "unauthorized_scope" });
		expect(snapshot()).toEqual(before);
		expect(store.db.prepare("SELECT * FROM project_scope_mappings").all()).toEqual(mappings);
	},
);

it("permits confirmed public mapping relocation with actual-key V1 target proof", async () => {
	// Arrange: preserve local content and remove only the project mapping.
	store.db.prepare("DELETE FROM project_scope_mappings").run();
	ensureScopeBackfillScopes(store.db);
	store.reassignMemoryScope(historyId, "local-default");
	pinProjectIdentity();
	// Act.
	const tokens = await mappingTokens();
	const response = await mappingRequest(tokens);
	// Assert.
	expect(response.status).toBe(200);
	expect(store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").get(historyId)).toEqual(
		{ scope_id: "managed-write" },
	);
});

it.each(["manual", "private"])(
	"keeps project correction and legacy-review reassignment usable for old %s content",
	async (control) => {
		// Arrange: private local content and manual grants need no coordinator proof.
		ensureScopeBackfillScopes(store.db);
		if (control === "private") {
			store.reassignMemoryScope(historyId, "local-default");
			store.updateMemoryVisibility(historyId, "private");
		}
		store.db
			.prepare(
				"UPDATE replication_scopes SET authority_type = 'manual', coordinator_id = NULL, group_id = NULL WHERE scope_id = 'managed-write'",
			)
			.run();
		await setState("missing proof");
		pinProjectIdentity();
		// Act.
		const corrected = await syncPost("projects/reassign-project", {
			workspace_identity: fixtureProjectIdentity,
			project: "corrected-project",
		});
		seedLegacyHistory();
		const token = await legacyPreview();
		const reassigned = await syncPost("legacy-shared-review/reassign", {
			workspace_identity: fixtureProjectIdentity,
			scope_id: "managed-write",
			confirmed_old_copies: true,
			confirmation_token: token,
		});
		// Assert: scope admission neither requests Google nor changes existing private visibility.
		expect(corrected.status).toBe(200);
		expect(reassigned.status).toBe(200);
		expect(
			store.db.prepare("SELECT scope_id, visibility FROM memory_items WHERE id = ?").get(historyId),
		).toEqual({
			scope_id: "managed-write",
			visibility: control === "private" ? "private" : "shared",
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it.each(["projects/reassign-project", "legacy-shared-review/reassign"])(
	"rechecks actual scope proof inside the %s transaction, not only during preflight",
	async (endpoint) => {
		// Arrange: preflight sees valid V1 proof; the transaction sees proof withdrawal.
		let body: Record<string, unknown>;
		if (endpoint === "projects/reassign-project") {
			seedMixedProjectBatch();
			body = { workspace_identity: fixtureProjectIdentity, project: "corrected-project" };
		} else {
			seedLegacyHistory();
			body = {
				workspace_identity: fixtureProjectIdentity,
				scope_id: "managed-write",
				confirmed_old_copies: true,
				confirmation_token: await legacyPreview(),
			};
		}
		const before = snapshot();
		const actualPermission = store.isScopeWritable.bind(store);
		let checkedInTransaction = false;
		vi.spyOn(store, "isScopeWritable").mockImplementation((scopeId) => {
			if (scopeId === "managed-write" && store.db.inTransaction) {
				checkedInTransaction = true;
				store.db.prepare("DELETE FROM scope_membership_authorization_evidence").run();
			}
			return actualPermission(scopeId);
		});
		// Act: the spy withdraws real proof; it never substitutes an authorization decision.
		const response = await syncPost(endpoint, body);
		// Assert: no preflight ownership/read exception can authorize the transaction.
		expect(checkedInTransaction).toBe(true);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error:
				endpoint === "projects/reassign-project"
					? "unauthorized_scope"
					: "local device is not a member of Sharing domain managed-write",
		});
		expect(snapshot()).toEqual(before);
	},
);
