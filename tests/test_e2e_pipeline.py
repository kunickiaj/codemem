"""
End-to-end tests for the memory pipeline.

These tests verify the full flow from plugin events to stored memories,
ensuring we catch regressions in:
- Transcript building
- Observer prompt generation
- XML parsing
- Low-signal filtering
- Memory storage
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

from opencode_mem.plugin_ingest import ingest
from opencode_mem.store import MemoryStore
from opencode_mem.xml_parser import parse_observer_output


class TestTranscriptBuilding:
    """Test that transcripts are built correctly from events."""

    def test_transcript_includes_user_prompts(self, tmp_path: Path) -> None:
        """User prompts should appear in transcript."""
        from opencode_mem.plugin_ingest import _build_transcript

        events = [
            {"type": "user_prompt", "prompt_text": "Fix the bug", "prompt_number": 1},
        ]
        transcript = _build_transcript(events)
        assert "User: Fix the bug" in transcript

    def test_transcript_includes_assistant_messages(self, tmp_path: Path) -> None:
        """Assistant messages should appear in transcript."""
        from opencode_mem.plugin_ingest import _build_transcript

        events = [
            {"type": "assistant_message", "assistant_text": "I'll fix that now"},
        ]
        transcript = _build_transcript(events)
        assert "Assistant: I'll fix that now" in transcript

    def test_transcript_preserves_order(self, tmp_path: Path) -> None:
        """Conversation should be in chronological order."""
        from opencode_mem.plugin_ingest import _build_transcript

        events = [
            {"type": "user_prompt", "prompt_text": "First question", "prompt_number": 1},
            {"type": "assistant_message", "assistant_text": "First answer"},
            {"type": "user_prompt", "prompt_text": "Second question", "prompt_number": 2},
            {"type": "assistant_message", "assistant_text": "Second answer"},
        ]
        transcript = _build_transcript(events)

        # Check order
        first_q_pos = transcript.index("First question")
        first_a_pos = transcript.index("First answer")
        second_q_pos = transcript.index("Second question")
        second_a_pos = transcript.index("Second answer")

        assert first_q_pos < first_a_pos < second_q_pos < second_a_pos

    def test_transcript_ignores_tool_events(self, tmp_path: Path) -> None:
        """Tool events should not appear in transcript."""
        from opencode_mem.plugin_ingest import _build_transcript

        events = [
            {"type": "user_prompt", "prompt_text": "Run tests", "prompt_number": 1},
            {"type": "tool.execute.after", "tool": "bash", "result": "All tests pass"},
            {"type": "assistant_message", "assistant_text": "Tests passed!"},
        ]
        transcript = _build_transcript(events)

        assert "User: Run tests" in transcript
        assert "Assistant: Tests passed!" in transcript
        assert "All tests pass" not in transcript


class TestXMLParsing:
    """Test that observer output is correctly parsed."""

    def test_parse_observation_with_markdown_fences(self) -> None:
        """Parser should handle markdown code fences."""
        raw = """```xml
<observation>
  <type>discovery</type>
  <title>Found root cause of bug</title>
  <subtitle>Memory leak in event handler</subtitle>
  <facts><fact>Handler not cleaned up</fact></facts>
  <narrative>Investigated and found the issue.</narrative>
  <concepts><concept>problem-solution</concept></concepts>
</observation>
```"""
        parsed = parse_observer_output(raw)
        assert len(parsed.observations) == 1
        assert parsed.observations[0].kind == "discovery"
        assert parsed.observations[0].title == "Found root cause of bug"

    def test_parse_summary_with_markdown_fences(self) -> None:
        """Parser should handle summary in markdown fences."""
        raw = """```xml
<summary>
  <request>Debug the memory issue</request>
  <investigated>Checked logs and traces</investigated>
  <learned>Handler cleanup was missing</learned>
  <completed>Fixed the leak</completed>
  <next_steps>Add tests</next_steps>
  <notes>Important fix</notes>
</summary>
```"""
        parsed = parse_observer_output(raw)
        assert parsed.summary is not None
        assert parsed.summary.request == "Debug the memory issue"
        assert parsed.summary.learned == "Handler cleanup was missing"

    def test_parse_with_xml_declaration(self) -> None:
        """Parser should handle XML declaration."""
        raw = """```xml
<?xml version="1.0" encoding="UTF-8"?>
<summary>
  <request>Test request</request>
  <investigated></investigated>
  <learned>Test learning</learned>
  <completed></completed>
  <next_steps></next_steps>
  <notes></notes>
</summary>
```"""
        parsed = parse_observer_output(raw)
        assert parsed.summary is not None
        assert parsed.summary.request == "Test request"

    def test_parse_multiple_observations(self) -> None:
        """Parser should handle multiple observations."""
        raw = """
<observation>
  <type>bugfix</type>
  <title>Fixed crash</title>
  <narrative>Fixed null pointer</narrative>
</observation>
<observation>
  <type>feature</type>
  <title>Added logging</title>
  <narrative>Added debug logs</narrative>
</observation>
"""
        parsed = parse_observer_output(raw)
        assert len(parsed.observations) == 2
        assert parsed.observations[0].kind == "bugfix"
        assert parsed.observations[1].kind == "feature"


class TestObserverIntegration:
    """Test observer prompt generation and response handling."""

    def test_observer_prompt_includes_transcript(self) -> None:
        """Observer prompt should include the conversation transcript."""
        from opencode_mem.observer_prompts import ObserverContext, ToolEvent, build_observer_prompt

        context = ObserverContext(
            project="/test/project",
            user_prompt="Fix the memory leak",
            prompt_number=1,
            tool_events=[
                ToolEvent(
                    tool_name="bash",
                    tool_input={"command": "git status"},
                    tool_output="modified: src/handler.py",
                    tool_error=None,
                )
            ],
            last_assistant_message="I found the issue in handler.py",
            include_summary=True,
        )
        prompt = build_observer_prompt(context)

        assert "Fix the memory leak" in prompt
        assert "handler.py" in prompt

    def test_observer_types_are_documented(self) -> None:
        """Observer prompt should document all valid observation types."""
        from opencode_mem.observer_prompts import OBSERVATION_SCHEMA

        for obs_type in [
            "bugfix",
            "feature",
            "refactor",
            "change",
            "discovery",
            "decision",
            "exploration",
        ]:
            assert obs_type in OBSERVATION_SCHEMA


class TestFullPipeline:
    """Test the complete ingest pipeline."""

    def test_ingest_creates_session(self, tmp_path: Path) -> None:
        """Ingest should create a session even if observer returns nothing."""
        db_path = tmp_path / "test.sqlite"

        payload = {
            "cwd": str(tmp_path),
            "project": "test-project",
            "started_at": "2026-01-15T10:00:00Z",
            "events": [
                {"type": "user_prompt", "prompt_text": "Hello", "prompt_number": 1},
            ],
        }

        mock_response = MagicMock()
        mock_response.raw = ""
        mock_response.parsed.observations = []
        mock_response.parsed.summary = None
        mock_response.parsed.skip_summary_reason = None

        with (
            patch.dict("os.environ", {"OPENCODE_MEM_DB": str(db_path)}),
            patch("opencode_mem.plugin_ingest.OBSERVER") as mock_observer,
            patch("opencode_mem.plugin_ingest.capture_pre_context") as mock_pre,
            patch("opencode_mem.plugin_ingest.capture_post_context") as mock_post,
        ):
            mock_observer.observe.return_value = mock_response
            mock_pre.return_value = {"project": "test-project"}
            mock_post.return_value = {"git_diff": "", "recent_files": ""}

            ingest(payload)

        # Session should exist
        store = MemoryStore(db_path)
        sessions = store.all_sessions()
        assert len(sessions) == 1
        store.close()

    def test_ingest_stores_summary_when_observer_returns_one(self, tmp_path: Path) -> None:
        """Ingest should store summary when observer returns valid XML."""
        db_path = tmp_path / "test.sqlite"

        payload = {
            "cwd": str(tmp_path),
            "project": "test-project",
            "started_at": "2026-01-15T10:00:00Z",
            "events": [
                {"type": "user_prompt", "prompt_text": "Debug the issue", "prompt_number": 1},
                {"type": "assistant_message", "assistant_text": "I found the problem"},
            ],
        }

        # Simulate observer returning valid XML
        mock_response = MagicMock()
        mock_response.raw = """
<summary>
  <request>Debug the issue</request>
  <investigated>Checked logs</investigated>
  <learned>Found root cause</learned>
  <completed>Fixed the bug</completed>
  <next_steps>Add tests</next_steps>
  <notes>Important discovery</notes>
</summary>
"""
        mock_response.parsed = parse_observer_output(mock_response.raw)

        with (
            patch.dict("os.environ", {"OPENCODE_MEM_DB": str(db_path)}),
            patch("opencode_mem.plugin_ingest.OBSERVER") as mock_observer,
            patch("opencode_mem.plugin_ingest.capture_pre_context") as mock_pre,
            patch("opencode_mem.plugin_ingest.capture_post_context") as mock_post,
        ):
            mock_observer.observe.return_value = mock_response
            mock_pre.return_value = {"project": "test-project"}
            mock_post.return_value = {"git_diff": "", "recent_files": ""}

            ingest(payload)

        # Memory should exist
        store = MemoryStore(db_path)
        memories = store.recent(limit=10)
        assert len(memories) >= 1

        # Should have session_summary type
        summary_memories = [m for m in memories if m["kind"] == "session_summary"]
        assert len(summary_memories) == 1
        store.close()

    def test_ingest_stores_discovery_observation(self, tmp_path: Path) -> None:
        """Ingest should store discovery-type observations (debugging sessions)."""
        db_path = tmp_path / "test.sqlite"

        payload = {
            "cwd": str(tmp_path),
            "project": "test-project",
            "started_at": "2026-01-15T10:00:00Z",
            "events": [
                {"type": "user_prompt", "prompt_text": "Why is this failing?", "prompt_number": 1},
            ],
        }

        mock_response = MagicMock()
        mock_response.raw = """
<observation>
  <type>discovery</type>
  <title>Found flush strategy issue in multi-session environments</title>
  <subtitle>OpenCode handles sessions differently than Claude Code</subtitle>
  <facts>
    <fact>OpenCode allows multiple concurrent sessions</fact>
    <fact>/new command does not close old sessions</fact>
  </facts>
  <narrative>Discovered that the flush strategy was designed for single-session environments. In OpenCode, sessions can coexist, so session.created events don't fire on /new.</narrative>
  <concepts>
    <concept>how-it-works</concept>
    <concept>gotcha</concept>
  </concepts>
</observation>
"""
        mock_response.parsed = parse_observer_output(mock_response.raw)

        with (
            patch.dict("os.environ", {"OPENCODE_MEM_DB": str(db_path)}),
            patch("opencode_mem.plugin_ingest.OBSERVER") as mock_observer,
            patch("opencode_mem.plugin_ingest.capture_pre_context") as mock_pre,
            patch("opencode_mem.plugin_ingest.capture_post_context") as mock_post,
        ):
            mock_observer.observe.return_value = mock_response
            mock_pre.return_value = {"project": "test-project"}
            mock_post.return_value = {"git_diff": "", "recent_files": ""}

            ingest(payload)

        store = MemoryStore(db_path)
        memories = store.recent(limit=10)

        # Should have discovery observation
        discovery_memories = [m for m in memories if m["kind"] == "discovery"]
        assert len(discovery_memories) == 1
        assert "flush strategy" in discovery_memories[0]["title"].lower()
        store.close()

    def test_ingest_builds_transcript_from_events(self, tmp_path: Path) -> None:
        """Ingest should build transcript and store it as artifact."""
        db_path = tmp_path / "test.sqlite"

        payload = {
            "cwd": str(tmp_path),
            "project": "test-project",
            "started_at": "2026-01-15T10:00:00Z",
            "events": [
                {"type": "user_prompt", "prompt_text": "What is 2+2?", "prompt_number": 1},
                {"type": "assistant_message", "assistant_text": "The answer is 4."},
            ],
        }

        mock_response = MagicMock()
        mock_response.raw = ""
        mock_response.parsed.observations = []
        mock_response.parsed.summary = None
        mock_response.parsed.skip_summary_reason = None

        with (
            patch.dict("os.environ", {"OPENCODE_MEM_DB": str(db_path)}),
            patch("opencode_mem.plugin_ingest.OBSERVER") as mock_observer,
            patch("opencode_mem.plugin_ingest.capture_pre_context") as mock_pre,
            patch("opencode_mem.plugin_ingest.capture_post_context") as mock_post,
        ):
            mock_observer.observe.return_value = mock_response
            mock_pre.return_value = {"project": "test-project"}
            mock_post.return_value = {"git_diff": "", "recent_files": ""}

            ingest(payload)

        # Check transcript artifact
        store = MemoryStore(db_path)
        sessions = store.all_sessions()
        session_id = sessions[0]["id"]

        artifacts = store.conn.execute(
            "SELECT kind, content_text FROM artifacts WHERE session_id = ?",
            (session_id,),
        ).fetchall()

        transcript_artifacts = [a for a in artifacts if a["kind"] == "transcript"]
        assert len(transcript_artifacts) == 1

        transcript = transcript_artifacts[0]["content_text"]
        assert "User: What is 2+2?" in transcript
        assert "Assistant: The answer is 4." in transcript
        store.close()


class TestLowSignalFiltering:
    """Test that low-signal filtering infrastructure works."""

    def test_patterns_are_scoped(self) -> None:
        """Observation patterns are targeted; transcript patterns remain empty."""
        from opencode_mem.summarizer import (
            LOW_SIGNAL_OBSERVATION_PATTERNS,
            LOW_SIGNAL_PATTERNS,
        )

        assert len(LOW_SIGNAL_PATTERNS) == 0
        assert len(LOW_SIGNAL_OBSERVATION_PATTERNS) > 0

    def test_low_signal_observations_match_patterns(self) -> None:
        from opencode_mem.summarizer import is_low_signal_observation

        low_signal_samples = [
            "No code changes were recorded.",
            "No code was modified.",
            "No new code or configuration was shipped.",
            "No new deliverables.",
            "No definitive code rewrite or feature delivery occurred.",
            "Only file inspection occurred.",
            "Only produced an understanding of the current layout.",
            "The session consisted entirely of capturing system details.",
            "No fully resolved deliverable was reached.",
            "Effort focused on clarifying requirements.",
            "No code, configuration, or documentation changes were made.",
            "The work consisted entirely of capturing the current state.",
            "Primary user request details were absent.",
        ]

        for sample in low_signal_samples:
            assert is_low_signal_observation(sample)

    def test_legitimate_content_not_filtered(self) -> None:
        from opencode_mem.summarizer import is_low_signal_observation

        valid_samples = [
            "No changes were needed in parser logic; added a CLI flag and tests.",
            "No change in behavior, but shipped config defaults for staging.",
            "Audited repo: no changes required in foo, yet updated README and released patch.",
            "Investigated file inspection flow and added a new inspector helper.",
            "Clarifying assumptions for the API, then implemented token refresh flow.",
        ]

        for sample in valid_samples:
            assert not is_low_signal_observation(sample)

    def test_valuable_content_not_filtered(self) -> None:
        """With empty patterns, nothing should be filtered."""
        from opencode_mem.summarizer import is_low_signal_observation

        # These should all pass through now
        assert not is_low_signal_observation(
            "Found flush strategy issue in multi-session environments"
        )
        assert not is_low_signal_observation(
            "Discovered observer prompts were biased against debugging"
        )
        assert not is_low_signal_observation(
            "Fixed transcript building bug - was passing empty string"
        )
        assert not is_low_signal_observation("In OpenCode, sessions can coexist")
        # Even things that might seem routine - let the observer decide
        assert not is_low_signal_observation("ls -la")
        assert not is_low_signal_observation("pwd")

    def test_empty_string_is_low_signal(self) -> None:
        """Empty/whitespace-only content should still be filtered."""
        from opencode_mem.summarizer import is_low_signal_observation

        assert is_low_signal_observation("")
        assert is_low_signal_observation("   ")
        assert is_low_signal_observation("\n\t")


class TestRegressionPrevention:
    """Tests that catch specific bugs we've encountered."""

    def test_transcript_not_empty_string(self, tmp_path: Path) -> None:
        """Regression: transcript was being passed as empty string."""
        from opencode_mem.plugin_ingest import _build_transcript

        events = [
            {"type": "user_prompt", "prompt_text": "Test prompt"},
            {"type": "assistant_message", "assistant_text": "Test response"},
        ]
        transcript = _build_transcript(events)

        # Must NOT be empty
        assert transcript != ""
        assert len(transcript) > 0

    def test_markdown_fences_stripped_from_observer_output(self) -> None:
        """Regression: markdown fences were preventing XML parsing."""
        raw = "```xml\n<summary><request>Test</request></summary>\n```"
        parsed = parse_observer_output(raw)

        assert parsed.summary is not None
        assert parsed.summary.request == "Test"

    def test_discovery_type_accepted(self, tmp_path: Path) -> None:
        """Regression: discovery observations were being filtered."""
        from opencode_mem.plugin_ingest import ingest

        db_path = tmp_path / "test.sqlite"

        payload = {
            "cwd": str(tmp_path),
            "project": "test-project",
            "events": [{"type": "user_prompt", "prompt_text": "Debug", "prompt_number": 1}],
        }

        mock_response = MagicMock()
        mock_response.raw = """
<observation>
  <type>discovery</type>
  <title>Learned how the system works</title>
  <narrative>Investigated the codebase and discovered the architecture.</narrative>
</observation>
"""
        mock_response.parsed = parse_observer_output(mock_response.raw)

        with (
            patch.dict("os.environ", {"OPENCODE_MEM_DB": str(db_path)}),
            patch("opencode_mem.plugin_ingest.OBSERVER") as mock_observer,
            patch("opencode_mem.plugin_ingest.capture_pre_context") as mock_pre,
            patch("opencode_mem.plugin_ingest.capture_post_context") as mock_post,
        ):
            mock_observer.observe.return_value = mock_response
            mock_pre.return_value = {}
            mock_post.return_value = {}

            ingest(payload)

        store = MemoryStore(db_path)
        memories = store.recent(limit=10)
        discovery_memories = [m for m in memories if m["kind"] == "discovery"]

        # Discovery MUST be stored, not filtered
        assert len(discovery_memories) == 1
        store.close()
