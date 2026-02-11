from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import typer
from rich import print


def _strip_json_comments(text: str) -> str:
    lines: list[str] = []
    for line in text.splitlines():
        result: list[str] = []
        in_string = False
        escape_next = False
        i = 0
        while i < len(line):
            char = line[i]
            if escape_next:
                result.append(char)
                escape_next = False
                i += 1
                continue
            if char == "\\" and in_string:
                result.append(char)
                escape_next = True
                i += 1
                continue
            if char == '"':
                in_string = not in_string
                result.append(char)
                i += 1
                continue
            if not in_string and char == "/" and i + 1 < len(line) and line[i + 1] == "/":
                break
            result.append(char)
            i += 1
        lines.append("".join(result))
    return "\n".join(lines)


def _load_opencode_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = path.read_text()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = json.loads(_strip_json_comments(raw))
    return parsed if isinstance(parsed, dict) else {}


def _write_opencode_config(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def install_plugin_cmd(*, force: bool) -> None:
    """Install the codemem plugin to OpenCode's plugin directory."""

    cli_dir = Path(__file__).resolve().parents[1]
    plugin_source = cli_dir / ".opencode" / "plugin" / "codemem.js"
    if not plugin_source.exists():
        plugin_source = cli_dir.parent / ".opencode" / "plugin" / "codemem.js"

    if not plugin_source.exists():
        print("[red]Error: Plugin file not found in package[/red]")
        print(f"[dim]Searched: {cli_dir / '.opencode' / 'plugin'}[/dim]")
        print(f"[dim]Searched: {cli_dir.parent / '.opencode' / 'plugin'}[/dim]")
        raise typer.Exit(code=1)

    opencode_config_dir = Path.home() / ".config" / "opencode"
    plugin_dir = opencode_config_dir / "plugin"
    plugin_dest = plugin_dir / "codemem.js"

    if plugin_dest.exists() and not force:
        print(f"[yellow]Plugin already installed at {plugin_dest}[/yellow]")
        print("[dim]Use --force to overwrite[/dim]")
        return

    plugin_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(plugin_source, plugin_dest)
    print(f"[green]✓ Plugin installed to {plugin_dest}[/green]")
    print("\n[bold]Next steps:[/bold]")
    print("1. Restart OpenCode to load the plugin")
    print("2. The plugin will auto-detect installed mode and use SSH git URLs")
    print("3. View logs at: [dim]~/.codemem/plugin.log[/dim]")


def install_mcp_cmd(*, force: bool) -> None:
    """Install the codemem MCP entry into OpenCode's config."""

    config_path = Path.home() / ".config" / "opencode" / "opencode.json"
    try:
        config = _load_opencode_config(config_path)
    except Exception as exc:
        print(f"[red]Error: Failed to parse {config_path}: {exc}[/red]")
        raise typer.Exit(code=1) from exc

    mcp_config = config.get("mcp")
    if not isinstance(mcp_config, dict):
        mcp_config = {}

    if "codemem" in mcp_config and not force:
        print(f"[yellow]MCP entry already exists in {config_path}[/yellow]")
        print("[dim]Use --force to overwrite[/dim]")
        return

    mcp_config["codemem"] = {
        "type": "local",
        "command": ["uvx", "codemem", "mcp"],
        "enabled": True,
    }
    config["mcp"] = mcp_config

    try:
        _write_opencode_config(config_path, config)
    except Exception as exc:
        print(f"[red]Error: Failed to write {config_path}: {exc}[/red]")
        raise typer.Exit(code=1) from exc

    print(f"[green]✓ MCP entry installed in {config_path}[/green]")
    print("Restart OpenCode to load the MCP tools.")
