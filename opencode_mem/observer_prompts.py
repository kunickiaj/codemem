from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from xml.sax.saxutils import escape

OBSERVATION_TYPES = "bugfix, feature, refactor, change, discovery, decision"
OBSERVATION_CONCEPTS = (
    "how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off"
)

SYSTEM_IDENTITY = (
    "You are a memory observer creating searchable records of development work "
    "FOR FUTURE SESSIONS. Record what was BUILT/FIXED/DEPLOYED/CONFIGURED/LEARNED, "
    "not what you (the observer) are doing. These memories help developers "
    "recall past work, decisions, learnings, and investigations."
)

RECORDING_FOCUS = """\
Focus on deliverables, capabilities, AND learnings:
- What the system NOW DOES differently (new capabilities)
- What shipped to users/production (features, fixes, configs, docs)
- What was LEARNED through debugging, investigation, or testing
- How systems work and why they behave the way they do
- Changes in technical domains (auth, data, UI, infra, DevOps)

Use outcome-focused verbs: implemented, fixed, deployed, configured, migrated, optimized, added, refactored, discovered, learned, debugged

GOOD examples (describes what was built or learned):
- "Authentication now supports OAuth2 with PKCE flow"
- "Deployment pipeline runs canary releases with auto-rollback"
- "Fixed race condition in session handler causing duplicate events"
- "Discovered flush timing strategy needed adaptation for multi-session environment"
- "Learned transcript building was broken - empty strings passed instead of conversation"

BAD examples (describes observation process - DO NOT DO THIS):
- "Analyzed authentication implementation and stored findings in database"
- "Tracked deployment steps and logged outcomes to memory system"
- "Recorded investigation results for later reference\""""

SKIP_GUIDANCE = """\
Skip routine operations WITHOUT learnings:
- Empty status checks or listings (unless revealing important state)
- Package installations with no errors or insights
- Simple file reads with no discoveries
- Repetitive operations already documented with no new findings
If nothing meaningful happened AND nothing was learned, output nothing."""

NARRATIVE_GUIDANCE = """\
Create COMPREHENSIVE narratives that tell the complete story:
- Context: What was the problem or goal? What prompted this work?
- Investigation: What was examined? What was discovered?
- Learning: How does it work? Why does it exist? Any gotchas?
- Implementation: What was changed? What does the code do now?
- Impact: What's better? What does the system do differently?
- Next steps: What remains? What should future sessions know?

Aim for 200-800 words per significant work item.
Combine related work into cohesive narratives instead of many small observations.
Include specific details: file paths, function names, configuration values."""

OUTPUT_GUIDANCE = (
    "Output only XML. Emit one or more <observation> blocks and optionally a "
    "<summary> block. Do not include commentary outside XML. "
    "Prefer fewer, more comprehensive observations over many small ones."
)

OBSERVATION_SCHEMA = f"""
<observation>
  <type>[ {OBSERVATION_TYPES} ]</type>
  <!--
    type MUST be EXACTLY one of these 6 options:
      - bugfix: something was broken, now fixed
      - feature: new capability or functionality added
      - refactor: code restructured, behavior unchanged
      - change: generic modification (docs, config, misc)
      - discovery: learning about existing system, debugging insights
      - decision: architectural/design choice with rationale
  -->

  <title>[Short outcome-focused title - what was achieved or learned]</title>
  <!-- GOOD: "OAuth2 PKCE flow added to authentication" -->
  <!-- GOOD: "Discovered flush strategy fails in multi-session environments" -->
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
    Include specific details: file paths, function names, configuration values.
    Aim for 100-500 words - enough to be useful, not overwhelming.
  ]</narrative>

  <concepts>
    <concept>[{OBSERVATION_CONCEPTS}]</concept>
  </concepts>
  <!-- concepts: 2-5 knowledge categories from the list above -->

  <files_read>
    <file>[full path from project root]</file>
  </files_read>
  <files_modified>
    <file>[full path from project root]</file>
  </files_modified>
</observation>
""".strip()

SUMMARY_SCHEMA = """
<summary>
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

IMPORTANT: Always write at least a minimal summary explaining the current state,
even if you didn't learn anything new or complete any work. This helps track progress
across sessions. The summary is for tracking the PRIMARY session work, not your observation process.

Write comprehensive summaries (200-600 words total across all fields).
This summary helps future sessions understand where this work left off.
""".strip()


@dataclass
class ToolEvent:
    tool_name: str
    tool_input: Any
    tool_output: Any
    tool_error: Any
    timestamp: str | None = None
    cwd: str | None = None


@dataclass
class ObserverContext:
    project: str | None
    user_prompt: str | None
    prompt_number: int | None
    tool_events: list[ToolEvent]
    last_assistant_message: str | None
    include_summary: bool
    diff_summary: str | None = None
    recent_files: str | None = None


def _format_json(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return str(value)


def _format_tool_event(event: ToolEvent) -> str:
    parts = ["<observed_from_primary_session>"]
    parts.append(f"  <what_happened>{escape(event.tool_name)}</what_happened>")
    if event.timestamp:
        parts.append(f"  <occurred_at>{escape(event.timestamp)}</occurred_at>")
    if event.cwd:
        parts.append(f"  <working_directory>{escape(event.cwd)}</working_directory>")
    params = escape(_format_json(event.tool_input))
    outcome = escape(_format_json(event.tool_output))
    error = escape(_format_json(event.tool_error))
    if params:
        parts.append(f"  <parameters>{params}</parameters>")
    if outcome:
        parts.append(f"  <outcome>{outcome}</outcome>")
    if error:
        parts.append(f"  <error>{error}</error>")
    parts.append("</observed_from_primary_session>")
    return "\n".join(parts)


def build_observer_prompt(context: ObserverContext) -> str:
    blocks: list[str] = [
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
    ]
    if context.include_summary:
        blocks.extend(["", "Summary XML schema:", SUMMARY_SCHEMA])
    blocks.append("")
    blocks.append("Observed session context:")
    if context.user_prompt:
        prompt_block = ["<observed_from_primary_session>"]
        prompt_block.append(f"  <user_request>{escape(context.user_prompt)}</user_request>")
        if context.prompt_number is not None:
            prompt_block.append(f"  <prompt_number>{context.prompt_number}</prompt_number>")
        if context.project:
            prompt_block.append(f"  <project>{escape(context.project)}</project>")
        prompt_block.append("</observed_from_primary_session>")
        blocks.append("\n".join(prompt_block))
    if context.diff_summary:
        blocks.append(
            f"<observed_from_primary_session>\n  <diff_summary>{escape(context.diff_summary)}</diff_summary>\n</observed_from_primary_session>"
        )
    if context.recent_files:
        blocks.append(
            f"<observed_from_primary_session>\n  <recent_files>{escape(context.recent_files)}</recent_files>\n</observed_from_primary_session>"
        )
    for event in context.tool_events:
        blocks.append(_format_tool_event(event))
    if context.include_summary and context.last_assistant_message:
        blocks.append("Summary context:")
        blocks.append(
            "<summary_context>\n  <assistant_response>"
            + escape(context.last_assistant_message)
            + "</assistant_response>\n</summary_context>"
        )
    return "\n\n".join(blocks).strip()
