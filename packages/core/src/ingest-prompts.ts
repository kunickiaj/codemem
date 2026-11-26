/**
 * Observer prompt construction for the ingest pipeline.
 *
 * Ports codemem/observer_prompts.py — builds the system + user prompt
 * sent to the observer LLM that extracts memories from session transcripts.
 */

import {
	boundedDelegatedBriefs,
	DELEGATED_BRIEF_LABEL,
	MAX_DELEGATED_CONTEXT_CHARS,
} from "./capture-context.js";
import { budgetToolEvents } from "./ingest-events.js";
import { stripPrivate, stripPrivateObj } from "./ingest-sanitize.js";
import type { ObserverContext, ToolEvent } from "./ingest-types.js";
import { OBSERVER_CONCEPTS } from "./observer-concepts.js";
import {
	DEFAULT_OBSERVER_MAX_CHARS,
	type ObserverContentSection,
	observerContentBudget,
} from "./observer-prompt-budget.js";

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
Leave out unsupported claims instead of hedging them. Do not write about what the session context lacks, what was not measured, or what the evidence does not show. Do not record that something stayed unchanged or that a check found nothing unless a future session would otherwise assume the opposite.

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

const WORTHINESS_GUIDANCE = `Observation worthiness policy:
- Emit an <observation> only for a durable, reusable lesson such as a constraint, root cause, decision with rationale, or how-it-works insight.
- When a durable lesson exists, emit it as an <observation>; do not leave it only in <summary>.
- Routine status, review, setup, and workflow narration belongs only in <summary>.
- Zero observations is valid when the session contains no durable lesson.`;

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

const RICH_SESSION_GUIDANCE = `When the session contains MULTIPLE meaningful threads:
- Before writing XML, mentally inventory the 2-4 highest-value subthreads that future sessions would most want for rediscovery reduction.
- Treat the <summary> as the broad session-wide state, not a recap of only the latest thread.
- Cover the major subthreads in the summary when they materially changed the direction, outcome, or understanding of the work.
- Do not let recency dominate: a long transcript often ends on only one thread, but the output should still represent the major work across the full observed batch.
- Emit a SMALL capped set of durable <observation> blocks for the subthreads that pass the worthiness bar (usually 2-4, not a dump of everything).
- If 2 or more subthreads each pass the worthiness bar, cover each with its own <observation>; do not collapse them into summary-only output.
- If no subthread passes the worthiness bar, emit a <summary> and zero <observation> blocks — a long, busy session can still contain nothing durable.
- Prefer one durable observation per distinct subthread, not several observations for one thread and silence for the others.
- Prefer coverage diversity: do not emit multiple observations that mostly restate the same dominant thread.
- Choose subthreads that future sessions would most want for rediscovery reduction: important decisions, durable learnings, shipped changes, closed investigations, or troubleshooting outcomes.
- If one thread clearly dominates and the rest are trivial, keep a single observation. Do not invent diversity where none exists.`;

function jsonOutputGuidance(guidance: string): string {
	return guidance
		.replace(
			"Output only XML. Do not include commentary outside XML.",
			"Return only the supplied JSON object.",
		)
		.replace("Output no <observation> blocks", "Return no observations")
		.replace(
			'Output <skip_summary reason="low-signal"/> instead of a <summary> block.',
			'Set status to skipped with skip_reason "low-signal" and summary to null.',
		)
		.replaceAll("an <observation>", "an observation")
		.replaceAll("in <summary>", "in the summary")
		.replace("Before writing XML", "Before producing output")
		.replaceAll("the <summary>", "the summary")
		.replaceAll("<observation> blocks", "observations")
		.replaceAll("<observation>", "observation")
		.replaceAll("a <summary>", "a summary");
}

const OUTPUT_GUIDANCE =
	"Output only XML. Do not include commentary outside XML.\n\n" +
	"Emit <observation> blocks only for content that passes the observation worthiness bar. " +
	"Observations are the durable layer - they capture what was built, fixed, learned, or decided. " +
	"Also emit a <summary> block to track session progress; the summary alone carries routine activity.\n\n" +
	"For rich multi-thread sessions, prefer one broad summary plus a small set of durable observations covering the highest-value subthreads.\n\n" +
	"For rich sessions, do not return summary-only output when multiple substantial durable subthreads are present.\n\n" +
	"Do not collapse a rich batch into only the final or most recent thread when earlier threads produced durable decisions, learnings, or outcomes.\n\n" +
	"Prefer fewer, more comprehensive observations over many small ones.";

const OBSERVATIONS_ONLY_GUIDANCE = `Recover durable, reusable facts from the observed evidence.
- Emit only <observation> blocks for supported constraints, root causes, decisions, or how-it-works findings.
- For multiple meaningful threads, include a small, diverse set of observations rather than repeating one thread.
- Routine status, workflow narration, and unsupported guesses do not become observations.
- Do not emit <summary> blocks. This historical pass must not replace a later session recap.
- If there is no durable finding, emit only <skip_summary reason="low-signal"/>.
Output only XML with no commentary outside these blocks.`;

const OBSERVATION_SCHEMA = `<observation>
  <type>[ ${OBSERVATION_TYPES} ]</type>
  <!--
    type MUST be EXACTLY one of these 7 options:
      - bugfix: something was broken, now fixed
      - feature: new capability or functionality added
      - refactor: code restructured, behavior unchanged
      - change: generic modification (docs, config, misc)
      - discovery: learning about existing system, debugging insights
        (NOT routine lookups, status checks, or process narration)
      - decision: architectural/design choice with rationale
        (NOT restating existing workflow policy)
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
    <concept>[${OBSERVER_CONCEPTS.join(", ")}]</concept>
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

For rich sessions, make the summary broad enough that a future reader can see the major subthreads without reading every observation.

This summary helps future sessions understand where this work left off.`;

const SUMMARY_GUIDANCE = `Summary fields describe the current state of the primary work, not the observation process:
- request: what the user requested and the goal of the session.
- investigated: files, systems, logs, questions, and approaches examined.
- learned: durable discoveries about the codebase, architecture, or domain.
- completed: shipped work and concrete outcomes, including specific files and behavior changes.
- next_steps: remaining work, blockers, dependencies, and the next useful action.
- notes: relevant decisions, trade-offs, alternatives, or warnings not covered above.

If the user prompt is a short approval or acknowledgement ("yes", "ok", "approved"), infer the request from the observed work and the completed or learned fields instead.
Only summarize what is evidenced in the session context. Do not infer or fabricate file edits, behaviors, or outcomes that are not explicitly observed.
Keep summaries concise (aim for ~150-450 words total across all fields). For rich sessions, cover the major subthreads so a future reader does not need every observation.`;

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

/** A tool event whose every rendered value, keys included, has lost its private blocks. */
function visibleToolEvent(event: ToolEvent): ToolEvent {
	return {
		toolName: stripPrivate(event.toolName),
		timestamp: stripPrivate(event.timestamp ?? "") || null,
		cwd: stripPrivate(event.cwd ?? "") || null,
		toolInput: stripPrivateObj(event.toolInput),
		toolOutput: stripPrivateObj(event.toolOutput),
		toolError: stripPrivateObj(event.toolError),
	};
}

/** `escapedOutcome` replaces the event's escaped outcome, for a cut event. */
function formatToolEvent(event: ToolEvent, escapedOutcome?: string): string {
	const parts = ["<observed_from_primary_session>"];
	parts.push(`  <what_happened>${escapeXml(event.toolName)}</what_happened>`);
	if (event.timestamp) {
		parts.push(`  <occurred_at>${escapeXml(event.timestamp)}</occurred_at>`);
	}
	if (event.cwd) {
		parts.push(`  <working_directory>${escapeXml(event.cwd)}</working_directory>`);
	}
	const params = escapeXml(formatJson(stripPrivateObj(event.toolInput)));
	const outcome = escapedOutcome ?? escapeXml(formatJson(stripPrivateObj(event.toolOutput)));
	const error = escapeXml(formatJson(stripPrivateObj(event.toolError)));
	if (params) parts.push(`  <parameters>${params}</parameters>`);
	if (outcome) parts.push(`  <outcome>${outcome}</outcome>`);
	if (error) parts.push(`  <error>${error}</error>`);
	parts.push("</observed_from_primary_session>");
	return parts.join("\n");
}

function truncateMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit <= 30) return text.slice(0, limit);
	const marker = "\n[...]\n";
	const markerCost = marker.length * 2;
	const available = limit - markerCost;
	if (available <= 15) {
		const keep = Math.floor((limit - marker.length) / 2);
		const head = text.slice(0, keep).trimEnd();
		const tail = text.slice(text.length - keep).trimStart();
		return `${head}${marker}${tail}`;
	}
	const headLen = Math.floor(available * 0.35);
	const middleLen = Math.floor(available * 0.3);
	const tailLen = available - headLen - middleLen;
	const head = text.slice(0, headLen).trimEnd();
	const middleStart = Math.max(0, Math.floor((text.length - middleLen) / 2));
	const middle = text.slice(middleStart, middleStart + middleLen).trim();
	const tail = text.slice(text.length - tailLen).trimStart();
	return `${head}${marker}${middle}${marker}${tail}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function observerGuidance(outputMode: "json_schema" | "legacy_xml", guidance: string): string {
	return outputMode === "json_schema" ? jsonOutputGuidance(guidance) : guidance;
}

function buildObservationsOnlySystemPrompt(outputMode: "json_schema" | "legacy_xml"): string {
	const blocks = [SYSTEM_IDENTITY, RECORDING_FOCUS, NARRATIVE_GUIDANCE];
	if (outputMode === "json_schema") {
		blocks.push(
			"Recover only durable, supported observations from the historical evidence. Do not create a session recap. Return one JSON object conforming to the supplied JSON Schema with summary set to null. If nothing durable was learned, set status to skipped, observations to [], summary to null, and skip_reason to low-signal. Do not output XML or extra prose.",
		);
	} else {
		blocks.push(OBSERVATIONS_ONLY_GUIDANCE, "Observation XML schema:", OBSERVATION_SCHEMA);
	}
	return blocks.join("\n\n");
}

function buildObserverSystemPrompt(
	context: ObserverContext,
	outputMode: "json_schema" | "legacy_xml",
): string {
	if (!context.includeSummary) return buildObservationsOnlySystemPrompt(outputMode);
	const systemBlocks: string[] = [
		SYSTEM_IDENTITY,
		"",
		RECORDING_FOCUS,
		"",
		observerGuidance(outputMode, SKIP_GUIDANCE),
		"",
		observerGuidance(outputMode, WORTHINESS_GUIDANCE),
		"",
		NARRATIVE_GUIDANCE,
		"",
		observerGuidance(outputMode, RICH_SESSION_GUIDANCE),
	];
	if (outputMode === "json_schema") {
		systemBlocks.push(
			"",
			jsonOutputGuidance(OUTPUT_GUIDANCE),
			"",
			'Return one JSON object that conforms exactly to the supplied JSON Schema. Do not emit XML, Markdown, or prose outside the object. When nothing should be captured, set status to skipped, observations to [], summary to null, and skip_reason to exactly "low-signal".',
		);
	} else {
		systemBlocks.push("", OUTPUT_GUIDANCE, "", "Observation XML schema:", OBSERVATION_SCHEMA);
	}
	if (context.includeSummary && outputMode === "legacy_xml") {
		systemBlocks.push("", "Summary XML schema:", SUMMARY_SCHEMA);
	} else if (context.includeSummary) {
		systemBlocks.push("", SUMMARY_GUIDANCE, "", "Emit a summary unless status is skipped.");
	} else if (outputMode === "json_schema") {
		systemBlocks.push("", "No summary was requested. Set summary to null.");
	}
	return systemBlocks.join("\n\n").trim();
}

function escapedDelegatedBriefsWithinBudget(briefs: readonly string[], budget: number): string {
	let remaining = budget;
	const bounded: string[] = [];
	for (const brief of briefs.slice().reverse()) {
		const separatorLength = bounded.length === 0 ? 0 : 2;
		if (remaining <= separatorLength) break;
		const text = escapeXmlWithinBudget(brief, remaining - separatorLength);
		if (!text) continue;
		bounded.push(text);
		remaining -= separatorLength + text.length;
	}
	return bounded.reverse().join("\n\n");
}

function escapeXmlWithinBudget(text: string, budget: number): string {
	let escaped = "";
	// Escape whole code points so neither XML entities nor surrogate pairs are split.
	for (const character of text.toWellFormed()) {
		const entity = escapeXml(character);
		if (escaped.length + entity.length > budget) break;
		escaped += entity;
	}
	return escaped;
}

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
export function buildObserverPrompt(
	context: ObserverContext,
	options: {
		outputMode?: "json_schema" | "legacy_xml";
		/** The observer's `observer_max_chars`; when set, over-budget content is fitted by section. */
		maxChars?: number;
	} = {},
): {
	system: string;
	user: string;
	sections: ObserverContentSection[];
} {
	const outputMode = options.outputMode ?? "legacy_xml";
	const system = buildObserverSystemPrompt(context, outputMode);
	const sections = observedContentSections(context);
	const full = assembleContent(sections.map((section) => section.text));
	const contentBudget =
		options.maxChars === undefined
			? Number.POSITIVE_INFINITY
			: observerContentBudget(options.maxChars, system.length);
	const sent =
		full.length <= contentBudget
			? sections.map((section) => section.text)
			: fitSections(sections, contentBudget);
	return {
		system,
		user: assembleContent(sent),
		sections: sections.map((section, index) => ({
			name: section.name,
			chars: section.text.length,
			sentChars: sent[index]?.length ?? 0,
		})),
	};
}

const CONTENT_HEADER = "Observed session context:";
const CUT_MARKER = "\n[...]\n";
/** A diff summary or recent-files list keeps at most this many characters when content is cut. */
const FILE_LIST_CAP = 400;

type ContentSectionName =
	| "request"
	| "transcript"
	| "diff_summary"
	| "recent_files"
	| "tool_events"
	| "summary_context"
	| "delegated_briefs";

interface ContentSection {
	name: ContentSectionName;
	/** The section as sent when content is within budget. */
	text: string;
	/** The section cut to at most `limit` characters with a cut marker, or "" to leave it out. */
	fit: (limit: number) => string;
}

/** The observed sections in the order they are sent; absent sections are left out. */
function observedContentSections(context: ObserverContext): ContentSection[] {
	// User and assistant text loses its private blocks, whatever path built the context.
	context = {
		...context,
		userPrompt: stripPrivate(context.userPrompt),
		project: context.project ? stripPrivate(context.project) : context.project,
		transcript: stripPrivate(context.transcript),
		diffSummary: stripPrivate(context.diffSummary),
		recentFiles: stripPrivate(context.recentFiles),
		lastAssistantMessage: stripPrivate(context.lastAssistantMessage ?? ""),
		toolEvents: context.toolEvents.map(visibleToolEvent),
	};
	const sections: ContentSection[] = [];
	if (context.userPrompt) sections.push(requestSection(context));
	if (context.transcript.trim()) {
		sections.push(
			wrappedSection(
				"transcript",
				"<conversation_transcript>\n",
				escapeXml(context.transcript),
				"\n</conversation_transcript>",
			),
		);
	}
	if (context.diffSummary) {
		sections.push(primarySessionSection("diff_summary", context.diffSummary));
	}
	if (context.recentFiles) {
		sections.push(primarySessionSection("recent_files", context.recentFiles));
	}
	if (context.toolEvents.length > 0) sections.push(toolEventsSection(context.toolEvents));
	if (context.includeSummary && context.lastAssistantMessage) {
		sections.push(
			wrappedSection(
				"summary_context",
				"Summary context:\n\n<summary_context>\n  <assistant_response>",
				escapeXml(context.lastAssistantMessage),
				"</assistant_response>\n</summary_context>",
			),
		);
	}
	const briefs = escapedDelegatedBriefsWithinBudget(
		boundedDelegatedBriefs(context.delegatedBriefs ?? []),
		MAX_DELEGATED_CONTEXT_CHARS - DELEGATED_BRIEF_LABEL.length - 5,
	);
	if (briefs) {
		sections.push(wrappedSection("delegated_briefs", `[${DELEGATED_BRIEF_LABEL}]\n`, briefs, ""));
	}
	return sections;
}

function assembleContent(sectionTexts: readonly string[]): string {
	return [CONTENT_HEADER, ...sectionTexts.filter(Boolean)].join("\n\n");
}

function requestSection(context: ObserverContext): ContentSection {
	const suffix = ["</user_request>"];
	if (context.promptNumber != null)
		suffix.push(`  <prompt_number>${context.promptNumber}</prompt_number>`);
	if (context.project) suffix.push(`  <project>${escapeXml(context.project)}</project>`);
	suffix.push("</observed_from_primary_session>");
	return wrappedSection(
		"request",
		"<observed_from_primary_session>\n  <user_request>",
		escapeXml(context.userPrompt),
		suffix.join("\n"),
	);
}

function primarySessionSection(
	name: "diff_summary" | "recent_files",
	text: string,
): ContentSection {
	return wrappedSection(
		name,
		`<observed_from_primary_session>\n  <${name}>`,
		escapeXml(text),
		`</${name}>\n</observed_from_primary_session>`,
	);
}

function wrappedSection(
	name: ContentSectionName,
	prefix: string,
	inner: string,
	suffix: string,
): ContentSection {
	return {
		name,
		text: `${prefix}${inner}${suffix}`,
		fit: (limit) => {
			const cut = cutWithMarker(inner, limit - prefix.length - suffix.length);
			return cut ? `${prefix}${cut}${suffix}` : "";
		},
	};
}

/** A kept tool event gets at least this many characters before a lower-priority event is left out. */
const MIN_TOOL_EVENT_CHARS = 300;

/**
 * Over budget, every tool event is first cut head-and-tail in proportion to its size.
 * When that would leave an event fewer than MIN_TOOL_EVENT_CHARS, events are left out
 * one at a time by the existing priority (errors, then edits and writes, shell
 * commands, reads, other tools; earlier first within a rank). Kept events stay in
 * their original order, with a marker where events were left out.
 */
function toolEventsSection(events: ToolEvent[]): ContentSection {
	return {
		name: "tool_events",
		text: events.map((event) => formatToolEvent(event)).join("\n\n"),
		fit: (limit) => {
			for (let count = events.length; count >= 1; count -= 1) {
				const kept =
					count === events.length
						? events
						: budgetToolEvents(events, Number.MAX_SAFE_INTEGER, count);
				const fitted = fitToolEvents(events, kept, limit);
				if (fitted !== null) return fitted;
			}
			return "";
		},
	};
}

/** The kept events within `limit`, or null when one would get too little room. */
function fitToolEvents(
	events: readonly ToolEvent[],
	kept: readonly ToolEvent[],
	limit: number,
): string | null {
	const marker = CUT_MARKER.trim();
	const keptSet = new Set(kept);
	// null marks where events were left out.
	const parts: Array<ToolEvent | null> = [];
	for (const event of events) {
		if (keptSet.has(event)) parts.push(event);
		else if (parts.at(-1) !== null) parts.push(null);
	}
	const sizes = parts.map((part) => (part ? formatToolEvent(part).length : 0));
	const markers = parts.filter((part) => part === null).length;
	const available = limit - 2 * (parts.length - 1) - markers * marker.length;
	const eventTotal = sizes.reduce((sum, size) => sum + size, 0);
	const blocks = parts.map((part, index) =>
		part ? fitToolEvent(part, Math.floor((available * (sizes[index] ?? 0)) / eventTotal)) : marker,
	);
	const tooShort = parts.some(
		(part, index) =>
			part !== null &&
			(blocks[index]?.length ?? 0) < Math.min(MIN_TOOL_EVENT_CHARS, sizes[index] ?? 0),
	);
	if (tooShort && kept.length > 1) return null;
	const joined = blocks.filter(Boolean).join("\n\n");
	return joined.length <= limit ? joined : cutWithMarker(joined, limit);
}

/** One tool event within `limit`, cutting its outcome first so its tool and parameters stay readable. */
function fitToolEvent(event: ToolEvent, limit: number): string {
	const full = formatToolEvent(event);
	if (full.length <= limit) return full;
	const outcome = escapeXml(formatJson(stripPrivateObj(event.toolOutput)));
	const cut = outcome ? cutWithMarker(outcome, limit - (full.length - outcome.length)) : "";
	return cut ? formatToolEvent(event, cut) : cutWithMarker(full, limit);
}

/**
 * Cut over-budget content by section instead of taking a prefix. The request stays
 * whole, unless it alone is over budget, in which case it is the only section sent.
 * The summary context keeps at most a quarter of the budget, each file list at most
 * FILE_LIST_CAP, and the transcript and tool events share the rest in proportion to
 * their size. Earlier delegated briefs are context only, so they get what is left,
 * as they did when they sat at the end of a prefix cut.
 */
function fitSections(sections: readonly ContentSection[], contentBudget: number): string[] {
	const separator = 2;
	let remaining = contentBudget - CONTENT_HEADER.length;
	const limits = new Map<ContentSection, number>();
	const allot = (section: ContentSection, cap: number) => {
		const limit = Math.max(0, Math.min(section.text.length, cap, remaining - separator));
		limits.set(section, limit);
		if (limit > 0) remaining -= limit + separator;
	};
	const named = (...names: ContentSectionName[]) =>
		sections.filter((section) => names.includes(section.name));
	const [request] = named("request");
	if (request && request.text.length + separator > remaining) {
		return sections.map((section) =>
			section === request ? request.fit(remaining - separator) : "",
		);
	}
	if (request) allot(request, request.text.length);
	for (const section of named("summary_context")) allot(section, Math.floor(contentBudget / 4));
	for (const section of named("diff_summary", "recent_files")) allot(section, FILE_LIST_CAP);
	// Smaller first, so a section that fits its share passes the rest to the larger one.
	const shared = named("transcript", "tool_events").sort((a, b) => a.text.length - b.text.length);
	let sharedTotal = shared.reduce((sum, section) => sum + section.text.length + separator, 0);
	for (const section of shared) {
		const size = section.text.length + separator;
		const share = Math.floor((Math.max(0, remaining) * size) / sharedTotal);
		sharedTotal -= size;
		allot(section, share - separator);
	}
	for (const section of named("delegated_briefs")) allot(section, section.text.length);
	return sections.map((section) => {
		const limit = limits.get(section) ?? 0;
		return section.text.length <= limit ? section.text : section.fit(limit);
	});
}

/** Head, middle and tail of `text` within `limit`, with cut markers; "" when nothing fits. */
function cutWithMarker(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit < CUT_MARKER.length + 2) return "";
	if (limit > 30) return truncateMiddle(text, limit);
	const keep = Math.floor((limit - CUT_MARKER.length) / 2);
	return `${text.slice(0, keep)}${CUT_MARKER}${text.slice(text.length - keep)}`;
}

/** Build the one-shot prompt used to repair malformed observer XML. */
export function buildObserverRepairPrompt(
	system: string,
	user: string,
	previousRaw: string,
	maxChars = DEFAULT_OBSERVER_MAX_CHARS,
): { system: string; user: string } {
	const repairDirective =
		"Your previous reply was invalid because it did not follow the required XML-only schema. " +
		"Rewrite it as valid XML only, using only wording supported verbatim by your previous reply. " +
		'Do not add, infer, or rephrase details. If the reply was only a short acknowledgement or another low-signal response, emit only <skip_summary reason="low-signal"/>. ' +
		"Otherwise emit a <summary> whose fields use phrases from the previous reply, optionally plus one <observation>. " +
		"For that observation, copy the entire previous reply into <narrative>; use single-clause phrases from it for <title>, <subtitle>, and <fact>; preserve negation words; " +
		"use only the fixed concept taxonomy and file paths that literally appear in the previous reply. Do not include prose outside XML.";
	const repairSystem = `${repairDirective}\n\n${system}`;
	// The observer sends these instructions whole, so the content gets what they leave.
	const userBudget = observerContentBudget(maxChars, repairSystem.length);
	const previousPrefix = "Previous invalid response to rewrite as valid XML:\n";
	const contextPrefix = "\n\nOriginal session context:\n";
	const contentBudget = Math.max(0, userBudget - previousPrefix.length - contextPrefix.length);
	const previousBudget = Math.floor(contentBudget * 0.7);
	const contextBudget = contentBudget - previousBudget;
	// The previous response can quote private text from the prompt; remove it before cutting.
	const previousResponse = truncateMiddle(stripPrivate(previousRaw).trim(), previousBudget);
	const originalContext = truncateMiddle(user.trim(), contextBudget);
	return {
		system: repairSystem,
		user: `${previousPrefix}${previousResponse}${contextPrefix}${originalContext}`,
	};
}

export function truncateObserverTranscript(transcript: string, maxChars: number): string {
	const trimmed = transcript.trim();
	if (!trimmed) return "";
	return truncateMiddle(trimmed, maxChars);
}
