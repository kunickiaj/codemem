import {
	type MemoryFilters,
	type MemoryItemResponse,
	type MemoryStore,
	toJson,
} from "@codemem/core";

export function getMemoryForMcp(
	store: MemoryStore,
	memoryId: number,
	filters?: MemoryFilters,
): MemoryItemResponse | null {
	const rows = store.timeline(null, memoryId, 0, 0, filters ?? null);
	return rows.find((row) => row.id === memoryId) ?? null;
}

export function getManyForMcp(
	store: MemoryStore,
	ids: number[],
	filters?: MemoryFilters,
): MemoryItemResponse[] {
	if (ids.length === 0) return [];
	const results: MemoryItemResponse[] = [];
	for (const id of ids) {
		const item = getMemoryForMcp(store, id, filters);
		if (item) results.push(item);
	}
	return results;
}

export function forgetMemoryForMcp(
	store: MemoryStore,
	memoryId: number,
	filters?: MemoryFilters,
): boolean {
	const item = getMemoryForMcp(store, memoryId, filters);
	if (!item) return false;
	store.forget(memoryId);
	return true;
}

export interface RememberMemoryForMcpInput {
	kind: string;
	title: string;
	body: string;
	confidence: number;
	project?: string | null;
}

export interface RememberMemoryForMcpContext {
	cwd?: string;
	user?: string;
	envProject?: string | null;
	now?: () => string;
}

export function rememberMemoryForMcp(
	store: MemoryStore,
	input: RememberMemoryForMcpInput,
	context: RememberMemoryForMcpContext = {},
): { memId: number; title: string; body: string } {
	return store.db.transaction(() => {
		const now = context.now?.() ?? new Date().toISOString();
		const user = context.user ?? process.env.USER ?? "unknown";
		const cwd = context.cwd ?? process.cwd();
		const project = input.project ?? context.envProject ?? null;

		const sessionInfo = store.db
			.prepare(
				`INSERT INTO sessions(started_at, ended_at, cwd, project, user, tool_version, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(now, now, cwd, project, user, "mcp-ts", toJson({ mcp: true }));
		const sessionId = Number(sessionInfo.lastInsertRowid);

		const memId = store.remember(sessionId, input.kind, input.title, input.body, input.confidence);
		if (!getMemoryForMcp(store, memId)) {
			throw new Error("unauthorized_scope");
		}

		store.db
			.prepare("UPDATE sessions SET ended_at = ?, metadata_json = ? WHERE id = ?")
			.run(context.now?.() ?? new Date().toISOString(), toJson({ mcp: true }), sessionId);

		return { memId, title: input.title, body: input.body };
	})();
}
