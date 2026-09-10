import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonContent } from "../content.js";

const MEMORY_LEARN_GUIDANCE = {
	intro: "Use this tool when you're new to codemem or unsure when to recall/persist.",
	client_hint: "If you are unfamiliar with codemem, call memory_learn first.",
	recall: {
		when: [
			"Start of a task or when the user references prior work.",
			"When you need background context, decisions, or recent changes.",
		],
		how: [
			"Use memory_search or memory_search_index for exact terms and identifiers; memory_search returns bodies, while memory_search_index returns compact candidates.",
			"Use memory_pack for conceptually relevant context; it combines keyword and semantic search when embeddings are available and falls back to keyword search when they are not.",
			"Use memory_timeline to expand around a promising memory.",
			"Use memory_get or memory_get_observations for full details only when needed.",
			"Use the project filter unless the user requests cross-project context.",
			"Project, trust, and ownership filters organize and select memories; they are not authentication or tenant-isolation controls.",
		],
		examples: [
			'memory_search_index(query="billing cache bug", limit=5)',
			"memory_timeline(memory_id=123)",
			"memory_get_observations(ids=[123, 456])",
		],
	},
	persistence: {
		when: [
			"Milestones (task done, key decision, new facts learned).",
			"Notable regressions or follow-ups that should be remembered.",
		],
		how: [
			"Use memory_remember with kind decision/discovery/change/exploration.",
			"Keep titles short and bodies high-signal.",
			"ALWAYS pass the project parameter if known.",
		],
		examples: [
			'memory_remember(kind="decision", title="Switch to async cache", body="...why...", project="my-service")',
			'memory_remember(kind="change", title="Fixed retry loop", body="...impact...", project="my-service")',
		],
	},
	forget: {
		when: [
			"Obsolete or incorrect items that should no longer surface.",
			"Items that should be soft-deleted; soft deletion is not secure erasure.",
		],
		how: [
			"Call memory_forget(memory_id) to mark the item inactive.",
			"Optional filters constrain the exact-ID lookup; a filter mismatch returns not_found.",
			"Do not treat memory_forget as secure erasure or a user-data erasure guarantee.",
		],
		examples: ["memory_forget(memory_id=123)"],
	},
	prompt_hint:
		"At task start: call memory_search_index for exact terms or memory_pack for conceptual context; during work: memory_timeline + memory_get_observations; at milestones: memory_remember.",
	recommended_system_prompt: [
		"Trigger policy (1-liner): If the user references prior work or starts a task,",
		"call memory_search_index for exact terms or memory_pack for conceptual context; then use",
		"memory_timeline + memory_get_observations; at milestones, call memory_remember.",
		"",
		"System prompt:",
		"You have access to codemem MCP tools. If unfamiliar, call memory_learn first.",
		"",
		"Recall:",
		"- For exact terms or identifiers, use memory_search_index for compact candidates or memory_search for bodies.",
		"- For conceptually relevant context, use memory_pack; it falls back to keyword search without embeddings.",
		'- If prior work is referenced ("as before", "last time", "we already did…", "regression"),',
		"  call memory_search_index, memory_pack, or memory_timeline as appropriate.",
		"- Use memory_get or memory_get_observations only after filtering IDs.",
		"- Prefer project-scoped queries unless the user asks for cross-project.",
		"- Project, trust, and ownership filters select memories; they do not authenticate or isolate tenants.",
		"",
		"Persistence:",
		"- On milestones (task done, key decision, new facts learned), call memory_remember.",
		"- Use kind=decision for tradeoffs, kind=change for outcomes, kind=discovery/exploration for useful findings.",
		"- Keep titles short and bodies high-signal.",
		"- ALWAYS pass the project parameter if known.",
		"",
		"Safety:",
		"- Use memory_forget(memory_id) to soft-delete incorrect or obsolete items; this is not secure erasure.",
		"",
		"Examples:",
		'- memory_search_index(query="billing cache bug")',
		"- memory_timeline(memory_id=123)",
		"- memory_get_observations(ids=[123, 456])",
		'- memory_remember(kind="decision", title="Use async cache", body="Chose async cache to avoid lock contention in X.", project="my-service")',
		'- memory_remember(kind="change", title="Fixed retry loop", body="Root cause was Y; added guard in Z.", project="my-service")',
		"- memory_forget(memory_id=123)",
	].join("\n"),
} as const;

export function registerLearnTools(server: McpServer): void {
	server.tool(
		"memory_learn",
		"Learn how to use codemem memory tools. Call this first if unfamiliar.",
		{},
		async () => jsonContent(MEMORY_LEARN_GUIDANCE),
	);
}
