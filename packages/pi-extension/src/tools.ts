/**
 * Native memory_* tool registration for pi.
 * HTTP preferred via PiCodememClient; CLI fallback for every tool.
 * Errors return as tool results (never throw through pi's loop).
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorResult, jsonResult, type PiCodememClient, type ToolResultContent } from "./client.js";
import { MEMORY_LEARN_PAYLOAD } from "./learn.js";

/** Loose tool def — TypeBox Static inference is intentionally erased at the boundary. */
type AnyToolDef = ToolDefinition;

const filterProps = {
	kind: Type.Optional(Type.String({ description: "Filter by memory kind" })),
	project: Type.Optional(
		Type.String({ description: "Filter by project scope (matches sessions.project)" }),
	),
};

const memoryKind = Type.Union([
	Type.Literal("discovery"),
	Type.Literal("change"),
	Type.Literal("feature"),
	Type.Literal("bugfix"),
	Type.Literal("refactor"),
	Type.Literal("decision"),
	Type.Literal("exploration"),
]);

function asRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function projectOrClient(
	params: Record<string, unknown>,
	client: PiCodememClient,
): string | undefined {
	if (typeof params.project === "string" && params.project.trim()) return params.project.trim();
	return client.project ?? undefined;
}

async function withToolError(
	label: string,
	fn: () => Promise<ToolResultContent>,
): Promise<ToolResultContent> {
	try {
		return await fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return errorResult(`codemem ${label} failed: ${msg}`);
	}
}

async function httpOrCli(
	_client: PiCodememClient,
	_signal: AbortSignal | undefined,
	http: () => Promise<ToolResultContent | null>,
	cli: () => Promise<ToolResultContent>,
): Promise<ToolResultContent> {
	try {
		const httpResult = await http();
		if (httpResult) return httpResult;
	} catch {
		// fall through to CLI
	}
	return cli();
}

/**
 * Parse CLI stdout that may contain log lines before a JSON payload.
 * Scans candidate JSON value starts in document order and returns the first
 * suffix that parses — handling nested top-level objects/arrays correctly
 * (lastIndexOf picks inner objects and breaks on `{"items":[{"id":1}]}`).
 */
export function parseCliJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch !== "{" && ch !== "[") continue;
		try {
			return JSON.parse(trimmed.slice(i));
		} catch {
			// not a parseable suffix — keep scanning
		}
	}
	return trimmed;
}

function paramsOf(params: unknown): Record<string, unknown> {
	return params != null && typeof params === "object" && !Array.isArray(params)
		? (params as Record<string, unknown>)
		: {};
}

/**
 * Build a memory_distill_candidates request body. `all_projects` and `project`
 * are mutually exclusive server-side (memory-tools.ts / MCP distill guard), so
 * client/session project must NOT be attached when all_projects is requested.
 */
export function buildDistillBody(
	params: Record<string, unknown>,
	clientProject?: string,
): Record<string, unknown> {
	const body = { ...(params as Record<string, unknown>) };
	if (params.all_projects === true || params.all_projects === "true") {
		delete body.project;
		return body;
	}
	if (typeof body.project !== "string" || !body.project.trim()) {
		if (clientProject) body.project = clientProject;
	}
	return body;
}

export function registerMemoryTools(pi: ExtensionAPI, client: PiCodememClient): string[] {
	const registered: string[] = [];

	const register = (def: AnyToolDef) => {
		pi.registerTool(def);
		registered.push(def.name);
	};

	// Helper: build a tool def without fighting TypeBox Static inference at the boundary.
	const tool = (def: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
		) => Promise<ToolResultContent>;
	}): AnyToolDef => def as unknown as AnyToolDef;

	// ---- memory_search ----
	register(
		tool({
			name: "memory_search",
			label: "Memory Search",
			description: "Search memories by text query. Returns full body text for each match.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, default: 5, description: "Max results" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_search", async () => {
					const query = String(params.query ?? "");
					const limit = Number(params.limit ?? 5);
					const project = projectOrClient(params as Record<string, unknown>, client);
					const kind = typeof params.kind === "string" ? params.kind : undefined;

					return httpOrCli(
						client,
						signal,
						async () => {
							// Full-body search: search_index + expand(include_observations).
							const index = await client.httpJson("GET", "/api/memories/search_index", {
								query: { query, limit, project, kind },
								signal,
							});
							if (!index.ok) return null;
							const items = asRecord(index.data).items;
							if (!Array.isArray(items) || items.length === 0) {
								return jsonResult({ items: [] });
							}
							const ids = items
								.map((item) => asRecord(item).id)
								.filter((id): id is number => typeof id === "number");
							if (ids.length === 0) return jsonResult({ items });
							const expanded = await client.httpJson("POST", "/api/memories/expand", {
								body: {
									ids,
									depth_before: 0,
									depth_after: 0,
									include_observations: true,
									project,
									kind,
								},
								signal,
							});
							if (expanded.ok) {
								const obs = asRecord(expanded.data).observations;
								if (Array.isArray(obs) && obs.length > 0) {
									return jsonResult({ items: obs });
								}
								const anchors = asRecord(expanded.data).anchors;
								if (Array.isArray(anchors)) return jsonResult({ items: anchors });
							}
							return jsonResult({ items });
						},
						async () => {
							const args = ["search", query, "--json", "-n", String(limit)];
							if (project) args.push("--project", project);
							if (kind) args.push("--kind", kind);
							const { stdout } = await client.execCodemem(args, { signal });
							return jsonResult(parseCliJson(stdout) ?? { items: [] });
						},
					);
				});
			},
		}),
	);

	// ---- memory_search_index ----
	register(
		tool({
			name: "memory_search_index",
			label: "Memory Search Index",
			description:
				"Search memories by text query. Returns compact index entries (no body) for browsing.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, default: 8, description: "Max results" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_search_index", async () => {
					const query = String(params.query ?? "");
					const limit = Number(params.limit ?? 8);
					const project = projectOrClient(params as Record<string, unknown>, client);
					const kind = typeof params.kind === "string" ? params.kind : undefined;
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("GET", "/api/memories/search_index", {
								query: { query, limit, project, kind },
								signal,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							const args = ["search", query, "--json", "-n", String(limit)];
							if (project) args.push("--project", project);
							if (kind) args.push("--kind", kind);
							const { stdout } = await client.execCodemem(args, { signal });
							const parsed = parseCliJson(stdout);
							// Compact: drop body fields if present.
							const record = asRecord(parsed);
							const items = Array.isArray(record.items)
								? record.items
								: Array.isArray(parsed)
									? parsed
									: [];
							const compact = items.map((item) => {
								const row = asRecord(item);
								return {
									id: row.id,
									kind: row.kind,
									title: row.title,
									score: row.score,
									created_at: row.created_at,
									session_id: row.session_id,
									metadata: row.metadata,
								};
							});
							return jsonResult({ items: compact });
						},
					);
				});
			},
		}),
	);

	// ---- memory_explain ----
	register(
		tool({
			name: "memory_explain",
			label: "Memory Explain",
			description: "Explain why memories match a query or set of IDs (ranking diagnostics).",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: "Search query" })),
				ids: Type.Optional(
					Type.Array(Type.Integer(), { maxItems: 200, description: "Memory IDs to explain" }),
				),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Max results" }),
				),
				include_pack_context: Type.Optional(
					Type.Boolean({ description: "Include pack assembly context" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_explain", async () => {
					const body = { ...(params as Record<string, unknown>) };
					if (!body.project && client.project) body.project = client.project;
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("POST", "/api/memories/explain", {
								body,
								signal,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							// No dedicated CLI twin — surface a clear degraded message.
							return errorResult(
								"memory_explain requires the codemem viewer server (HTTP). Start it with `codemem serve start`.",
							);
						},
					);
				});
			},
		}),
	);

	// ---- memory_recent ----
	register(
		tool({
			name: "memory_recent",
			label: "Memory Recent",
			description: "Return recent memories, newest first.",
			parameters: Type.Object({
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 100, default: 8, description: "Max results" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_recent", async () => {
					const limit = Number(params.limit ?? 8);
					const project = projectOrClient(params as Record<string, unknown>, client);
					const kind = typeof params.kind === "string" ? params.kind : undefined;
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("GET", "/api/memory", {
								query: { limit, project, kind },
								signal,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							const args = ["recent", "--json", "--limit", String(limit)];
							if (project) args.push("--project", project);
							if (kind) args.push("--kind", kind);
							const { stdout } = await client.execCodemem(args, { signal });
							return jsonResult(parseCliJson(stdout) ?? { items: [] });
						},
					);
				});
			},
		}),
	);

	// ---- memory_pack ----
	register(
		tool({
			name: "memory_pack",
			label: "Memory Pack",
			description:
				"Build a formatted memory pack from search results — quick one-shot context block.",
			parameters: Type.Object({
				context: Type.String({ description: "Context description to search for" }),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, description: "Max items to include" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_pack", async () => {
					const context = String(params.context ?? "");
					const limit = params.limit != null ? Number(params.limit) : undefined;
					const project = projectOrClient(params as Record<string, unknown>, client);
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("GET", "/api/pack", {
								query: {
									context,
									limit: limit ?? 10,
									token_budget: client.config.injectTokenBudget,
									project,
								},
								signal,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							const args = ["pack", context, "--json"];
							if (limit != null) args.push("-n", String(limit));
							if (project) args.push("--project", project);
							const { stdout } = await client.execCodemem(args, { signal });
							return jsonResult(parseCliJson(stdout) ?? {});
						},
					);
				});
			},
		}),
	);

	// ---- memory_get ----
	register(
		tool({
			name: "memory_get",
			label: "Memory Get",
			description: "Fetch a single memory item by ID.",
			parameters: Type.Object({
				memory_id: Type.Integer({ description: "Memory ID" }),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_get", async () => {
					const memoryId = Number(params.memory_id);
					const project = projectOrClient(params as Record<string, unknown>, client);
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("POST", "/api/memories/expand", {
								body: {
									ids: [memoryId],
									depth_before: 0,
									depth_after: 0,
									include_observations: true,
									project,
								},
								signal,
							});
							if (!res.ok) return null;
							const data = asRecord(res.data);
							const obs = Array.isArray(data.observations) ? data.observations : [];
							const anchors = Array.isArray(data.anchors) ? data.anchors : [];
							const item = obs[0] ?? anchors[0] ?? null;
							if (!item) return errorResult("not_found");
							return jsonResult(item);
						},
						async () => {
							const { stdout } = await client.execCodemem(
								["memory", "show", String(memoryId), "--json"],
								{ signal },
							);
							const parsed = parseCliJson(stdout);
							if (
								parsed != null &&
								typeof parsed === "object" &&
								!Array.isArray(parsed) &&
								(parsed as { error?: string }).error
							) {
								return errorResult(String((parsed as { message?: string }).message ?? "not_found"));
							}
							return jsonResult(parsed);
						},
					);
				});
			},
		}),
	);

	// ---- memory_get_observations ----
	register(
		tool({
			name: "memory_get_observations",
			label: "Memory Get Observations",
			description: "Fetch multiple memory items by their IDs.",
			parameters: Type.Object({
				ids: Type.Array(Type.Integer(), { maxItems: 200, description: "Memory IDs to fetch" }),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_get_observations", async () => {
					const ids = Array.isArray(params.ids) ? params.ids.map(Number) : [];
					const project = projectOrClient(params as Record<string, unknown>, client);
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("POST", "/api/memories/expand", {
								body: {
									ids,
									depth_before: 0,
									depth_after: 0,
									include_observations: true,
									project,
								},
								signal,
							});
							if (!res.ok) return null;
							const data = asRecord(res.data);
							const items = Array.isArray(data.observations)
								? data.observations
								: Array.isArray(data.anchors)
									? data.anchors
									: [];
							return jsonResult({ items });
						},
						async () => {
							const items: unknown[] = [];
							for (const id of ids) {
								try {
									const { stdout } = await client.execCodemem(
										["memory", "show", String(id), "--json"],
										{ signal },
									);
									const parsed = parseCliJson(stdout);
									if (
										parsed != null &&
										typeof parsed === "object" &&
										!(parsed as { error?: string }).error
									) {
										items.push(parsed);
									}
								} catch {
									// skip missing
								}
							}
							return jsonResult({ items });
						},
					);
				});
			},
		}),
	);

	// ---- memory_remember ----
	register(
		tool({
			name: "memory_remember",
			label: "Memory Remember",
			description: "Create a new memory. Use for milestones, decisions, and notable facts.",
			parameters: Type.Object({
				kind: memoryKind,
				title: Type.String({ description: "Short title" }),
				body: Type.String({ description: "Body text (high-signal content)" }),
				confidence: Type.Optional(
					Type.Number({ minimum: 0, maximum: 1, default: 0.5, description: "Confidence 0-1" }),
				),
				project: Type.Optional(Type.String({ description: "Project identifier" })),
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_remember", async () => {
					const project = projectOrClient(params as Record<string, unknown>, client);
					const body = {
						kind: params.kind,
						title: params.title,
						body: params.body,
						confidence: params.confidence ?? 0.5,
						project,
					};
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("POST", "/api/memories/remember", {
								body,
								signal,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							const args = [
								"memory",
								"remember",
								"-k",
								String(params.kind),
								"-t",
								String(params.title),
								"-b",
								String(params.body),
								"--json",
							];
							if (project) args.push("--project", project);
							const { stdout } = await client.execCodemem(args, { signal });
							return jsonResult(parseCliJson(stdout) ?? { status: "ok" });
						},
					);
				});
			},
		}),
	);

	// ---- memory_forget ----
	register(
		tool({
			name: "memory_forget",
			label: "Memory Forget",
			description: "Soft-delete a memory item. Use for incorrect or sensitive data.",
			parameters: Type.Object({
				memory_id: Type.Integer({ description: "Memory ID to forget" }),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_forget", async () => {
					const memoryId = Number(params.memory_id);
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("POST", "/api/memories/forget", {
								body: { memory_id: memoryId },
								signal,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							const { stdout } = await client.execCodemem(
								["memory", "forget", String(memoryId), "--json"],
								{ signal },
							);
							return jsonResult(parseCliJson(stdout) ?? { status: "ok" });
						},
					);
				});
			},
		}),
	);

	// ---- memory_learn ----
	register(
		tool({
			name: "memory_learn",
			label: "Memory Learn",
			description: "Learn how to use codemem memory tools. Call this first if unfamiliar.",
			parameters: Type.Object({}),
			async execute() {
				return jsonResult(MEMORY_LEARN_PAYLOAD);
			},
		}),
	);

	// ---- memory_schema ----
	register(
		tool({
			name: "memory_schema",
			label: "Memory Schema",
			description: "Return the memory schema — kinds, fields, and available filters.",
			parameters: Type.Object({}),
			async execute(_id, _rawParams, signal) {
				return withToolError("memory_schema", async () => {
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("GET", "/api/memories/schema", { signal });
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							// Static fallback matching MCP memory_schema when viewer is down.
							return jsonResult({
								kinds: [
									"discovery",
									"change",
									"feature",
									"bugfix",
									"refactor",
									"decision",
									"exploration",
								],
								kind_descriptions: {
									discovery: "Something learned about the codebase, architecture, or tools",
									change: "A code change that was made",
									feature: "A new feature that was implemented",
									bugfix: "A bug that was found and fixed",
									refactor: "Code that was refactored or restructured",
									decision: "A design or architecture decision",
									exploration: "An experiment or investigation (may not have shipped)",
								},
								fields: {
									title: "short text",
									body: "long text",
									subtitle: "short text",
									facts: "list<string>",
									narrative: "long text",
									concepts: "list<string>",
									files_read: "list<string>",
									files_modified: "list<string>",
									prompt_number: "int",
								},
								filters: ["kind", "project"],
								note: "schema served from extension fallback (viewer unreachable)",
							});
						},
					);
				});
			},
		}),
	);

	// ---- memory_timeline ----
	register(
		tool({
			name: "memory_timeline",
			label: "Memory Timeline",
			description: "Get a chronological window of memories around an anchor (by ID or query).",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: "Search query to find anchor" })),
				memory_id: Type.Optional(Type.Integer({ description: "Anchor memory ID" })),
				depth_before: Type.Optional(
					Type.Integer({ minimum: 0, default: 3, description: "Items before anchor" }),
				),
				depth_after: Type.Optional(
					Type.Integer({ minimum: 0, default: 3, description: "Items after anchor" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_timeline", async () => {
					const project = projectOrClient(params as Record<string, unknown>, client);
					const kind = typeof params.kind === "string" ? params.kind : undefined;
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("GET", "/api/memories/timeline", {
								query: {
									query: typeof params.query === "string" ? params.query : undefined,
									memory_id: typeof params.memory_id === "number" ? params.memory_id : undefined,
									depth_before: typeof params.depth_before === "number" ? params.depth_before : 3,
									depth_after: typeof params.depth_after === "number" ? params.depth_after : 3,
									project,
									kind,
								},
								signal,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							return errorResult(
								"memory_timeline requires the codemem viewer server (HTTP). Start it with `codemem serve start`.",
							);
						},
					);
				});
			},
		}),
	);

	// ---- memory_expand ----
	register(
		tool({
			name: "memory_expand",
			label: "Memory Expand",
			description: "Fetch memories by ID with surrounding timeline context.",
			parameters: Type.Object({
				ids: Type.Array(Type.Union([Type.Integer(), Type.String()]), {
					maxItems: 200,
					description: "Memory IDs to expand",
				}),
				depth_before: Type.Optional(
					Type.Integer({ minimum: 0, default: 3, description: "Timeline items before" }),
				),
				depth_after: Type.Optional(
					Type.Integer({ minimum: 0, default: 3, description: "Timeline items after" }),
				),
				include_observations: Type.Optional(
					Type.Boolean({ default: false, description: "Include full observation details" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_expand", async () => {
					const body = {
						ids: params.ids,
						depth_before: params.depth_before ?? 3,
						depth_after: params.depth_after ?? 3,
						include_observations: params.include_observations ?? false,
						project: projectOrClient(params as Record<string, unknown>, client),
						kind: typeof params.kind === "string" ? params.kind : undefined,
					};
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("POST", "/api/memories/expand", {
								body,
								signal,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							return errorResult(
								"memory_expand requires the codemem viewer server (HTTP). Start it with `codemem serve start`.",
							);
						},
					);
				});
			},
		}),
	);

	// ---- memory_distill_candidates ----
	register(
		tool({
			name: "memory_distill_candidates",
			label: "Memory Distill Candidates",
			description: "Mine recurring memories into reviewable context candidates.",
			parameters: Type.Object({
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Max candidates" }),
				),
				min_recurrence: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: 50,
						default: 2,
						description: "Minimum member count per candidate",
					}),
				),
				kind: Type.Optional(Type.String({ description: "Memory kind to mine" })),
				project: Type.Optional(Type.String({ description: "Project identifier" })),
				all_projects: Type.Optional(
					Type.Boolean({ description: "Mine memories across all projects" }),
				),
				include_documented: Type.Optional(
					Type.Boolean({
						description: "Include candidates already represented in context files",
					}),
				),
				judge: Type.Optional(
					Type.Boolean({
						description: "Run observer worthiness judgment (default true)",
					}),
				),
			}),
			async execute(_id, rawParams, signal) {
				const params = paramsOf(rawParams);
				return withToolError("memory_distill_candidates", async () => {
					const body = buildDistillBody(
						params as Record<string, unknown>,
						client.project ?? undefined,
					);
					return httpOrCli(
						client,
						signal,
						async () => {
							const res = await client.httpJson("POST", "/api/memories/distill_candidates", {
								body,
								signal,
								timeoutMs: 60_000,
							});
							if (!res.ok) return null;
							return jsonResult(res.data);
						},
						async () => {
							const args = ["distill", "--json"];
							if (params.limit != null) args.push("-l", String(params.limit));
							if (params.min_recurrence != null) {
								args.push("-m", String(params.min_recurrence));
							}
							if (typeof params.kind === "string" && params.kind) {
								args.push("-k", params.kind);
							}
							const project = body.project;
							if (typeof project === "string" && project) args.push("-p", project);
							if (params.all_projects) args.push("-A");
							if (params.include_documented) args.push("--include-documented");
							if (params.judge === false) args.push("--no-judge");
							const { stdout } = await client.execCodemem(args, {
								signal,
								timeoutMs: 60_000,
							});
							return jsonResult(parseCliJson(stdout) ?? {});
						},
					);
				});
			},
		}),
	);

	return registered;
}

/** No-op helper for tests asserting tool absence in adapter mode. */
export function expectedToolNames(): string[] {
	return [
		"memory_search",
		"memory_search_index",
		"memory_explain",
		"memory_recent",
		"memory_pack",
		"memory_get",
		"memory_get_observations",
		"memory_remember",
		"memory_forget",
		"memory_learn",
		"memory_schema",
		"memory_timeline",
		"memory_expand",
		"memory_distill_candidates",
	];
}
