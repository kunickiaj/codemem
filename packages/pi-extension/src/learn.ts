/**
 * memory_learn — guided prompt contract mirrored from
 * packages/mcp-server/src/tools/learn.ts (no store access required).
 */

export const MEMORY_LEARN_PAYLOAD = {
	intro: "Use this tool when you're new to codemem or unsure when to recall/persist.",
	client_hint: "If you are unfamiliar with codemem, call memory.learn first.",
	recall: {
		when: [
			"Start of a task or when the user references prior work.",
			"When you need background context, decisions, or recent changes.",
		],
		how: [
			"Use memory.search_index to get compact candidates.",
			"Use memory.timeline to expand around a promising memory.",
			"Use memory.get_observations for full details only when needed.",
			"Use memory.pack for quick one-shot context blocks.",
			"Use the project filter unless the user requests cross-project context.",
		],
		examples: [
			'memory.search_index("billing cache bug", limit=5)',
			"memory.timeline(memory_id=123)",
			"memory.get_observations([123, 456])",
		],
	},
	persistence: {
		when: [
			"Milestones (task done, key decision, new facts learned).",
			"Notable regressions or follow-ups that should be remembered.",
		],
		how: [
			"Use memory.remember with kind decision/discovery/change/exploration.",
			"Keep titles short and bodies high-signal.",
			"ALWAYS pass the project parameter if known.",
		],
		examples: [
			'memory.remember(kind="decision", title="Switch to async cache", body="...why...", project="my-service")',
			'memory.remember(kind="change", title="Fixed retry loop", body="...impact...", project="my-service")',
		],
	},
	forget: {
		when: [
			"Accidental or sensitive data stored in memory items.",
			"Obsolete or incorrect items that should no longer surface.",
		],
		how: [
			"Call memory.forget(id) to mark the item inactive.",
			"Prefer forgetting over overwriting to preserve auditability.",
		],
		examples: ["memory.forget(123)"],
	},
	prompt_hint:
		"At task start: call memory.search_index; during work: memory.timeline + memory.get_observations; at milestones: memory.remember.",
	recommended_system_prompt: [
		"Trigger policy (1-liner): If the user references prior work or starts a task,",
		"immediately call memory.search_index; then use memory.timeline + memory.get_observations;",
		"at milestones, call memory.remember; use memory.forget for incorrect/sensitive items.",
		"",
		"System prompt:",
		"You have access to codemem memory tools. If unfamiliar, call memory_learn first.",
		"",
		"Recall:",
		"- Start of any task: call memory_search_index with a concise task query.",
		'- If prior work is referenced ("as before", "last time", "we already did…", "regression"),',
		"  call memory_search_index or memory_timeline.",
		"- Use memory_get_observations only after filtering IDs.",
		"- Prefer project-scoped queries unless the user asks for cross-project.",
		"",
		"Persistence:",
		"- On milestones (task done, key decision, new facts learned), call memory_remember.",
		"- Use kind=decision for tradeoffs, kind=change for outcomes, kind=discovery/exploration for useful findings.",
		"- Keep titles short and bodies high-signal.",
		"- ALWAYS pass the project parameter if known.",
		"",
		"Safety:",
		"- Use memory_forget(id) for incorrect or sensitive items.",
		"",
		"Examples:",
		'- memory_search_index("billing cache bug")',
		"- memory_timeline(memory_id=123)",
		"- memory_get_observations([123, 456])",
		'- memory_remember(kind="decision", title="Use async cache", body="Chose async cache to avoid lock contention in X.", project="my-service")',
		'- memory_remember(kind="change", title="Fixed retry loop", body="Root cause was Y; added guard in Z.", project="my-service")',
		"- memory_forget(123)",
	].join("\n"),
} as const;
