import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
	assertSchemaReady,
	connect,
	type Database,
	fromJson,
	resolveDbPath,
	toJson,
	toJsonNullable,
} from "./db.js";
import { buildFilterClausesWithContext } from "./filters.js";
import { expandUserPath } from "./observer-config.js";
import { projectColumnClause, resolveProject as resolveProjectName } from "./project.js";
import { cleanProjectIdentity } from "./project-identity.js";
import * as schema from "./schema.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";
import { resolveSessionScopeId } from "./scope-stamping.js";
import {
	exportedSessionKey,
	isCanonicalSessionKey,
	remappedSessionKey,
} from "./session-export-identity.js";

type JsonObject = Record<string, unknown>;
type MemoryInsert = typeof schema.memoryItems.$inferInsert;

interface ScopeFilter {
	clauses: string[];
	params: unknown[];
}

export interface ExportOptions {
	dbPath?: string;
	project?: string | null;
	allProjects?: boolean;
	includeInactive?: boolean;
	since?: string | null;
	cwd?: string;
}

export interface ImportOptions {
	dbPath?: string;
	remapProject?: string | null;
	dryRun?: boolean;
}

export interface ExportPayload {
	version: "1.0";
	exported_at: string;
	export_metadata: {
		tool_version: "codemem";
		projects: string[];
		total_memories: number;
		total_sessions: number;
		include_inactive: boolean;
		filters: JsonObject;
	};
	sessions: JsonObject[];
	memory_items: JsonObject[];
	session_summaries: JsonObject[];
	user_prompts: JsonObject[];
}

export interface ImportResult {
	sessions: number;
	user_prompts: number;
	memory_items: number;
	session_summaries: number;
	dryRun: boolean;
}

const SUMMARY_METADATA_KEYS = [
	"request",
	"investigated",
	"learned",
	"completed",
	"next_steps",
	"notes",
	"files_read",
	"files_modified",
	"prompt_number",
	"request_original",
	"discovery_tokens",
	"discovery_source",
] as const;

function nowIso(): string {
	return new Date().toISOString();
}

function nowEpochMs(): number {
	return Date.now();
}

function cleanString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function resolveLocalDeviceId(db: Database): string {
	const envDeviceId = cleanString(process.env.CODEMEM_DEVICE_ID);
	if (envDeviceId) return envDeviceId;
	try {
		const row = db.prepare("SELECT device_id FROM sync_device LIMIT 1").get() as
			| { device_id: string | null }
			| undefined;
		return cleanString(row?.device_id) ?? "local";
	} catch {
		return "local";
	}
}

function buildScopeFilter(db: Database): ScopeFilter {
	return buildFilterClausesWithContext(null, {
		actorId: "export",
		deviceId: resolveLocalDeviceId(db),
		enforceScopeVisibility: true,
	});
}

function scopeCanBeImported(db: Database, scopeId: string, deviceId: string): boolean {
	if (scopeId === LOCAL_DEFAULT_SCOPE_ID) return true;
	const row = db
		.prepare(
			`SELECT 1 AS ok
			 FROM replication_scopes rs
			 WHERE rs.scope_id = ?
			   AND rs.status = 'active'
			   AND (
				 rs.authority_type = 'local'
				 OR EXISTS (
					SELECT 1
					FROM scope_memberships sm
					WHERE sm.scope_id = rs.scope_id
					  AND sm.device_id = ?
					  AND sm.status = 'active'
					  AND sm.membership_epoch >= rs.membership_epoch
				 )
			   )
			 LIMIT 1`,
		)
		.get(scopeId, deviceId) as { ok: number } | undefined;
	return row != null;
}

function parseDbObject(raw: unknown): unknown {
	if (typeof raw !== "string" || raw.trim().length === 0) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return fromJson(raw);
	}
}

function parseRowJsonFields<T extends JsonObject>(row: T, fields: string[]): JsonObject {
	const parsed: JsonObject = { ...row };
	for (const field of fields) {
		parsed[field] = parseDbObject(row[field]);
	}
	return parsed;
}

function normalizeImportMetadata(importMetadata: unknown): JsonObject | null {
	if (importMetadata == null) return null;
	if (typeof importMetadata === "string") {
		try {
			const parsed = JSON.parse(importMetadata) as unknown;
			return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as JsonObject)
				: null;
		} catch {
			return null;
		}
	}
	return typeof importMetadata === "object" && !Array.isArray(importMetadata)
		? ({ ...(importMetadata as JsonObject) } as JsonObject)
		: null;
}

export function buildImportKey(
	source: string,
	recordType: string,
	originalId: unknown,
	parts?: { project?: string | null; createdAt?: string | null; sourceDb?: string | null },
): string {
	const values = [source, recordType, String(originalId ?? "unknown")];
	if (parts?.project) values.push(parts.project);
	if (parts?.createdAt) values.push(parts.createdAt);
	if (parts?.sourceDb) values.push(parts.sourceDb);
	return values.join("|");
}

export function mergeSummaryMetadata(metadata: JsonObject, importMetadata: unknown): JsonObject {
	const parsed = normalizeImportMetadata(importMetadata);
	if (!parsed) return metadata;
	const merged: JsonObject = { ...metadata };
	for (const key of SUMMARY_METADATA_KEYS) {
		if (!(key in parsed)) continue;
		const current = merged[key];
		let shouldFill = !(key in merged);
		if (!shouldFill) {
			if (key === "discovery_tokens" || key === "prompt_number") {
				shouldFill = current == null;
			} else if (typeof current === "string") {
				shouldFill = current.trim().length === 0;
			} else if (Array.isArray(current)) {
				shouldFill = current.length === 0;
			} else {
				shouldFill = current == null;
			}
		}
		if (shouldFill) merged[key] = parsed[key];
	}
	merged.import_metadata = importMetadata;
	return merged;
}

function normalizeImportedProject(project: unknown): string | null {
	if (typeof project !== "string") return null;
	const trimmed = project.trim();
	if (!trimmed) return null;
	if (/[\\/]/.test(trimmed)) {
		const normalized = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
		const parts = normalized.split("/");
		return parts[parts.length - 1] || null;
	}
	return trimmed;
}

function resolveExportProject(opts: ExportOptions): string | null {
	if (opts.allProjects) return null;
	return resolveProjectName(opts.cwd ?? process.cwd(), opts.project ?? null);
}

function querySessions(
	db: Database,
	project: string | null,
	since: string | null,
	scopeFilter: ScopeFilter,
	includeInactive: boolean,
): JsonObject[] {
	let sql = "SELECT * FROM sessions";
	const params: unknown[] = [];
	const clauses: string[] = [];
	const memoryClauses = ["memory_items.session_id = sessions.id", ...scopeFilter.clauses];
	if (project) {
		const filter = projectColumnClause("COALESCE(sessions.project, memory_items.project)", project);
		if (filter.clause) memoryClauses.push(filter.clause);
		// Scope parameters precede project parameters inside this EXISTS.
		params.push(...scopeFilter.params, ...filter.params);
	} else {
		params.push(...scopeFilter.params);
	}
	if (!includeInactive) memoryClauses.splice(1, 0, "memory_items.active = 1");
	if (since) {
		memoryClauses.push(
			"(sessions.started_at >= ? OR (sessions.started_at = '' AND memory_items.created_at >= ?))",
		);
		params.push(since, since);
	}
	clauses.push(`EXISTS (SELECT 1 FROM memory_items WHERE ${memoryClauses.join(" AND ")})`);
	if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
	sql += " ORDER BY started_at ASC";
	const rows = db.prepare(sql).all(...params) as JsonObject[];
	return rows
		.filter((row) => !since || String(row.started_at) >= since || isRedactedSessionPlaceholder(row))
		.map((row) => parseRowJsonFields(row, ["metadata_json"]));
}

function fetchBySessionIds(
	db: Database,
	table: string,
	sessionIds: number[],
	orderBy: string,
	extraWhere = "",
): JsonObject[] {
	if (sessionIds.length === 0) return [];
	const placeholders = sessionIds.map(() => "?").join(",");
	const sql = `SELECT * FROM ${table} WHERE session_id IN (${placeholders})${extraWhere} ORDER BY ${orderBy}`;
	return db.prepare(sql).all(...sessionIds) as JsonObject[];
}

function exportedMemoryScopeId(row: JsonObject): string {
	const existing = cleanString(row.scope_id);
	return existing ?? LOCAL_DEFAULT_SCOPE_ID;
}

function queryExportSessions(
	db: Database,
	project: string | null,
	opts: ExportOptions,
	scopeFilter: ScopeFilter,
): { sessions: JsonObject[]; sessionIds: number[]; safeIds: number[] } {
	const selectedSessions = querySessions(
		db,
		project,
		opts.since ?? null,
		scopeFilter,
		Boolean(opts.includeInactive),
	);
	const sessionIds = selectedSessions.map((row) => Number(row.id)).filter(Number.isFinite);
	if (sessionIds.length === 0) return { sessions: [], sessionIds, safeIds: [] };
	const placeholders = sessionIds.map(() => "?").join(",");
	// Session source records have no per-memory scope. Check all history, not
	// just active/export-selected memories, before releasing those records.
	const rows = db
		.prepare(`SELECT DISTINCT session_id FROM memory_items
		WHERE session_id IN (${placeholders})
		AND NOT COALESCE((${scopeFilter.clauses.join(" AND ")}), 0)`)
		.all(...sessionIds, ...scopeFilter.params) as { session_id: number }[];
	const unsafeSessionIds = new Set(rows.map((row) => row.session_id));
	for (const row of selectedSessions) {
		if (isRedactedSessionPlaceholder(row)) unsafeSessionIds.add(Number(row.id));
	}
	const safeIds = sessionIds.filter((id) => !unsafeSessionIds.has(id));
	// Opaque references preserve import mappings without exporting session
	// metadata, paths, or other source content from partially readable sessions.
	const sessions = selectedSessions.map((row) => {
		const export_session_key = exportedSessionKey(db, row);
		if (unsafeSessionIds.has(Number(row.id))) {
			return { id: row.id, export_session_key, export_session_redacted: true };
		}
		return { ...row, export_session_key };
	});
	return { sessions, sessionIds, safeIds };
}

function isRedactedSessionPlaceholder(row: JsonObject): boolean {
	const metadata = normalizeImportMetadata(row.metadata_json);
	return (
		isCanonicalSessionKey(cleanString(row.import_key)) &&
		row.started_at === "" &&
		row.ended_at == null &&
		row.cwd == null &&
		row.user == null &&
		row.git_remote == null &&
		row.git_branch == null &&
		row.tool_version === "import" &&
		metadata?.source === "export" &&
		metadata.import_key === row.import_key &&
		metadata.original_started_at === null &&
		metadata.original_ended_at === null &&
		metadata.import_metadata === null
	);
}

function parseMemoryExportRow(row: JsonObject): JsonObject {
	return {
		...parseRowJsonFields(row, [
			"metadata_json",
			"facts",
			"concepts",
			"files_read",
			"files_modified",
		]),
		scope_id: exportedMemoryScopeId(row),
	};
}

function fetchMemoryRows(
	db: Database,
	sessionIds: number[],
	scopeFilter: ScopeFilter,
	opts: Pick<ExportOptions, "includeInactive" | "project">,
): JsonObject[] {
	if (sessionIds.length === 0) return [];
	const placeholders = sessionIds.map(() => "?").join(",");
	const clauses = [`memory_items.session_id IN (${placeholders})`, ...scopeFilter.clauses];
	const params: unknown[] = [...sessionIds, ...scopeFilter.params];
	if (!opts.includeInactive) clauses.push("memory_items.active = 1");
	if (opts.project) {
		const filter = projectColumnClause(
			"COALESCE(sessions.project, memory_items.project)",
			opts.project,
		);
		if (filter.clause) clauses.push(filter.clause);
		params.push(...filter.params);
	}
	return db
		.prepare(
			`SELECT memory_items.* FROM memory_items JOIN sessions ON sessions.id = memory_items.session_id WHERE ${clauses.join(" AND ")} ORDER BY memory_items.created_at ASC`,
		)
		.all(...params) as JsonObject[];
}

export function exportMemories(opts: ExportOptions = {}): ExportPayload {
	const db = connect(resolveDbPath(opts.dbPath));
	try {
		assertSchemaReady(db);
		const resolvedProject = resolveExportProject(opts);
		const filters: JsonObject = {};
		if (resolvedProject) filters.project = resolvedProject;
		if (opts.since) filters.since = opts.since;
		const scopeFilter = buildScopeFilter(db);

		const { sessions, sessionIds, safeIds } = queryExportSessions(
			db,
			resolvedProject,
			opts,
			scopeFilter,
		);

		const memories = fetchMemoryRows(db, sessionIds, scopeFilter, {
			includeInactive: opts.includeInactive,
			project: resolvedProject,
		}).map((row) => parseMemoryExportRow(row));

		const summaries = fetchBySessionIds(
			db,
			"session_summaries",
			safeIds,
			"created_at_epoch ASC",
		).map((row) => parseRowJsonFields(row, ["metadata_json", "files_read", "files_edited"]));

		const prompts = fetchBySessionIds(db, "user_prompts", safeIds, "created_at_epoch ASC").map(
			(row) => parseRowJsonFields(row, ["metadata_json"]),
		);

		const promptImportKeys = new Map<number, string>();
		for (const prompt of prompts) {
			if (typeof prompt.id === "number" && typeof prompt.import_key === "string") {
				promptImportKeys.set(prompt.id, prompt.import_key);
			}
		}
		for (const memory of memories) {
			if (typeof memory.user_prompt_id === "number") {
				memory.user_prompt_import_key = promptImportKeys.get(memory.user_prompt_id) ?? null;
			}
		}

		return {
			version: "1.0",
			exported_at: nowIso(),
			export_metadata: {
				tool_version: "codemem",
				projects: [...new Set(sessions.map((s) => String(s.project ?? "")).filter(Boolean))],
				total_memories: memories.length,
				total_sessions: sessions.length,
				include_inactive: Boolean(opts.includeInactive),
				filters,
			},
			sessions,
			memory_items: memories,
			session_summaries: summaries,
			user_prompts: prompts,
		};
	} finally {
		db.close();
	}
}

export function readImportPayload(inputFile: string): ExportPayload {
	const raw =
		inputFile === "-" ? readFileSync(0, "utf8") : readFileSync(expandUserPath(inputFile), "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Import payload must be a JSON object");
	}
	const payload = parsed as ExportPayload;
	if (payload.version !== "1.0") {
		throw new Error(
			`Unsupported export version: ${String((parsed as JsonObject).version ?? "unknown")}`,
		);
	}
	return payload;
}

function findImportedId(db: Database, table: string, importKey: string): number | null {
	const row = db.prepare(`SELECT id FROM ${table} WHERE import_key = ? LIMIT 1`).get(importKey) as
		| { id: number }
		| undefined;
	return row?.id ?? null;
}

function nextUserName(): string {
	return process.env.USER?.trim() || process.env.USERNAME?.trim() || "import";
}

type DrizzleDb = ReturnType<typeof drizzle>;

function readableSessionProject(sessionId: unknown, memories: JsonObject[]): string | null {
	const projects = new Set(
		memories
			.filter((memory) => Number(memory.session_id) === Number(sessionId))
			.map((memory) => cleanProjectIdentity(normalizeImportedProject(memory.project))),
	);
	if (projects.size !== 1) return null;
	return projects.values().next().value ?? null;
}

function storedPlaceholderProject(db: Database, id: number): string | null {
	const scopeFilter = buildScopeFilter(db);
	const memories = db
		.prepare(
			`SELECT session_id, project FROM memory_items
		 WHERE session_id = ? AND ${scopeFilter.clauses.join(" AND ")}`,
		)
		.all(id, ...scopeFilter.params) as JsonObject[];
	return readableSessionProject(id, memories);
}

function trackPlaceholderProject(
	db: Database,
	session: JsonObject,
	opts: ImportOptions,
): JsonObject {
	const metadata = normalizeImportMetadata(session.metadata_json) ?? {};
	if (Object.hasOwn(metadata, "placeholder_project")) return metadata;
	// Legacy rows have no baseline. Infer it from stored readable rows before
	// ingestion, never from a potentially user-edited session project.
	metadata.placeholder_project =
		cleanProjectIdentity(cleanString(opts.remapProject)) ??
		storedPlaceholderProject(db, Number(session.id));
	db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?").run(
		toJson(metadata),
		session.id,
	);
	return metadata;
}

function resolveImportedSessionIdentity(
	db: Database,
	row: JsonObject,
	opts: ImportOptions & { memories: JsonObject[] },
): { project: string | null; importKey: string; existingId: number | null } {
	const sourceProject = opts.remapProject || normalizeImportedProject(row.project);
	const legacyKey = buildImportKey("export", "session", row.id, {
		project: sourceProject,
		createdAt: typeof row.started_at === "string" ? row.started_at : null,
	});
	// Attribution comes only from exported readable memories; it never changes
	// opaque identity or the legacy full-session fallback key.
	const project =
		row.export_session_redacted === true && !opts.remapProject
			? readableSessionProject(row.id, opts.memories)
			: sourceProject;
	const marker = cleanString(row.export_session_key);
	if (!isCanonicalSessionKey(marker)) {
		return { project, importKey: legacyKey, existingId: findImportedId(db, "sessions", legacyKey) };
	}
	const importKey = opts.remapProject ? remappedSessionKey(marker, opts.remapProject) : marker;
	let existingId = findImportedId(db, "sessions", importKey);
	// Older full imports used project/start/id. Promote their key while full
	// source identity is available, so later redacted exports reuse the row.
	if (existingId == null && row.export_session_redacted !== true) {
		existingId = findImportedId(db, "sessions", legacyKey);
		if (existingId != null) {
			db.prepare("UPDATE sessions SET import_key = ? WHERE id = ?").run(importKey, existingId);
		}
	}
	return { project, importKey, existingId };
}

function importedSessionValues(row: JsonObject): typeof schema.sessions.$inferInsert {
	const defaults =
		row.export_session_redacted === true
			? { startedAt: "", cwd: null, user: null }
			: { startedAt: nowIso(), cwd: process.cwd(), user: nextUserName() };
	return {
		started_at: typeof row.started_at === "string" ? row.started_at : defaults.startedAt,
		ended_at: typeof row.ended_at === "string" ? row.ended_at : null,
		cwd: row.cwd == null ? defaults.cwd : cleanProjectIdentity(String(row.cwd)),
		project: row.project == null ? null : cleanProjectIdentity(String(row.project)),
		git_remote: row.git_remote == null ? null : cleanProjectIdentity(String(row.git_remote)),
		git_branch: row.git_branch == null ? null : cleanProjectIdentity(String(row.git_branch)),
		user: row.user == null ? defaults.user : String(row.user),
		tool_version: String(row.tool_version ?? "import"),
		metadata_json: toJson(row.metadata_json ?? null),
		import_key: String(row.import_key),
	};
}

function insertSession(d: DrizzleDb, row: JsonObject): number {
	const rows = d
		.insert(schema.sessions)
		.values(importedSessionValues(row))
		.returning({ id: schema.sessions.id })
		.all();
	const id = rows[0]?.id;
	if (id == null) throw new Error("session insert returned no id");
	return id;
}

function importSession(
	db: Database,
	d: DrizzleDb,
	session: JsonObject,
	opts: ImportOptions & { memories: JsonObject[] },
): { id: number; inserted: boolean } {
	const { project, importKey, existingId } = resolveImportedSessionIdentity(db, session, opts);
	// Redacted payloads carry references only, even if extra fields are supplied.
	const sourceSession =
		session.export_session_redacted === true
			? { id: session.id, export_session_redacted: true }
			: session;
	const importedSession = {
		...sourceSession,
		project,
		metadata_json: {
			source: "export",
			original_session_id: sourceSession.id,
			original_started_at: sourceSession.started_at ?? null,
			original_ended_at: sourceSession.ended_at ?? null,
			import_metadata: sourceSession.metadata_json ?? null,
			import_key: importKey,
			...(sourceSession.export_session_redacted === true
				? { placeholder_project: cleanProjectIdentity(project) }
				: {}),
		},
		import_key: importKey,
	};
	if (existingId == null) return { id: insertSession(d, importedSession), inserted: true };
	const existing = db.prepare("SELECT * FROM sessions WHERE id = ?").get(existingId) as JsonObject;
	if (isRedactedSessionPlaceholder(existing)) {
		const metadata = trackPlaceholderProject(db, existing, opts);
		if (session.export_session_redacted !== true) {
			const values = importedSessionValues(importedSession);
			// Restore context, but retain raw NULL/blank/custom project moves.
			if (existing.project !== metadata.placeholder_project)
				values.project = existing.project as string | null;
			values.metadata_json = toJson({ ...metadata, ...importedSession.metadata_json });
			d.update(schema.sessions)
				.set(values)
				.where(
					and(
						eq(schema.sessions.id, existingId),
						sql`${schema.sessions.project} IS ${existing.project}`,
					),
				)
				.run();
		}
	}
	return { id: existingId, inserted: false };
}

function reconcilePlaceholderProjects(
	db: Database,
	sessionIds: Iterable<number>,
	opts: Pick<ImportOptions, "remapProject">,
): void {
	// An explicit remap remains authoritative even without stored readable memories.
	if (cleanString(opts.remapProject)) return;
	for (const id of new Set(sessionIds)) {
		const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as JsonObject;
		if (!isRedactedSessionPlaceholder(session)) continue;
		// Use stored rows after ingestion: deduped payload fields are not new
		// attribution evidence, and previous readable slices still participate.
		const metadata = trackPlaceholderProject(db, session, opts);
		const previousProject = metadata.placeholder_project;
		if (session.project !== previousProject) continue;
		const project = storedPlaceholderProject(db, id);
		if (project === previousProject) continue;
		db.prepare(
			"UPDATE sessions SET project = ?, metadata_json = ? WHERE id = ? AND project IS ?",
		).run(project, toJson({ ...metadata, placeholder_project: project }), id, previousProject);
	}
}

function insertPrompt(d: DrizzleDb, row: JsonObject): number {
	const rows = d
		.insert(schema.userPrompts)
		.values({
			session_id: Number(row.session_id),
			project: row.project == null ? null : String(row.project),
			prompt_text: String(row.prompt_text ?? ""),
			prompt_number: row.prompt_number == null ? null : Number(row.prompt_number),
			created_at: typeof row.created_at === "string" ? row.created_at : nowIso(),
			created_at_epoch:
				typeof row.created_at_epoch === "number" ? row.created_at_epoch : nowEpochMs(),
			metadata_json: toJson(row.metadata_json ?? null),
			import_key: String(row.import_key),
		})
		.returning({ id: schema.userPrompts.id })
		.all();
	const id = rows[0]?.id;
	if (id == null) throw new Error("prompt insert returned no id");
	return id;
}

function importedMemoryScopeId(db: Database, row: JsonObject, deviceId: string): string {
	const sourceScopeId = cleanString(row.scope_id);
	if (sourceScopeId) {
		if (!scopeCanBeImported(db, sourceScopeId, deviceId)) {
			throw new Error(`unauthorized_scope: ${sourceScopeId}`);
		}
		return sourceScopeId;
	}
	return resolveSessionScopeId(db, {
		sessionId: Number(row.session_id),
		workspaceId: cleanString(row.workspace_id),
	});
}

function validateImportScopes(
	db: Database,
	memories: JsonObject[],
	deviceId: string,
	remapProject: string | null,
): void {
	const unauthorized = new Set<string>();
	for (const memory of memories) {
		const sourceScopeId = cleanString(memory.scope_id);
		if (!sourceScopeId) continue;
		// Skip rows that would dedupe — they don't trigger an insert, so they
		// should not block re-imports after authorization is revoked.
		const project = remapProject ?? normalizeImportedProject(memory.project);
		const memoryImportKey =
			typeof memory.import_key === "string" && memory.import_key.trim()
				? memory.import_key.trim()
				: buildImportKey("export", "memory", memory.id, {
						project,
						createdAt: typeof memory.created_at === "string" ? memory.created_at : null,
					});
		if (findImportedId(db, "memory_items", memoryImportKey) != null) continue;
		if (!scopeCanBeImported(db, sourceScopeId, deviceId)) {
			unauthorized.add(sourceScopeId);
		}
	}
	if (unauthorized.size > 0) {
		throw new Error(`unauthorized_scope: ${[...unauthorized].sort().join(", ")}`);
	}
}

function insertMemory(db: Database, d: DrizzleDb, row: JsonObject, deviceId: string): number {
	const now = nowIso();
	const parsedActive = row.active == null ? 1 : Number(row.active);
	const active = Number.isFinite(parsedActive) ? parsedActive : 1;
	const deletedAt =
		typeof row.deleted_at === "string" && row.deleted_at.trim().length > 0 ? row.deleted_at : null;
	const workspaceId = row.workspace_id == null ? null : String(row.workspace_id);
	const scopeId = importedMemoryScopeId(db, row, deviceId);
	const values: MemoryInsert = {
		session_id: Number(row.session_id),
		project: cleanProjectIdentity(cleanString(row.project)),
		kind: String(row.kind ?? "observation"),
		title: String(row.title ?? "Untitled"),
		subtitle: row.subtitle == null ? null : String(row.subtitle),
		body_text: String(row.body_text ?? row.narrative ?? ""),
		confidence: Number(row.confidence ?? 0.5),
		tags_text: String(row.tags_text ?? ""),
		active,
		created_at: typeof row.created_at === "string" ? row.created_at : now,
		updated_at: typeof row.updated_at === "string" ? row.updated_at : now,
		metadata_json: toJson(row.metadata_json ?? null),
		actor_id: row.actor_id == null ? null : String(row.actor_id),
		actor_display_name: row.actor_display_name == null ? null : String(row.actor_display_name),
		visibility: row.visibility == null ? null : String(row.visibility),
		workspace_id: workspaceId,
		workspace_kind: row.workspace_kind == null ? null : String(row.workspace_kind),
		origin_device_id: row.origin_device_id == null ? null : String(row.origin_device_id),
		origin_source: row.origin_source == null ? null : String(row.origin_source),
		trust_state: row.trust_state == null ? null : String(row.trust_state),
		facts: toJsonNullable(row.facts),
		narrative: row.narrative == null ? null : String(row.narrative),
		concepts: toJsonNullable(row.concepts),
		files_read: toJsonNullable(row.files_read),
		files_modified: toJsonNullable(row.files_modified),
		user_prompt_id: row.user_prompt_id == null ? null : Number(row.user_prompt_id),
		prompt_number: row.prompt_number == null ? null : Number(row.prompt_number),
		deleted_at: deletedAt,
		rev: Number(row.rev ?? 1),
		import_key: String(row.import_key),
		scope_id: scopeId,
	};
	const rows = d
		.insert(schema.memoryItems)
		.values(values)
		.returning({ id: schema.memoryItems.id })
		.all();
	const id = rows[0]?.id;
	if (id == null) throw new Error("memory insert returned no id");
	return id;
}

function insertSummary(d: DrizzleDb, row: JsonObject): number {
	const rows = d
		.insert(schema.sessionSummaries)
		.values({
			session_id: Number(row.session_id),
			project: row.project == null ? null : String(row.project),
			request: String(row.request ?? ""),
			investigated: String(row.investigated ?? ""),
			learned: String(row.learned ?? ""),
			completed: String(row.completed ?? ""),
			next_steps: String(row.next_steps ?? ""),
			notes: String(row.notes ?? ""),
			files_read: toJsonNullable(row.files_read),
			files_edited: toJsonNullable(row.files_edited),
			prompt_number: row.prompt_number == null ? null : Number(row.prompt_number),
			created_at: typeof row.created_at === "string" ? row.created_at : nowIso(),
			created_at_epoch:
				typeof row.created_at_epoch === "number" ? row.created_at_epoch : nowEpochMs(),
			metadata_json: toJson(row.metadata_json ?? null),
			import_key: String(row.import_key),
		})
		.returning({ id: schema.sessionSummaries.id })
		.all();
	const id = rows[0]?.id;
	if (id == null) throw new Error("summary insert returned no id");
	return id;
}

function importableRecords(payload: ExportPayload) {
	const sessionsData = Array.isArray(payload.sessions) ? payload.sessions : [];
	const memoriesData = Array.isArray(payload.memory_items) ? payload.memory_items : [];
	// Incoming redaction withholds children even when the canonical target is
	// already full. Do not retain them for a later placeholder restoration.
	const redactedSessionIds = new Set(
		sessionsData
			.filter((session) => session.export_session_redacted === true)
			.map((session) => Number(session.id)),
	);
	const summariesData = (
		Array.isArray(payload.session_summaries) ? payload.session_summaries : []
	).filter((summary) => !redactedSessionIds.has(Number(summary.session_id)));
	const promptsData = (Array.isArray(payload.user_prompts) ? payload.user_prompts : []).filter(
		(prompt) => !redactedSessionIds.has(Number(prompt.session_id)),
	);
	return { sessionsData, memoriesData, summariesData, promptsData };
}

function importSessions(
	db: Database,
	d: DrizzleDb,
	sessions: JsonObject[],
	opts: ImportOptions & { memories: JsonObject[] },
) {
	const sessionMapping = new Map<number, number>();
	let importedSessions = 0;
	for (const session of sessions) {
		const result = importSession(db, d, session, opts);
		sessionMapping.set(Number(session.id), result.id);
		if (result.inserted) importedSessions += 1;
	}
	return { sessionMapping, importedSessions };
}

function resolveImportedPromptId(
	db: Database,
	memory: JsonObject,
	sessionId: number,
	incomingSession: JsonObject | undefined,
	mappings: { byId: Map<number, number>; byKey: Map<string, number> },
): number | null {
	if (incomingSession?.export_session_redacted === true) return null;
	let promptId: number | null = null;
	const key = cleanString(memory.user_prompt_import_key);
	if (key) promptId = mappings.byKey.get(key) ?? findImportedId(db, "user_prompts", key);
	else if (typeof memory.user_prompt_id === "number")
		promptId = mappings.byId.get(memory.user_prompt_id) ?? null;
	// Links are session-local; import-key deduplication alone is not enough.
	const prompt = db
		.prepare("SELECT id FROM user_prompts WHERE id = ? AND session_id = ?")
		.get(promptId, sessionId) as { id: number } | undefined;
	return prompt?.id ?? null;
}

function importedMemoryMetadata(memory: JsonObject, importKey: string): JsonObject {
	const metadata: JsonObject = {
		source: "export",
		original_memory_id: memory.id ?? null,
		original_created_at: memory.created_at ?? null,
		import_metadata: memory.metadata_json ?? null,
		import_key: importKey,
	};
	const promptKey = cleanString(memory.user_prompt_import_key);
	if (promptKey) metadata.user_prompt_import_key = promptKey;
	if (memory.kind === "session_summary")
		return mergeSummaryMetadata(metadata, memory.metadata_json ?? null);
	return metadata;
}

function reconcileImportedPromptLink(
	db: Database,
	memoryId: number,
	sessionId: number,
	promptId: number | null,
	incomingSession: JsonObject | undefined,
	opts: Pick<ImportOptions, "remapProject">,
): void {
	if (promptId == null || incomingSession?.export_session_redacted === true) return;
	const marker = cleanString(incomingSession?.export_session_key);
	if (!isCanonicalSessionKey(marker)) return;
	const target = db
		.prepare("SELECT import_key FROM sessions WHERE id = ?")
		.get(sessionId) as JsonObject;
	const expectedKey = opts.remapProject ? remappedSessionKey(marker, opts.remapProject) : marker;
	if (target.import_key !== expectedKey) return;
	const existing = db
		.prepare(
			"SELECT * FROM memory_items WHERE id = ? AND session_id = ? AND user_prompt_id IS NULL",
		)
		.get(memoryId, sessionId) as JsonObject | undefined;
	if (!existing) return;
	// Stored import bookkeeping distinguishes an imported row from a native
	// import-key collision. It grants no creator or scope authority.
	const metadata = normalizeImportMetadata(existing.metadata_json);
	if (metadata?.source !== "export" || metadata.import_key !== existing.import_key) return;
	db.prepare(
		"UPDATE memory_items SET user_prompt_id = ? WHERE id = ? AND user_prompt_id IS NULL",
	).run(promptId, memoryId);
}

export function importMemories(payload: ExportPayload, opts: ImportOptions = {}): ImportResult {
	const { sessionsData, memoriesData, summariesData, promptsData } = importableRecords(payload);

	const db = connect(resolveDbPath(opts.dbPath));
	try {
		assertSchemaReady(db);
		const deviceId = resolveLocalDeviceId(db);
		validateImportScopes(db, memoriesData, deviceId, opts.remapProject ?? null);
		if (opts.dryRun) {
			return {
				sessions: sessionsData.length,
				user_prompts: promptsData.length,
				memory_items: memoriesData.length,
				session_summaries: summariesData.length,
				dryRun: true,
			};
		}
		const d = drizzle(db, { schema });
		return db.transaction(() => {
			const { sessionMapping, importedSessions } = importSessions(db, d, sessionsData, {
				...opts,
				memories: memoriesData,
			});
			const promptMapping = new Map<number, number>();
			const promptImportKeyMapping = new Map<string, number>();
			let importedPrompts = 0;
			let importedMemories = 0;
			let importedSummaries = 0;

			for (const prompt of promptsData) {
				const oldSessionId = Number(prompt.session_id);
				const newSessionId = sessionMapping.get(oldSessionId);
				if (newSessionId == null) continue;
				const project = opts.remapProject || normalizeImportedProject(prompt.project);
				const promptImportKey =
					typeof prompt.import_key === "string" && prompt.import_key.trim()
						? prompt.import_key.trim()
						: buildImportKey("export", "prompt", prompt.id, {
								project,
								createdAt: typeof prompt.created_at === "string" ? prompt.created_at : null,
							});
				const existingId = findImportedId(db, "user_prompts", promptImportKey);
				if (existingId != null) {
					if (typeof prompt.id === "number") promptMapping.set(prompt.id, existingId);
					promptImportKeyMapping.set(promptImportKey, existingId);
					continue;
				}
				const metadata: JsonObject = {
					source: "export",
					original_prompt_id: prompt.id ?? null,
					original_created_at: prompt.created_at ?? null,
					import_metadata: prompt.metadata_json ?? null,
					import_key: promptImportKey,
				};
				const newId = insertPrompt(d, {
					...prompt,
					session_id: newSessionId,
					project,
					metadata_json: metadata,
					import_key: promptImportKey,
				});
				if (typeof prompt.id === "number") promptMapping.set(prompt.id, newId);
				promptImportKeyMapping.set(promptImportKey, newId);
				importedPrompts += 1;
			}

			for (const memory of memoriesData) {
				const oldSessionId = Number(memory.session_id);
				const newSessionId = sessionMapping.get(oldSessionId);
				if (newSessionId == null) continue;
				const project = opts.remapProject || normalizeImportedProject(memory.project);
				const memoryImportKey =
					typeof memory.import_key === "string" && memory.import_key.trim()
						? memory.import_key.trim()
						: buildImportKey("export", "memory", memory.id, {
								project,
								createdAt: typeof memory.created_at === "string" ? memory.created_at : null,
							});
				const existingId = findImportedId(db, "memory_items", memoryImportKey);

				const incomingSession = sessionsData.find((session) => Number(session.id) === oldSessionId);
				const linkedPromptId = resolveImportedPromptId(db, memory, newSessionId, incomingSession, {
					byId: promptMapping,
					byKey: promptImportKeyMapping,
				});
				if (existingId != null) {
					reconcileImportedPromptLink(
						db,
						existingId,
						newSessionId,
						linkedPromptId,
						incomingSession,
						opts,
					);
					continue;
				}

				insertMemory(
					db,
					d,
					{
						...memory,
						session_id: newSessionId,
						project,
						user_prompt_id: linkedPromptId,
						metadata_json: importedMemoryMetadata(memory, memoryImportKey),
						import_key: memoryImportKey,
					},
					deviceId,
				);
				importedMemories += 1;
			}

			reconcilePlaceholderProjects(db, sessionMapping.values(), opts);

			for (const summary of summariesData) {
				const oldSessionId = Number(summary.session_id);
				const newSessionId = sessionMapping.get(oldSessionId);
				if (newSessionId == null) continue;
				const project = opts.remapProject || normalizeImportedProject(summary.project);
				const summaryImportKey =
					typeof summary.import_key === "string" && summary.import_key.trim()
						? summary.import_key.trim()
						: buildImportKey("export", "summary", summary.id, {
								project,
								createdAt: typeof summary.created_at === "string" ? summary.created_at : null,
							});
				if (findImportedId(db, "session_summaries", summaryImportKey) != null) continue;
				const metadata: JsonObject = {
					source: "export",
					original_summary_id: summary.id ?? null,
					original_created_at: summary.created_at ?? null,
					import_metadata: summary.metadata_json ?? null,
					import_key: summaryImportKey,
				};
				insertSummary(d, {
					...summary,
					session_id: newSessionId,
					project,
					metadata_json: metadata,
					import_key: summaryImportKey,
				});
				importedSummaries += 1;
			}

			return {
				sessions: importedSessions,
				user_prompts: importedPrompts,
				memory_items: importedMemories,
				session_summaries: importedSummaries,
				dryRun: false,
			};
		})();
	} finally {
		db.close();
	}
}
