from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional
from xml.sax.saxutils import escape


OBSERVATION_TYPES = "bugfix, feature, refactor, change, discovery, decision"
OBSERVATION_CONCEPTS = (
    "how-it-works, why-it-exists, what-changed, problem-solution, gotcha, "
    "pattern, trade-off"
)

SYSTEM_IDENTITY = (
    "You are a memory observer for a live coding session. "
    "Record what was built, fixed, configured, or learned. "
    "Do not describe the observation process."
)

RECORDING_FOCUS = (
    "Focus on concrete deliverables and outcomes: features shipped, bugs fixed, "
    "docs updated, configs changed, or insights learned."
)

SKIP_GUIDANCE = (
    "Skip routine or low-value operations like empty listings, repeated checks, "
    "or raw tool dumps. If nothing meaningful happened, output nothing."
)

OUTPUT_GUIDANCE = (
    "Output only XML. Emit one or more <observation> blocks and optionally a "
    "<summary> block. Do not include commentary outside XML."
)

OBSERVATION_SCHEMA = f"""
<observation>
  <type>[ {OBSERVATION_TYPES} ]</type>
  <title>[short outcome-focused title]</title>
  <subtitle>[one-sentence explanation]</subtitle>
  <facts>
    <fact>[concise factual statement]</fact>
  </facts>
  <narrative>[what changed, how it works, why it matters]</narrative>
  <concepts>
    <concept>[{OBSERVATION_CONCEPTS}]</concept>
  </concepts>
  <files_read>
    <file>[path]</file>
  </files_read>
  <files_modified>
    <file>[path]</file>
  </files_modified>
</observation>
""".strip()

SUMMARY_SCHEMA = """
<summary>
  <request>[user request summary]</request>
  <investigated>[what was examined]</investigated>
  <learned>[key learnings]</learned>
  <completed>[what was completed]</completed>
  <next_steps>[current trajectory]</next_steps>
  <notes>[extra context]</notes>
  <files_read>
    <file>[path]</file>
  </files_read>
  <files_modified>
    <file>[path]</file>
  </files_modified>
</summary>
""".strip()


@dataclass
class ToolEvent:
    tool_name: str
    tool_input: Any
    tool_output: Any
    tool_error: Any
    timestamp: Optional[str] = None
    cwd: Optional[str] = None


@dataclass
class ObserverContext:
    project: Optional[str]
    user_prompt: Optional[str]
    prompt_number: Optional[int]
    tool_events: list[ToolEvent]
    last_assistant_message: Optional[str]
    include_summary: bool
    diff_summary: Optional[str] = None
    recent_files: Optional[str] = None


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
        RECORDING_FOCUS,
        SKIP_GUIDANCE,
        OUTPUT_GUIDANCE,
        "Observation XML schema:",
        OBSERVATION_SCHEMA,
    ]
    if context.include_summary:
        blocks.extend(["Summary XML schema:", SUMMARY_SCHEMA])
    blocks.append("Observed session context:")
    if context.user_prompt:
        prompt_block = ["<observed_from_primary_session>"]
        prompt_block.append(
            f"  <user_request>{escape(context.user_prompt)}</user_request>"
        )
        if context.prompt_number is not None:
            prompt_block.append(
                f"  <prompt_number>{context.prompt_number}</prompt_number>"
            )
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
