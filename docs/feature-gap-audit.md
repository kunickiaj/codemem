# Feature/Gaps Audit (Code Evidence)

## A) Feature matrix

| Feature | Present? | Evidence (file:line) | Notes |
|---|---|---|---|
| Typed memories / taxonomy constants | Yes | `codemem/memory_kinds.py:5-17` | Allowed kinds are centralized (`session_summary`, `observation`, `entities`, `note`, `decision`, `discovery`, `change`, `feature`, `bugfix`, `refactor`, `exploration`). |
| Observer output schema for typed observations | Yes | `codemem/observer_prompts.py:75-97`, `codemem/xml_parser.py:17-27`, `codemem/xml_parser.py:74-97` | Observer prompt defines XML schema; parser extracts typed fields (`kind`, `facts`, `concepts`, files lists). |
| Observer pipeline: event extraction/compaction/filter budget | Yes | `codemem/plugin_ingest.py:376-381`, `codemem/ingest_tool_events.py:62-120` | Tool events are extracted and then deduped/ranked under a char + count budget before observer call. |
| Observer pipeline: summarization stage | Yes | `codemem/plugin_ingest.py:506-527`, `codemem/plugin_ingest.py:539-554`, `codemem/xml_parser.py:99-133` | Summary block is optional and persisted when not skipped. |
| Observer pipeline: classification stage | Yes | `codemem/plugin_ingest.py:482-502` | Parsed observation `kind` is validated against allowed typed set and low-signal entries are dropped. |
| Pack construction logic | Yes | `codemem/store/packs.py:231-343`, `codemem/store/packs.py:365-460`, `codemem/store/packs.py:522-533` | Pack builder combines search modes, sections (`Summary`/`Timeline`/`Observations`), and token-budget trimming. |
| Injection trigger (automatic prompt injection) | Yes | `.opencode/plugin/codemem.js:957-1014`, `.opencode/plugin/codemem.js:740-784`, `.opencode/plugin/codemem.js:827-854` | Injects in OpenCode `experimental.chat.system.transform`, builds a query from first/latest prompt + project + recent files, then runs `codemem pack`. |
| Ranking/scoring: keyword + recency | Yes | `codemem/store/search.py:713-720` | FTS ranking uses `-bm25(...)` with recency term in SQL ordering. |
| Ranking/scoring: semantic vector input | Yes | `codemem/store/search.py:283-345` | Semantic search via embeddings + `memory_vectors` distance scoring. |
| Ranking/scoring: hybrid merge and rerank | Yes | `codemem/store/search.py:483-573` | FTS + semantic candidates merged; baseline/hybrid rerank modes supported. |
| Ranking/scoring: type weights | Partial | `codemem/store/search.py:218-229`, `codemem/store/search.py:399-425` | Kind bonus exists, but only for legacy kinds (`session_summary`, `decision`, `note`, `observation`, `entities`) not all newer typed kinds. |
| Ranking/scoring: working-set signal | Unclear / likely missing | `.opencode/plugin/codemem.js:768-775`, `codemem/store/search.py:389-428` | Recent modified files are used to form injection query text, but retrieval score function has no explicit working-set feature/weight. |
| Keyword search implementation (FTS5 vs LIKE) | Yes (FTS5 primary) | `codemem/db.py:159-163`, `codemem/store/search.py:693-719` | Uses SQLite FTS5 `memory_fts MATCH ?` + BM25; no LIKE-based primary retrieval path. |
| Keyword+semantic strategy = rerank vs merge | Yes (merge + rerank) | `codemem/store/packs.py:341-343`, `codemem/store/search.py:507-572` | Results are merged then reranked (not pure score interpolation without merging). |
| MCP tools surface area: search/timeline/pack/etc. | Yes (core set) | `codemem/mcp_server.py:59-76`, `codemem/mcp_server.py:78-109`, `codemem/mcp_server.py:153-225`, `codemem/mcp_server.py:227-248` | Tools: `memory_search_index`, `memory_timeline`, `memory_get_observations`, `memory_search`, `memory_get`, `memory_recent`, `memory_pack`, `memory_remember`, `memory_forget`, `memory_schema`, `memory_learn`. |
| MCP tools: explicit `expand` tool | No | `codemem/mcp_server.py:59-325` | No dedicated `memory_expand`; nearest behavior is `memory_timeline` + `memory_get_observations`. |
| MCP tools: explicit `explain` tool | No | `codemem/mcp_server.py:59-325` | No `memory_explain` / rationale endpoint for ranking/injection decisions. |
| Project scoping behavior | Yes | `codemem/commands/common.py:37-46`, `codemem/store/utils.py:44-61`, `codemem/store/search.py:704-709`, `codemem/plugin_ingest.py:283-305` | Project defaults from cwd/env, normalized to basename, then applied via `sessions.project` clause in retrieval filters. |
| Explainability (“why injected”) | Partial | `.opencode/plugin/codemem.js:985-995`, `codemem/store/packs.py:602-638` | UI toast exposes coarse metrics (items/tokens/avoided work); no item-level “why this memory was selected”. |
| Pack-delta logic (delta between successive packs) | No | `.opencode/plugin/codemem.js:970-980`, `codemem/store/packs.py:231-660` | Plugin caches last injected text per session/query but does not compute/report semantic/item delta across injections. |
| Cross-shell integration beyond OpenCode plugin | Partial | `codemem/capture.py:78-177`, `codemem/commands/opencode_integration_cmds.py:60-124`, `.opencode/plugin/codemem.js:1-4` | Generic CLI capture exists for any command, but first-class live integration hooks are OpenCode-specific; no analogous zsh/fish/bash plugin module discovered. |

## B) Safe GitHub issues to file (only gaps/partials)

### 1) Add MCP explainability tool for retrieval/injection rationale

- **Title**: `feat(mcp): add memory.explain for retrieval and pack rationale`
- **Problem statement**: MCP currently exposes recall/write tools, but no explicit explainability tool to answer “why was this memory selected/injected?”. Tool registry in `mcp_server.py` contains no `memory_explain` equivalent. Evidence: `codemem/mcp_server.py:59-325`.
- **Proposed change**:
  - Add `memory_explain(query, memory_ids?, project?)` MCP tool.
  - Return per-item rationale fields (source: fts/semantic/fuzzy/timeline, score components, recency, kind bonus, project-match status).
  - Optionally expose most recent pack’s candidate/rerank diagnostics.
- **Acceptance criteria**:
  - New MCP tool exists and is discoverable in tool list/schema docs.
  - For a known query, response includes item-level rationale for each returned memory ID.
  - Response is stable for missing IDs / out-of-scope project filters (graceful error payload).
- **Test plan**:
  - Unit tests for explain payload generation from mocked ranked candidates.
  - MCP contract test verifying tool registration + response shape.
  - Integration test against seeded SQLite store for deterministic rationale fields.
- **Files likely to touch**:
  - `codemem/mcp_server.py`
  - `codemem/store/search.py`
  - `codemem/store/packs.py` (if reusing pack diagnostics)
  - `tests/test_contracts.py`
  - `tests/test_hybrid_eval.py` or new `tests/test_mcp_explain.py`

### 2) Add explicit MCP `memory.expand` helper to bridge index -> details workflow

- **Title**: `feat(mcp): add memory.expand to expand search_index IDs into timeline + observation details`
- **Problem statement**: Current workflow requires clients to orchestrate `search_index` + `timeline` + `get_observations` manually. There is no explicit `expand` tool. Evidence: tool set in `codemem/mcp_server.py:59-325`.
- **Proposed change**:
  - Add `memory_expand(ids, depth_before=..., depth_after=..., include_observations=true, project?)`.
  - Return normalized bundle: anchor items, timeline context, and optional full observation payloads.
- **Acceptance criteria**:
  - New MCP tool exists and returns structured expansion payload.
  - Duplicate IDs are deduped; missing IDs are reported, not fatal.
  - Project filter behavior matches existing tools.
- **Test plan**:
  - MCP unit/contract tests for success and mixed valid+invalid IDs.
  - Store integration test validating project-scoped expansion.
- **Files likely to touch**:
  - `codemem/mcp_server.py`
  - `codemem/store/search.py`
  - `tests/test_contracts.py`
  - new `tests/test_mcp_expand.py`

### 3) Extend kind-aware scoring to newer typed memory kinds

- **Title**: `feat(search): add scoring weights for discovery/change/feature/bugfix/refactor/exploration`
- **Problem statement**: Kind bonus currently weights only legacy kinds and omits most newer typed kinds used by observer ingestion. Evidence: allowed kinds in `codemem/memory_kinds.py:5-17`; current kind bonus in `codemem/store/search.py:218-229`.
- **Proposed change**:
  - Replace hardcoded `_kind_bonus` with config-backed or constant mapping covering all allowed kinds.
  - Tune default weights conservatively to avoid retrieval regressions.
- **Acceptance criteria**:
  - `_kind_bonus` handles every `ALLOWED_MEMORY_KINDS` value.
  - Hybrid/baseline retrieval tests still pass and can verify deterministic ordering for seeded fixtures.
- **Test plan**:
  - Add unit tests asserting non-zero/expected bonuses for new typed kinds.
  - Run hybrid eval fixture test(s) to confirm no regressions.
- **Files likely to touch**:
  - `codemem/store/search.py`
  - `codemem/memory_kinds.py` (if shared map lives there)
  - `tests/test_store.py`
  - `tests/test_hybrid_eval.py`

### 4) Add pack-delta output for repeated injection cycles

- **Title**: `feat(pack): emit pack delta metadata for successive injections`
- **Problem statement**: Plugin caches prior injected context per session/query but does not compute/report what changed between injections. Evidence: cache write/read in `.opencode/plugin/codemem.js:970-980`; pack builder currently returns metrics but no prior-pack diff in `codemem/store/packs.py:602-638`.
- **Proposed change**:
  - Add optional delta payload (`added_ids`, `removed_ids`, `retained_ids`, `pack_token_delta`) when previous pack context is available.
  - Surface a concise delta in plugin toast/log.
- **Acceptance criteria**:
  - Consecutive pack calls can produce deterministic delta metadata.
  - Plugin can display “N new / M dropped” without failing when prior state missing.
- **Test plan**:
  - Unit tests for set-diff computation logic.
  - Plugin-level tests (or lightweight JS tests) for toast text formatting with/without delta.
- **Files likely to touch**:
  - `codemem/store/packs.py`
  - `.opencode/plugin/codemem.js`
  - `tests/test_pack_filter_invariants.py` or new pack-delta test
  - `.opencode/tests/compat.test.js` or new plugin test

### 5) Add explicit working-set signal to retrieval scoring

- **Title**: `feat(search): incorporate working-set file signal into ranking`
- **Problem statement**: Current retrieval score uses FTS/BM25, semantic, recency, and kind bonus, but no direct scoring term for active working-set files/modules. Working-set hints are only embedded into injection query text. Evidence: query composition uses recent file names in `.opencode/plugin/codemem.js:768-775`; rerank scoring has no working-set input in `codemem/store/search.py:399-425`.
- **Proposed change**:
  - Add optional working-set tokens/path hints to search API and reranker.
  - Compute overlap between working-set hints and memory file metadata/tags/body to apply bounded boost.
- **Acceptance criteria**:
  - New optional input does not alter results when unset.
  - When set, memories with matching files/tags gain measurable bounded boost.
- **Test plan**:
  - Unit tests for overlap scoring function.
  - Integration test with seeded memories containing file metadata to validate rank shifts.
- **Files likely to touch**:
  - `codemem/store/search.py`
  - `codemem/store/packs.py`
  - `.opencode/plugin/codemem.js` (pass hints)
  - `tests/test_hybrid_eval.py` + new targeted ranking tests

### 6) Add first-class non-OpenCode shell integration module

- **Title**: `feat(integrations): add first-class shell hooks for bash/zsh/fish capture/injection`
- **Problem statement**: Repo has generic command capture and an OpenCode plugin, but no first-class shell hook integration equivalent (startup/install scripts, shell event hooks, prompt injection) for bash/zsh/fish. Evidence: generic capture in `codemem/capture.py:78-177`; OpenCode-specific integration command in `codemem/commands/opencode_integration_cmds.py:60-124`; plugin entrypoint in `.opencode/plugin/codemem.js:1-4`.
- **Proposed change**:
  - Introduce shell integration command group (`codemem install-shell --shell zsh|bash|fish`) that installs safe hook snippets.
  - Capture prompts/commands and optionally call `codemem pack` for context hints in shell-native manner.
- **Acceptance criteria**:
  - Install/uninstall flows work idempotently for supported shells.
  - Hook failures are non-fatal and never block shell startup.
  - Basic docs for setup/troubleshooting included.
- **Test plan**:
  - Unit tests for shell snippet generation and idempotent patching.
  - Smoke tests for command output in temp dotfiles.
- **Files likely to touch**:
  - `codemem/cli_app.py`
  - new `codemem/commands/shell_integration_cmds.py`
  - `docs/user-guide.md`
  - `tests/test_cli_help.py` + new shell integration tests

## Conceptual comparison notes (non-code)

Relative to common “memory copilot” patterns (e.g., projects like cogniplex/codemem and claude-mem), this codebase already has strong typed ingestion + hybrid retrieval + automatic injection. The most evident product gaps are **explainability APIs**, **pack-delta visibility**, and **broader first-class integrations beyond OpenCode**.
