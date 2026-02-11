from codemem.xml_parser import has_meaningful_observation, parse_observer_output


def test_parse_observer_output_with_summary():
    payload = """
<observation>
  <type>feature</type>
  <title>Added observer pipeline</title>
  <subtitle>Stores XML memories only</subtitle>
  <facts>
    <fact>Observer prompt outputs XML</fact>
  </facts>
  <narrative>Implemented an observer-only pipeline for memories.</narrative>
  <concepts>
    <concept>what-changed</concept>
  </concepts>
  <files_read>
    <file>codemem/plugin_ingest.py</file>
  </files_read>
  <files_modified>
    <file>codemem/observer.py</file>
  </files_modified>
</observation>
<summary>
  <request>Improve memory quality</request>
  <investigated>claude-mem pipeline</investigated>
  <learned>XML-only observer output</learned>
  <completed>Observer prompt added</completed>
  <next_steps>Replace classifier path</next_steps>
  <notes>Strict parsing enabled</notes>
</summary>
"""
    parsed = parse_observer_output(payload)
    assert len(parsed.observations) == 1
    obs = parsed.observations[0]
    assert obs.kind == "feature"
    assert obs.title == "Added observer pipeline"
    assert obs.narrative == "Implemented an observer-only pipeline for memories."
    assert obs.facts == ["Observer prompt outputs XML"]
    assert obs.concepts == ["what-changed"]
    assert obs.files_read == ["codemem/plugin_ingest.py"]
    assert obs.files_modified == ["codemem/observer.py"]
    assert parsed.summary is not None
    assert parsed.summary.request == "Improve memory quality"
    assert parsed.summary.completed == "Observer prompt added"


def test_parse_skip_summary():
    payload = '<skip_summary reason="low-signal"/>'
    parsed = parse_observer_output(payload)
    assert parsed.summary is None
    assert parsed.skip_summary_reason == "low-signal"


def test_has_meaningful_observation():
    parsed = parse_observer_output("<observation><type>change</type></observation>")
    assert not has_meaningful_observation(parsed.observations)
