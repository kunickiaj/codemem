from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from codemem.release_version import read_versions, set_version, versions_are_aligned


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _make_repo(tmp_path: Path, version: str = "0.16.0") -> Path:
    root = tmp_path / "repo"
    _write(
        root / "pyproject.toml",
        """
[project]
name = "codemem"
version = "0.16.0"
""".replace("0.16.0", version).lstrip(),
    )
    _write(root / "codemem" / "__init__.py", f'__version__ = "{version}"\n')
    _write(root / "package.json", f'{{\n  "version": "{version}"\n}}\n')
    _write(
        root / ".opencode" / "plugin" / "codemem.js",
        f'const PINNED_BACKEND_VERSION = "{version}";\n',
    )
    _write(
        root / "plugins" / "claude" / ".claude-plugin" / "plugin.json",
        """
{
  "version": "VERSION",
  "mcpServers": {
    "codemem": {
      "args": ["codemem==VERSION", "mcp"]
    }
  }
}
""".replace("VERSION", version).lstrip(),
    )
    _write(
        root / ".claude-plugin" / "marketplace.json",
        """
{
  "metadata": {
    "version": "VERSION"
  },
  "plugins": [
    {
      "name": "codemem",
      "version": "VERSION"
    }
  ]
}
""".replace("VERSION", version).lstrip(),
    )
    return root


def test_versions_are_aligned_for_matching_files(tmp_path: Path):
    root = _make_repo(tmp_path, version="1.2.3")

    snapshot = read_versions(root)
    aligned, details = versions_are_aligned(snapshot)

    assert aligned is True
    assert details == []


def test_versions_are_not_aligned_when_drift_exists(tmp_path: Path):
    root = _make_repo(tmp_path, version="1.2.3")
    package_json = root / "package.json"
    package_json.write_text('{\n  "version": "9.9.9"\n}\n', encoding="utf-8")

    snapshot = read_versions(root)
    aligned, details = versions_are_aligned(snapshot)

    assert aligned is False
    assert any("package_json" in line for line in details)


def test_set_version_updates_all_managed_locations(tmp_path: Path):
    root = _make_repo(tmp_path, version="1.0.0")

    changed = set_version(root, "1.0.1")
    snapshot = read_versions(root)

    assert sorted(changed) == [
        ".claude-plugin/marketplace.json",
        ".opencode/plugin/codemem.js",
        "codemem/__init__.py",
        "package.json",
        "plugins/claude/.claude-plugin/plugin.json",
        "pyproject.toml",
    ]
    assert set(snapshot.to_dict().values()) == {"1.0.1"}


def test_set_version_rejects_invalid_semver(tmp_path: Path):
    root = _make_repo(tmp_path, version="1.0.0")

    with pytest.raises(ValueError, match="Expected format: X.Y.Z"):
        set_version(root, "v1.0.1")


def test_set_version_dry_run_reports_changes_without_writing(tmp_path: Path):
    root = _make_repo(tmp_path, version="1.0.0")

    changed = set_version(root, "1.0.1", dry_run=True)
    snapshot = read_versions(root)

    assert sorted(changed) == [
        ".claude-plugin/marketplace.json",
        ".opencode/plugin/codemem.js",
        "codemem/__init__.py",
        "package.json",
        "plugins/claude/.claude-plugin/plugin.json",
        "pyproject.toml",
    ]
    assert set(snapshot.to_dict().values()) == {"1.0.0"}


def test_set_version_is_atomic_when_validation_fails(tmp_path: Path):
    root = _make_repo(tmp_path, version="1.0.0")
    plugin_path = root / "plugins" / "claude" / ".claude-plugin" / "plugin.json"
    plugin_data = json.loads(plugin_path.read_text(encoding="utf-8"))
    plugin_data["mcpServers"]["codemem"]["args"] = ["mcp"]
    plugin_path.write_text(json.dumps(plugin_data, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="exactly one codemem==X.Y.Z arg"):
        set_version(root, "1.0.1")

    assert 'version = "1.0.0"' in (root / "pyproject.toml").read_text(encoding="utf-8")
    assert '__version__ = "1.0.0"' in (root / "codemem" / "__init__.py").read_text(encoding="utf-8")
    assert '"version": "1.0.0"' in (root / "package.json").read_text(encoding="utf-8")
    assert 'PINNED_BACKEND_VERSION = "1.0.0"' in (
        root / ".opencode" / "plugin" / "codemem.js"
    ).read_text(encoding="utf-8")


def test_read_versions_rejects_non_object_json(tmp_path: Path):
    root = _make_repo(tmp_path, version="1.0.0")
    plugin_path = root / "plugins" / "claude" / ".claude-plugin" / "plugin.json"
    plugin_path.write_text("[]\n", encoding="utf-8")

    with pytest.raises(ValueError, match="plugin.json must be an object"):
        read_versions(root)


def test_release_version_cli_reports_clean_errors_without_traceback(tmp_path: Path):
    root = _make_repo(tmp_path, version="1.0.0")
    plugin_path = root / "plugins" / "claude" / ".claude-plugin" / "plugin.json"
    plugin_data = json.loads(plugin_path.read_text(encoding="utf-8"))
    plugin_data["mcpServers"]["codemem"]["args"] = ["mcp"]
    plugin_path.write_text(json.dumps(plugin_data, indent=2) + "\n", encoding="utf-8")

    script_path = Path(__file__).resolve().parents[1] / "scripts" / "release_version.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script_path),
            "--root",
            str(root),
            "set",
            "1.0.1",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 2
    assert "Error:" in result.stderr
    assert "Traceback" not in result.stderr
