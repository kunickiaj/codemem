export interface InjectionEvalScenario {
	id: string;
	title: string;
	category: "locating" | "decision" | "outcome" | "troubleshooting" | "continuation";
	prompt: string;
	expectedPrimary: string[];
	expectedAntiSignals: string[];
}

export interface InjectionEvalScenarioPack {
	id: string;
	title: string;
	description: string;
	scenarios: InjectionEvalScenario[];
}

export const INJECTION_EVAL_SCENARIO_PACKS: InjectionEvalScenarioPack[] = [
	{
		id: "track3-core",
		title: "Track 3 core injection scenarios",
		description:
			"Core scenarios covering decision continuity, recap control, locating value, and workstream continuation.",
		scenarios: [
			{
				id: "decision-recap-weighting",
				title: "Recap weighting decision continuity",
				category: "decision",
				prompt: "what did we decide about recap weighting",
				expectedPrimary: ["decision", "discovery", "durable"],
				expectedAntiSignals: ["generic recap sludge", "wrong-thread summary"],
			},
			{
				id: "topic-memory-retrieval",
				title: "Memory retrieval topic quality",
				category: "outcome",
				prompt: "memory retrieval issues",
				expectedPrimary: ["discovery", "bugfix", "decision"],
				expectedAntiSignals: ["recap takeover", "unmapped recap"],
			},
			{
				id: "sessionization-summary-emission",
				title: "Sessionization summary emission policy",
				category: "decision",
				prompt: "sessionization summary emission",
				expectedPrimary: ["decision", "durable policy memory"],
				expectedAntiSignals: ["explicit recap bias", "summary-first sludge"],
			},
			{
				id: "oauth-recurrence",
				title: "OAuth recurrence troubleshooting continuity",
				category: "troubleshooting",
				prompt: "what did we decide last time about oauth",
				expectedPrimary: ["decision", "bugfix", "troubleshooting outcome"],
				expectedAntiSignals: ["wrong-thread latest summary", "recap-only output"],
			},
			{
				id: "track3-continuation",
				title: "Track 3 continuation context",
				category: "continuation",
				prompt: "what should we do next about recap policy",
				expectedPrimary: ["decision", "next-step context", "durable workstream context"],
				expectedAntiSignals: ["generic summary", "administrative chatter"],
			},
		],
	},
	{
		id: "track3-explicit-recap",
		title: "Explicit recap quality scenarios",
		description: "Scenarios that verify recap remains useful when the user explicitly asks for it.",
		scenarios: [
			{
				id: "summary-of-oauth",
				title: "Explicit recap request for OAuth work",
				category: "decision",
				prompt: "summary of oauth",
				expectedPrimary: ["session_summary", "recap"],
				expectedAntiSignals: ["missing summary intent", "topic-only refusal"],
			},
			{
				id: "catch-up-retrieval",
				title: "Explicit catch-up request",
				category: "continuation",
				prompt: "catch me up on memory retrieval work",
				expectedPrimary: ["session_summary", "recap", "orientation context"],
				expectedAntiSignals: ["totally summary-free output"],
			},
		],
	},
];

export function getInjectionEvalScenarioPack(id: string): InjectionEvalScenarioPack | null {
	const normalized = id.trim().toLowerCase();
	return INJECTION_EVAL_SCENARIO_PACKS.find((pack) => pack.id === normalized) ?? null;
}

export function getInjectionEvalScenarioPrompts(ids: string[]): string[] {
	const prompts: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const pack = getInjectionEvalScenarioPack(id);
		if (!pack) continue;
		for (const scenario of pack.scenarios) {
			if (seen.has(scenario.prompt)) continue;
			seen.add(scenario.prompt);
			prompts.push(scenario.prompt);
		}
	}
	return prompts;
}
