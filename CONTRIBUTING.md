# Contributing to codemem

Thanks for helping improve codemem.

## Local setup

```bash
uv sync
uv run codemem --help
```

## Quality checks

Run these before opening a PR:

```bash
uv run pytest
uv run ruff check codemem tests
uv run ruff format --check codemem tests
```

Targeted test examples:

```bash
uv run pytest tests/test_store.py
uv run pytest tests/test_store.py::test_store_roundtrip
uv run pytest -k "raw_event and sweeper"
```

## Viewer/plugin development

- Viewer UI is embedded in `codemem/viewer.py`.
- OpenCode plugin source is `.opencode/plugin/codemem.js`.
- Restart the viewer after UI changes:

```bash
uv run codemem serve --restart
```

## Release workflow

Releases are tag-driven (`vX.Y.Z`) and run via `.github/workflows/release.yml`.

Before tagging:

1. Ensure CI is green on `main`
2. Bump version fields:
   - `pyproject.toml`
   - `codemem/__init__.py`
3. Regenerate and commit artifacts:
   - `uv sync` (commit `uv.lock`)
   - `viewer_ui/`: `bun install` then `bun run build` (commit updated `codemem/viewer_static/app.js`)
4. Tag and push:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

## Docs expectations

- Keep README focused on user onboarding.
- Put advanced operational details in `docs/`.
- If behavior changes, update the related docs in the same PR.
