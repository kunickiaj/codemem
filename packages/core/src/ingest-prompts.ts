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
Never invent file changes, API behavior, or code edits that are not explicitly present in the session evidence.

GOOD examples (describes what was built or learned):
- "Authentication now supports OAuth2 with PKCE flow"
- "Deployment pipeline runs canary releases with auto-rollback"
- "Fixed race condition in session handler causing duplicate events"
- "Discovered flush timing strategy needed adaptation for multi-session environment"
- "Learned transcript building was broken - empty strings passed instead of conversation"

BAD examples (describes observation process - DO NOT DO THIS):
- "Analyzed authentication implementation and stored findings in database"
- "Tracked deployment steps and logged outcomes to memory system"
- "Recorded investigation results for later reference"`;

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
  <!--
    type MUST be EXACTLY one of these 7 options:
      - bugfix: something was broken, now fixed
      - feature: new capability or functionality added
      - refactor: code restructured, behavior unchanged
      - change: generic modification (docs, config, misc)
      - discovery: learning about existing system, debugging insights
      - decision: architectural/design choice with rationale
      - exploration: attempted approach that was tried but NOT shipped

    IMPORTANT: Use 'exploration' when:
      - Multiple approaches were tried for the same problem
      - An implementation was attempted but then replaced or reverted
      - Something was tested/experimented with but not kept
      - The attempt provides useful "why we didn't do X" context

    Exploration memories are valuable. They prevent repeating failed approaches.
    Include what was tried AND why it didn't work out.
  -->
  <title>[Short outcome-focused title - what was achieved or learned]</title>
  <!-- GOOD: "OAuth2 PKCE flow added to authentication" -->
  <!-- GOOD: "Discovered flush strategy fails in multi-session environments" -->
  <!-- GOOD (exploration): "Tried emoji theme toggle - poor contrast on light backgrounds" -->
  <!-- BAD: "Analyzed authentication code" (too vague, no outcome) -->
  <subtitle>[One sentence explanation of the outcome (max 24 words)]</subtitle>
  <facts>
    <fact>[Specific, self-contained statement with concrete details]</fact>
    <fact>[Include: file paths, function names, config values, error messages]</fact>
    <fact>[Each fact must stand alone - no pronouns like "it" or "this"]</fact>
  </facts>
  <narrative>[
    Full context: What was done, how it works, why it matters.
    For discoveries/debugging: what was investigated, what was found, what it means.
    For explorations: what was tried, why it didn't work, what was done instead.
    Include specific details: file paths, function names, configuration values.
    Aim for 100-500 words - enough to be useful, not overwhelming.
  ]</narrative>
  <concepts>
    <concept>[how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off]</concept>
  </concepts>
  <!-- concepts: 2-5 knowledge categories from the list above -->
  <files_read>
    <file>[full path from project root]</file>
  </files_read>
  <files_modified>
    <file>[full path from project root]</file>
  </files_modified>
</observation>`;

const SUMMARY_SCHEMA = `<summary>
  <request>[What did the user request? What was the goal of this work session?]</request>

  <investigated>[What was explored or examined? What files, systems, logs were reviewed?
  What questions were asked? What did you try to understand?]</investigated>

  <learned>[What was learned about how things work? Any discoveries about the codebase,
  architecture, or domain? Gotchas or surprises? Understanding gained?]</learned>

  <completed>[What work was done? What shipped? What does the system do now that it
  didn't before? Be specific: files changed, features added, bugs fixed.]</completed>

  <next_steps>[What are the logical next steps? What remains to be done? What should
  the next session pick up? Any blockers or dependencies?]</next_steps>

  <notes>[Additional context, insights, or warnings. Anything future sessions should
  know that doesn't fit above. Design decisions, trade-offs, alternatives considered.]</notes>

  <files_read>
    <file>[path]</file>
  </files_read>
  <files_modified>
    <file>[path]</file>
  </files_modified>
</summary>

If nothing meaningful happened, emit <skip_summary reason="low-signal"/> and do not emit <summary>.
Otherwise, write a summary that explains the current state of the PRIMARY work (not your observation process).

If the user prompt is a short approval or acknowledgement ("yes", "ok", "approved"),
infer the request from the observed work and the completed/learned sections instead.

Only summarize what is evidenced in the session context. Do not infer or fabricate
file edits, behaviors, or outcomes that are not explicitly observed.

Keep summaries concise (aim for ~150-450 words total across all fields).

This summary helps future sessions understand where this work left off.`;

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

function truncateMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit <= 20) return text.slice(0, limit);
	const keep = Math.floor((limit - 9) / 2);
	const head = text.slice(0, keep).trimEnd();
	const tail = text.slice(text.length - keep).trimStart();
	return `${head}\n[...]\n${tail}`;
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

	if (context.transcript.trim()) {
		userBlocks.push(
			`<conversation_transcript>\n${escapeXml(context.transcript)}\n</conversation_transcript>`,
		);
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

export function truncateObserverTranscript(transcript: string, maxChars: number): string {
	const trimmed = transcript.trim();
	if (!trimmed) return "";
	return truncateMiddle(trimmed, maxChars);
}
