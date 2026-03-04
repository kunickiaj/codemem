#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from codemem.release_version import read_versions, set_version, versions_are_aligned


def cmd_check(root: Path) -> int:
    snapshot = read_versions(root)
    aligned, details = versions_are_aligned(snapshot)
    if aligned:
        version = snapshot.pyproject
        print(f"OK: release versions are aligned at {version}")
        return 0

    for line in details:
        print(line)
    return 1


def cmd_set(root: Path, version: str, dry_run: bool) -> int:
    changed = set_version(root, version, dry_run=dry_run)
    if changed:
        mode = "would update" if dry_run else "updated"
        print(f"{mode} {len(changed)} file(s):")
        for path in changed:
            print(f"- {path}")
    else:
        print("No version changes needed.")

    if dry_run:
        print("Dry run complete; no files written.")
        return 0

    snapshot = read_versions(root)
    aligned, details = versions_are_aligned(snapshot)
    if not aligned:
        for line in details:
            print(line)
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Check and update release version alignment across codemem artifacts."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Repository root (defaults to script parent root).",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check", help="Verify all release version fields are aligned.")

    set_parser = subparsers.add_parser("set", help="Set release version across all managed files.")
    set_parser.add_argument("version", help="Semantic version to apply (X.Y.Z).")
    set_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print files that would change without writing.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    root = args.root.resolve()

    try:
        if args.command == "check":
            return cmd_check(root)
        if args.command == "set":
            return cmd_set(root, args.version, args.dry_run)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
