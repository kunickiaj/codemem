import { readFileSync } from "node:fs";
import {
	assertSchemaReady,
	connect,
	type Database,
	fromJson,
	resolveDbPath,
	toJson,
} from "./db.js";
import { expandUserPath } from "./observer-config.js";
import { projectColumnClause, resolveProject as resolveProjectName } from "./project.js";

type JsonObject = Record<string, unknown>;

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

function querySessions(db: Database, project: string | null, since: string | null): JsonObject[] {
	let sql = "SELECT * FROM sessions";
	const params: unknown[] = [];
	const clauses: string[] = [];
	if (project) {
		const clause = projectColumnClause("project", project);
		if (clause.clause) {
			clauses.push(clause.clause);
			params.push(...clause.params);
		}
	}
	if (since) {
		clauses.push("started_at >= ?");
		params.push(since);
	}
	if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
	sql += " ORDER BY started_at ASC";
	const rows = db.prepare(sql).all(...params) as JsonObject[];
	return rows.map((row) => parseRowJsonFields(row, ["metadata_json"]));
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

export function exportMemories(opts: ExportOptions = {}): ExportPayload {
	const db = connect(resolveDbPath(opts.dbPath));
	try {
		assertSchemaReady(db);
		const resolvedProject = resolveExportProject(opts);
		const filters: JsonObject = {};
		if (resolvedProject) filters.project = resolvedProject;
		if (opts.since) filters.since = opts.since;

		const sessions = querySessions(db, resolvedProject, opts.since ?? null);
		const sessionIds = sessions.map((row) => Number(row.id)).filter(Number.isFinite);

		const memories = fetchBySessionIds(
			db,
			"memory_items",
			sessionIds,
			"created_at ASC",
			opts.includeInactive ? "" : " AND active = 1",
		).map((row) =>
			parseRowJsonFields(row, [
				"metadata_json",
				"facts",
				"concepts",
				"files_read",
				"files_modified",
			]),
		);

		const summaries = fetchBySessionIds(
			db,
			"session_summaries",
			sessionIds,
			"created_at_epoch ASC",
		).map((row) => parseRowJsonFields(row, ["metadata_json", "files_read", "files_edited"]));

		const prompts = fetchBySessionIds(db, "user_prompts", sessionIds, "created_at_epoch ASC").map(
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

function insertSession(db: Database, row: JsonObject): number {
	const info = db
		.prepare(
			`INSERT INTO sessions(
				started_at, ended_at, cwd, project, git_remote, git_branch,
				user, tool_version, metadata_json, import_key
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			nowIso(),
			null,
			String(row.cwd ?? process.cwd()),
			row.project == null ? null : String(row.project),
			row.git_remote == null ? null : String(row.git_remote),
			row.git_branch == null ? null : String(row.git_branch),
			String(row.user ?? nextUserName()),
			String(row.tool_version ?? "import"),
			toJson(row.metadata_json ?? null),
			String(row.import_key),
		);
	return Number(info.lastInsertRowid);
}

function insertPrompt(db: Database, row: JsonObject): number {
	const info = db
		.prepare(
			`INSERT INTO user_prompts(
				session_id, project, prompt_text, prompt_number, created_at,
				created_at_epoch, metadata_json, import_key
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			Number(row.session_id),
			row.project == null ? null : String(row.project),
			String(row.prompt_text ?? ""),
			row.prompt_number == null ? null : Number(row.prompt_number),
			nowIso(),
			nowEpochMs(),
			toJson(row.metadata_json ?? null),
			String(row.import_key),
		);
	return Number(info.lastInsertRowid);
}

function insertMemory(db: Database, row: JsonObject): number {
	const info = db
		.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, subtitle, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, actor_id, actor_display_name,
				visibility, workspace_id, workspace_kind, origin_device_id, origin_source,
				trust_state, facts, narrative, concepts, files_read, files_modified,
				user_prompt_id, prompt_number, deleted_at, rev, import_key
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			Number(row.session_id),
			String(row.kind ?? "observation"),
			String(row.title ?? "Untitled"),
			row.subtitle == null ? null : String(row.subtitle),
			String(row.body_text ?? row.narrative ?? ""),
			Number(row.confidence ?? 0.5),
			String(row.tags_text ?? ""),
			1,
			nowIso(),
			nowIso(),
			toJson(row.metadata_json ?? null),
			row.actor_id == null ? null : String(row.actor_id),
			row.actor_display_name == null ? null : String(row.actor_display_name),
			row.visibility == null ? null : String(row.visibility),
			row.workspace_id == null ? null : String(row.workspace_id),
			row.workspace_kind == null ? null : String(row.workspace_kind),
			row.origin_device_id == null ? null : String(row.origin_device_id),
			row.origin_source == null ? null : String(row.origin_source),
			row.trust_state == null ? null : String(row.trust_state),
			toJson(row.facts ?? null),
			row.narrative == null ? null : String(row.narrative),
			toJson(row.concepts ?? null),
			toJson(row.files_read ?? null),
			toJson(row.files_modified ?? null),
			row.user_prompt_id == null ? null : Number(row.user_prompt_id),
			row.prompt_number == null ? null : Number(row.prompt_number),
			null,
			Number(row.rev ?? 1),
			String(row.import_key),
		);
	return Number(info.lastInsertRowid);
}

function insertSummary(db: Database, row: JsonObject): number {
	const info = db
		.prepare(
			`INSERT INTO session_summaries(
				session_id, project, request, investigated, learned, completed,
				next_steps, notes, files_read, files_edited, prompt_number,
				created_at, created_at_epoch, metadata_json, import_key
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			Number(row.session_id),
			row.project == null ? null : String(row.project),
			String(row.request ?? ""),
			String(row.investigated ?? ""),
			String(row.learned ?? ""),
			String(row.completed ?? ""),
			String(row.next_steps ?? ""),
			String(row.notes ?? ""),
			toJson(row.files_read ?? null),
			toJson(row.files_edited ?? null),
			row.prompt_number == null ? null : Number(row.prompt_number),
			nowIso(),
			nowEpochMs(),
			toJson(row.metadata_json ?? null),
			String(row.import_key),
		);
	return Number(info.lastInsertRowid);
}

export function importMemories(payload: ExportPayload, opts: ImportOptions = {}): ImportResult {
	const sessionsData = Array.isArray(payload.sessions) ? payload.sessions : [];
	const memoriesData = Array.isArray(payload.memory_items) ? payload.memory_items : [];
	const summariesData = Array.isArray(payload.session_summaries) ? payload.session_summaries : [];
	const promptsData = Array.isArray(payload.user_prompts) ? payload.user_prompts : [];

	if (opts.dryRun) {
		return {
			sessions: sessionsData.length,
			user_prompts: promptsData.length,
			memory_items: memoriesData.length,
			session_summaries: summariesData.length,
			dryRun: true,
		};
	}

	const db = connect(resolveDbPath(opts.dbPath));
	try {
		assertSchemaReady(db);
		return db.transaction(() => {
			const sessionMapping = new Map<number, number>();
			const promptMapping = new Map<number, number>();
			const promptImportKeyMapping = new Map<string, number>();
			let importedSessions = 0;
			let importedPrompts = 0;
			let importedMemories = 0;
			let importedSummaries = 0;

			for (const session of sessionsData) {
				const oldSessionId = Number(session.id);
				const project = opts.remapProject || normalizeImportedProject(session.project);
				const importKey = buildImportKey("export", "session", session.id, {
					project,
					createdAt: typeof session.started_at === "string" ? session.started_at : null,
				});
				const existingId = findImportedId(db, "sessions", importKey);
				if (existingId != null) {
					sessionMapping.set(oldSessionId, existingId);
					continue;
				}
				const metadata: JsonObject = {
					source: "export",
					original_session_id: session.id,
					original_started_at: session.started_at ?? null,
					original_ended_at: session.ended_at ?? null,
					import_metadata: session.metadata_json ?? null,
					import_key: importKey,
				};
				const newId = insertSession(db, {
					...session,
					project,
					metadata_json: metadata,
					import_key: importKey,
				});
				sessionMapping.set(oldSessionId, newId);
				importedSessions += 1;
			}

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
				const newId = insertPrompt(db, {
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
				if (findImportedId(db, "memory_items", memoryImportKey) != null) continue;

				let linkedPromptId: number | null = null;
				if (
					typeof memory.user_prompt_import_key === "string" &&
					memory.user_prompt_import_key.trim()
				) {
					linkedPromptId =
						promptImportKeyMapping.get(memory.user_prompt_import_key.trim()) ??
						findImportedId(db, "user_prompts", memory.user_prompt_import_key.trim());
				} else if (typeof memory.user_prompt_id === "number") {
					linkedPromptId = promptMapping.get(memory.user_prompt_id) ?? null;
				}

				const baseMetadata: JsonObject = {
					source: "export",
					original_memory_id: memory.id ?? null,
					original_created_at: memory.created_at ?? null,
					import_metadata: memory.metadata_json ?? null,
					import_key: memoryImportKey,
				};
				if (
					typeof memory.user_prompt_import_key === "string" &&
					memory.user_prompt_import_key.trim()
				) {
					baseMetadata.user_prompt_import_key = memory.user_prompt_import_key.trim();
				}
				const metadata =
					memory.kind === "session_summary"
						? mergeSummaryMetadata(baseMetadata, memory.metadata_json ?? null)
						: baseMetadata;

				insertMemory(db, {
					...memory,
					session_id: newSessionId,
					project,
					user_prompt_id: linkedPromptId,
					metadata_json: metadata,
					import_key: memoryImportKey,
				});
				importedMemories += 1;
			}

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
				insertSummary(db, {
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
