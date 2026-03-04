from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


@dataclass(frozen=True)
class VersionSnapshot:
    pyproject: str
    package_json: str
    package_init: str
    opencode_plugin_pin: str
    claude_plugin_manifest: str
    claude_plugin_uvx_spec: str
    marketplace_metadata: str
    marketplace_plugin: str

    def to_dict(self) -> dict[str, str]:
        return {
            "pyproject": self.pyproject,
            "package_json": self.package_json,
            "package_init": self.package_init,
            "opencode_plugin_pin": self.opencode_plugin_pin,
            "claude_plugin_manifest": self.claude_plugin_manifest,
            "claude_plugin_uvx_spec": self.claude_plugin_uvx_spec,
            "marketplace_metadata": self.marketplace_metadata,
            "marketplace_plugin": self.marketplace_plugin,
        }


def validate_semver(version: str) -> None:
    if not SEMVER_RE.match(version):
        raise ValueError(f"Invalid version '{version}'. Expected format: X.Y.Z")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def _extract_pyproject_version(text: str) -> str:
    in_project = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("[") and line.endswith("]"):
            in_project = line == "[project]"
            continue
        if in_project:
            match = re.match(r'version\s*=\s*"([^"]+)"$', line)
            if match:
                return match.group(1)
    raise ValueError("Could not find [project].version in pyproject.toml")


def _replace_pyproject_version(text: str, version: str) -> str:
    in_project = False
    lines: list[str] = []
    replaced = False

    for raw_line in text.splitlines(keepends=True):
        stripped = raw_line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_project = stripped == "[project]"
        if in_project and not replaced:
            match = re.match(
                r'(?P<prefix>\s*version\s*=\s*")(?P<version>[^"]+)(?P<suffix>"[ \t]*)(?P<newline>\r?\n?)$',
                raw_line,
            )
            if match:
                lines.append(
                    f"{match.group('prefix')}{version}{match.group('suffix')}{match.group('newline')}"
                )
                replaced = True
                continue
        lines.append(raw_line)

    if not replaced:
        raise ValueError("Could not replace [project].version in pyproject.toml")
    return "".join(lines)


def _extract_init_version(text: str) -> str:
    match = re.search(r'^__version__\s*=\s*"([^"]+)"$', text, re.MULTILINE)
    if not match:
        raise ValueError("Could not find __version__ in codemem/__init__.py")
    return match.group(1)


def _replace_init_version(text: str, version: str) -> str:
    updated, count = re.subn(
        r'^(__version__\s*=\s*")([^"]+)("\s*)$',
        rf"\g<1>{version}\g<3>",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise ValueError("Could not replace __version__ in codemem/__init__.py")
    return updated


def _extract_plugin_pin_version(text: str) -> str:
    match = re.search(r'^const\s+PINNED_BACKEND_VERSION\s*=\s*"([^"]+)";$', text, re.MULTILINE)
    if not match:
        raise ValueError("Could not find PINNED_BACKEND_VERSION in .opencode/plugin/codemem.js")
    return match.group(1)


def _replace_plugin_pin_version(text: str, version: str) -> str:
    updated, count = re.subn(
        r'^(const\s+PINNED_BACKEND_VERSION\s*=\s*")([^"]+)(";\s*)$',
        rf"\g<1>{version}\g<3>",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise ValueError("Could not replace PINNED_BACKEND_VERSION in .opencode/plugin/codemem.js")
    return updated


def _load_json(path: Path) -> object:
    return json.loads(_read_text(path))


def _dump_json_text(payload: object) -> str:
    return json.dumps(payload, indent=2) + "\n"


def _expect_mapping(value: object, context: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{context} must be an object")
    return value


def _expect_list(value: object, context: str) -> list[object]:
    if not isinstance(value, list):
        raise ValueError(f"{context} must be a list")
    return value


def _get_claude_plugin_args(plugin_manifest: dict[str, object]) -> list[object]:
    mcp_servers = _expect_mapping(
        plugin_manifest.get("mcpServers"),
        "plugins/claude/.claude-plugin/plugin.json mcpServers",
    )
    codemem_server = _expect_mapping(
        mcp_servers.get("codemem"),
        "plugins/claude/.claude-plugin/plugin.json mcpServers.codemem",
    )
    return _expect_list(
        codemem_server.get("args"),
        "plugins/claude/.claude-plugin/plugin.json mcpServers.codemem.args",
    )


def _find_unique_codemem_spec_index(args: list[object], context: str) -> int:
    indices: list[int] = []
    for idx, item in enumerate(args):
        if isinstance(item, str) and item.startswith("codemem=="):
            indices.append(idx)
    if len(indices) != 1:
        raise ValueError(f"{context} must contain exactly one codemem==X.Y.Z arg")
    return indices[0]


def _extract_uvx_package_version(plugin_manifest: dict[str, object]) -> str:
    args = _get_claude_plugin_args(plugin_manifest)
    index = _find_unique_codemem_spec_index(args, "plugins/claude/.claude-plugin/plugin.json")
    value = args[index]
    if not isinstance(value, str):
        raise ValueError(
            "plugins/claude/.claude-plugin/plugin.json codemem package arg must be text"
        )
    return value.split("==", 1)[1]


def read_versions(root: Path) -> VersionSnapshot:
    pyproject = _extract_pyproject_version(_read_text(root / "pyproject.toml"))
    init_version = _extract_init_version(_read_text(root / "codemem" / "__init__.py"))

    package_json = _expect_mapping(_load_json(root / "package.json"), "package.json")
    plugin_manifest = _expect_mapping(
        _load_json(root / "plugins" / "claude" / ".claude-plugin" / "plugin.json"),
        "plugins/claude/.claude-plugin/plugin.json",
    )
    marketplace = _expect_mapping(
        _load_json(root / ".claude-plugin" / "marketplace.json"),
        ".claude-plugin/marketplace.json",
    )

    marketplace_plugins = _expect_list(
        marketplace.get("plugins"),
        ".claude-plugin/marketplace.json plugins",
    )

    codemem_plugin = next(
        (
            plugin
            for plugin in marketplace_plugins
            if isinstance(plugin, dict) and plugin.get("name") == "codemem"
        ),
        None,
    )
    if codemem_plugin is None:
        raise ValueError(".claude-plugin/marketplace.json missing codemem plugin entry")

    metadata = _expect_mapping(
        marketplace.get("metadata"),
        ".claude-plugin/marketplace.json metadata",
    )

    return VersionSnapshot(
        pyproject=pyproject,
        package_json=str(package_json.get("version", "")),
        package_init=init_version,
        opencode_plugin_pin=_extract_plugin_pin_version(
            _read_text(root / ".opencode" / "plugin" / "codemem.js")
        ),
        claude_plugin_manifest=str(plugin_manifest.get("version", "")),
        claude_plugin_uvx_spec=_extract_uvx_package_version(plugin_manifest),
        marketplace_metadata=str(metadata.get("version", "")),
        marketplace_plugin=str(codemem_plugin.get("version", "")),
    )


def versions_are_aligned(snapshot: VersionSnapshot) -> tuple[bool, list[str]]:
    values = snapshot.to_dict()
    unique = sorted(set(values.values()))
    if len(unique) <= 1:
        return True, []

    lines = ["Version drift detected:"]
    for key, value in values.items():
        lines.append(f"- {key}: {value}")
    return False, lines


def set_version(root: Path, version: str, *, dry_run: bool = False) -> list[str]:
    validate_semver(version)

    changed: list[str] = []
    pending_writes: dict[Path, str] = {}

    pyproject_path = root / "pyproject.toml"
    pyproject_text = _read_text(pyproject_path)
    pyproject_updated = _replace_pyproject_version(pyproject_text, version)
    if pyproject_updated != pyproject_text:
        changed.append("pyproject.toml")
        pending_writes[pyproject_path] = pyproject_updated

    init_path = root / "codemem" / "__init__.py"
    init_text = _read_text(init_path)
    init_updated = _replace_init_version(init_text, version)
    if init_updated != init_text:
        changed.append("codemem/__init__.py")
        pending_writes[init_path] = init_updated

    package_json_path = root / "package.json"
    package_json = _expect_mapping(_load_json(package_json_path), "package.json")
    if package_json.get("version") != version:
        package_json["version"] = version
        changed.append("package.json")
        pending_writes[package_json_path] = _dump_json_text(package_json)

    opencode_plugin_path = root / ".opencode" / "plugin" / "codemem.js"
    opencode_plugin_text = _read_text(opencode_plugin_path)
    opencode_plugin_updated = _replace_plugin_pin_version(opencode_plugin_text, version)
    if opencode_plugin_updated != opencode_plugin_text:
        changed.append(".opencode/plugin/codemem.js")
        pending_writes[opencode_plugin_path] = opencode_plugin_updated

    claude_plugin_path = root / "plugins" / "claude" / ".claude-plugin" / "plugin.json"
    claude_plugin = _expect_mapping(
        _load_json(claude_plugin_path),
        "plugins/claude/.claude-plugin/plugin.json",
    )
    claude_changed = False
    if claude_plugin.get("version") != version:
        claude_plugin["version"] = version
        claude_changed = True

    args = _get_claude_plugin_args(claude_plugin)
    spec_index = _find_unique_codemem_spec_index(args, "plugins/claude/.claude-plugin/plugin.json")
    expected = f"codemem=={version}"
    current_spec = args[spec_index]
    if not isinstance(current_spec, str):
        raise ValueError(
            "plugins/claude/.claude-plugin/plugin.json codemem package arg must be text"
        )
    if current_spec != expected:
        args[spec_index] = expected
        claude_changed = True

    if claude_changed:
        changed.append("plugins/claude/.claude-plugin/plugin.json")
        pending_writes[claude_plugin_path] = _dump_json_text(claude_plugin)

    marketplace_path = root / ".claude-plugin" / "marketplace.json"
    marketplace = _expect_mapping(
        _load_json(marketplace_path),
        ".claude-plugin/marketplace.json",
    )
    marketplace_changed = False

    metadata = _expect_mapping(
        marketplace.get("metadata"),
        ".claude-plugin/marketplace.json metadata",
    )
    if metadata.get("version") != version:
        metadata["version"] = version
        marketplace_changed = True

    plugins = _expect_list(
        marketplace.get("plugins"),
        ".claude-plugin/marketplace.json plugins",
    )
    codemem_entries = 0
    for plugin in plugins:
        if not isinstance(plugin, dict):
            continue
        if plugin.get("name") != "codemem":
            continue
        codemem_entries += 1
        if plugin.get("version") != version:
            plugin["version"] = version
            marketplace_changed = True
    if codemem_entries == 0:
        raise ValueError(".claude-plugin/marketplace.json missing codemem plugin entry")

    if marketplace_changed:
        changed.append(".claude-plugin/marketplace.json")
        pending_writes[marketplace_path] = _dump_json_text(marketplace)

    if not dry_run:
        for path, content in pending_writes.items():
            _write_text(path, content)

    return changed
