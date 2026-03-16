/**
 * Observer prompt construction for the ingest pipeline.
 *
 * Ports codemem/observer_prompts.py — builds the system + user prompt
 * sent to the observer LLM that extracts memories from session transcripts.
 */

import type { ObserverContext, ToolEvent } from "./ingest-types.js";

// ---------------------------------------------------------------------------
// Constants — prompt fragments matching Python's observer_prompts.py
// ---------------------------------------------------------------------------

const OBSERVATION_TYPES = "bugfix, feature, refactor, change, discovery, decision, exploration";

const SYSTEM_IDENTITY =
	"You are a memory observer creating searchable records of development work " +
	"FOR FUTURE SESSIONS. Record what was BUILT/FIXED/DEPLOYED/CONFIGURED/LEARNED, " +
	"not what you (the observer) are doing. These memories help developers " +
	"recall past work, decisions, learnings, and investigations.";

const RECORDING_FOCUS = `Focus on deliverables, capabilities, AND learnings:
- What the system NOW DOES differently (new capabilities)
- What shipped to users/production (features, fixes, configs, docs)
- What was LEARNED through debugging, investigation, or testing
- How systems work and why they behave the way they do
- Changes in technical domains (auth, data, UI, infra, DevOps)

Use outcome-focused verbs: implemented, fixed, deployed, configured, migrated, optimized, added, refactored, discovered, learned, debugged.
Only describe actions that are clearly supported by the observed context.
Never invent file changes, API behavior, or code edits that are not explicitly present in the session evidence.`;

const SKIP_GUIDANCE = `Skip routine operations WITHOUT learnings:
- Empty status checks or listings (unless revealing important state)
- Package installations with no errors or insights
- Simple file reads with no discoveries
- Repetitive operations already documented with no new findings
If nothing meaningful happened AND nothing was learned:
- Output no <observation> blocks
- Output <skip_summary reason="low-signal"/> instead of a <summary> block.`;

const NARRATIVE_GUIDANCE = `Create narratives that tell the complete story:
- Context: What was the problem or goal? What prompted this work?
- Investigation: What was examined? What was discovered?
- Learning: How does it work? Why does it exist? Any gotchas?
- Implementation: What was changed? What does the code do now?
- Impact: What's better? What does the system do differently?
- Next steps: What remains? What should future sessions know?

Aim for ~120-400 words per significant work item.
Prefer fewer, higher-signal observations over many small ones.
Include specific details when present: file paths, function names, configuration values.`;

const OUTPUT_GUIDANCE =
	"Output only XML. Do not include commentary outside XML.\n\n" +
	"ALWAYS emit at least one <observation> block for any meaningful work. " +
	"Observations are the PRIMARY output - they capture what was built, fixed, learned, or decided. " +
	"Also emit a <summary> block to track session progress.\n\n" +
	"Prefer fewer, more comprehensive observations over many small ones.";

const OBSERVATION_SCHEMA = `<observation>
  <type>[ ${OBSERVATION_TYPES} ]</type>
  <title>[Short outcome-focused title - what was achieved or learned]</title>
  <subtitle>[One sentence explanation of the outcome (max 24 words)]</subtitle>
  <facts>
    <fact>[Specific, self-contained statement with concrete details]</fact>
  </facts>
  <narrative>[
    Full context: What was done, how it works, why it matters.
    Aim for 100-500 words.
  ]</narrative>
  <concepts>
    <concept>[how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off]</concept>
  </concepts>
  <files_read>
    <file>[full path from project root]</file>
  </files_read>
  <files_modified>
    <file>[full path from project root]</file>
  </files_modified>
</observation>`;

const SUMMARY_SCHEMA = `<summary>
  <request>[What did the user request?]</request>
  <investigated>[What was explored or examined?]</investigated>
  <learned>[What was learned about how things work?]</learned>
  <completed>[What work was done? What shipped?]</completed>
  <next_steps>[What are the logical next steps?]</next_steps>
  <notes>[Additional context, insights, or warnings.]</notes>
  <files_read>
    <file>[path]</file>
  </files_read>
  <files_modified>
    <file>[path]</file>
  </files_modified>
</summary>

If nothing meaningful happened, emit <skip_summary reason="low-signal"/> and do not emit <summary>.
Otherwise, write a summary that explains the current state of the PRIMARY work.

Only summarize what is evidenced in the session context. Do not infer or fabricate
file edits, behaviors, or outcomes that are not explicitly observed.

Keep summaries concise (aim for ~150-450 words total across all fields).`;

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatJson(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function formatToolEvent(event: ToolEvent): string {
	const parts = ["<observed_from_primary_session>"];
	parts.push(`  <what_happened>${escapeXml(event.toolName)}</what_happened>`);
	if (event.timestamp) {
		parts.push(`  <occurred_at>${escapeXml(event.timestamp)}</occurred_at>`);
	}
	if (event.cwd) {
		parts.push(`  <working_directory>${escapeXml(event.cwd)}</working_directory>`);
	}
	const params = escapeXml(formatJson(event.toolInput));
	const outcome = escapeXml(formatJson(event.toolOutput));
	const error = escapeXml(formatJson(event.toolError));
	if (params) parts.push(`  <parameters>${params}</parameters>`);
	if (outcome) parts.push(`  <outcome>${outcome}</outcome>`);
	if (error) parts.push(`  <error>${error}</error>`);
	parts.push("</observed_from_primary_session>");
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the observer prompt from session context.
 *
 * Returns `{ system, user }` — the system prompt contains identity + schema,
 * the user prompt contains the observed session context.
 *
 * The Python version concatenates everything into one prompt string passed as
 * the user message. We split system/user for cleaner API mapping, but the
 * content is equivalent.
 */
export function buildObserverPrompt(context: ObserverContext): {
	system: string;
	user: string;
} {
	// System prompt: identity + guidance + schemas
	const systemBlocks: string[] = [
		SYSTEM_IDENTITY,
		"",
		RECORDING_FOCUS,
		"",
		SKIP_GUIDANCE,
		"",
		NARRATIVE_GUIDANCE,
		"",
		OUTPUT_GUIDANCE,
		"",
		"Observation XML schema:",
		OBSERVATION_SCHEMA,
	];
	if (context.includeSummary) {
		systemBlocks.push("", "Summary XML schema:", SUMMARY_SCHEMA);
	}
	const system = systemBlocks.join("\n\n").trim();

	// User prompt: observed session context
	const userBlocks: string[] = ["Observed session context:"];

	if (context.userPrompt) {
		const promptBlock = ["<observed_from_primary_session>"];
		promptBlock.push(`  <user_request>${escapeXml(context.userPrompt)}</user_request>`);
		if (context.promptNumber != null) {
			promptBlock.push(`  <prompt_number>${context.promptNumber}</prompt_number>`);
		}
		if (context.project) {
			promptBlock.push(`  <project>${escapeXml(context.project)}</project>`);
		}
		promptBlock.push("</observed_from_primary_session>");
		userBlocks.push(promptBlock.join("\n"));
	}

	if (context.diffSummary) {
		userBlocks.push(
			`<observed_from_primary_session>\n  <diff_summary>${escapeXml(context.diffSummary)}</diff_summary>\n</observed_from_primary_session>`,
		);
	}

	if (context.recentFiles) {
		userBlocks.push(
			`<observed_from_primary_session>\n  <recent_files>${escapeXml(context.recentFiles)}</recent_files>\n</observed_from_primary_session>`,
		);
	}

	for (const event of context.toolEvents) {
		userBlocks.push(formatToolEvent(event));
	}

	if (context.includeSummary && context.lastAssistantMessage) {
		userBlocks.push("Summary context:");
		userBlocks.push(
			`<summary_context>\n  <assistant_response>${escapeXml(context.lastAssistantMessage)}</assistant_response>\n</summary_context>`,
		);
	}

	const user = userBlocks.join("\n\n").trim();

	return { system, user };
}
