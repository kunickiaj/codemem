# Changelog

Release summaries live here, newest first. Add an entry when preparing a release; GitHub releases use that entry alongside generated commit notes. Earlier releases and versions without an entry are available in [GitHub Releases](https://github.com/kunickiaj/codemem/releases).

## 0.46.2

This patch makes observer Settings easier to configure and verifies that saved connection choices stay separate. It also fixes OpenCode 2 model selection during cold startup.

### Highlights

- **Clear connection choices:** Choose an OpenCode account, an API key, a local Claude session, or a local Codex session. API-key mode does not use cached subscription sign-ins, and OpenCode-account mode does not silently fall back to a direct API key. Missing credentials or an unavailable service produce a visible error.
- **Model settings:** Settings shows the actual defaults and puts Simple and Rich tier models together. OpenAI/Codex uses `gpt-6-luna` for Simple and untiered defaults, and `gpt-5.6-terra` for Rich. Saved model choices and hidden values remain intact. The misleading model check was removed; a suggested model does not guarantee account access.
- **Save and apply feedback:** Settings distinguishes saved changes from changes active in the running observer and shows restart guidance only when needed. Automatic connection choices remain automatic when saved. Reverting a connection draft restores active tier routing without overwriting explicit routing choices or other drafts.
- **Custom providers:** Auto provider inference accepts mixed-case provider prefixes while retaining the configured provider ID. OpenCode and direct custom-provider requests strip matching prefixes without changing model-ID case; direct requests still apply configured model-ID mappings.
- **OpenCode 2 startup:** codemem retries the exact pre-generation model-selection rejection that can occur before the service's model catalog is ready. Retries keep the selected provider and model, stop after six requests, and wait at most 7.75 seconds in total. Other errors and uncertain generation outcomes are not retried by this compatibility path.

### Compatibility and upgrade

Legacy `api_http` and omitted runtime settings keep their previous routing until you explicitly change the connection. Unrelated Settings edits do not migrate your credentials or account choice.

Install the matching 0.46.2 packages, then restart the viewer and agent host when safe. An already-running viewer does not switch builds automatically. This release does not claim to fix every queued-event failure; inspect observer status if a backlog remains.

## 0.46.1

This patch improves OpenCode 2 observer authentication, keeps raw-event capture safer, and makes device sync easier to inspect and run.

### Highlights

- **OpenCode 2 observer:** Newly captured V2 events with implicit OpenCode credentials can use the signed-in service without reading the legacy `auth.json` file. codemem preserves the selected provider and model. OpenCode 1, older unmarked events, explicit credentials, custom endpoints, and selected sidecars keep their previous routes.
- **Settings:** Observer changes can take effect in the running viewer without a restart. Model suggestions and an on-demand synthetic check help verify a choice without silently switching provider or model. A listed model is not a guarantee that the active account can use it.
- **Raw events:** Missing observer authentication no longer discards queued events. Historical recovery processes eligible gaps at a paced rate without rewinding session cursors. Windows containing only assistant usage records finish without an observer call or a new memory; missing or invalid events remain failed for diagnosis.
- **Spool reliability:** Failures report a safe stage and code without logging event contents. A repeated event ID that differs only in top-level delivery timestamps reuses the durable spool entry; other conflicting entries remain conflicts.
- **Devices:** Each paired peer shows sync health, last sync, and past-24-hour inbound and outbound **operation counts**, not bytes. The row action syncs only the selected peer. Local, unpaired, unavailable, and stale states remain distinct; Advanced Sync retains its deeper controls.

### Limits and upgrade

The V2 stateless generation route and the Codex and Claude CLI sidecars do **not** enforce a provider-side output-token cap. codemem limits its wait and the response size it accepts, but those limits do not cap upstream generation or billing. Charges depend on the active provider account; a separately configured API key may incur API charges.

Raw-event POST 409 still rejects database, identity, or contract mismatches. Its response includes `error.code` (already present in 0.46.0), though the toast may not show it.

Install the matching 0.46.1 packages, then restart the viewer and agent host when safe. An already-running viewer does not switch builds automatically.

## 0.44.0

This release combines semantic installation, safer automatic recall, and Team setup corrections.

### Highlights

- Automatic OpenCode recall checks requester-session eligibility before retrieval and fallback, and isolates delta baselines by requester continuity. Missing session mapping blocks continuity summaries without excluding useful historical facts.
- Automatic recall preserves retained context and deduplicates unchanged items. The retained-token ceiling remains off by default; Health reports bounded injection measurements rather than provider token usage or answer quality.
- Viewer diagnostics provide contextual actions and redacted event details. Observer output follows provider capabilities, with deterministic envelope and forced-tool evaluation coverage.
- Team setup retries refresh stale confirmation evidence and require renewed confirmation. Readiness counts roster devices and persisted assignments once, while still limiting unrelated assignment work.
- Team conflict containment removes setup-owned routing mappings on the affected coordinator group's active and retired scopes in the same transaction, including mappings left by older containment. Already-contained policy is not reactivated or rewritten. User-owned mappings and other coordinator groups remain unchanged; stored memories are not rewritten.
- SQLite uses the connection's actual in-memory state when deciding whether to enable WAL, so disk filenames resembling memory URIs retain WAL behavior.
- The CLI-only packed install verifies the matching optional embedding runtime, real inference, and semantic retrieval. Lexical fallback remains available when the runtime cannot initialize.

### Limits and upgrade

Session eligibility is not task classification, and this release does not claim to solve every same-session task transition. Source-window provenance superseded the earlier mandatory task-classification proposal; no new source-window suppression shipped here. Dual OpenCode V1/V2 support followed in 0.45.

The npm latest-tag guard remains verify-only and warning-only. Stable publication uses `--tag latest`; publishing a new stable embeddings version can advance its tag naturally, but skipping an already-published version does not repair tags.

Update through your usual installation method, then restart the viewer and coding-agent session. Back up your memory database before upgrading and let any search-index updates finish. Search by meaning remains platform-dependent; keyword search is still available. See [the published release](https://github.com/kunickiaj/codemem/releases/tag/v0.44.0) for contributor credits and the full commit history.
