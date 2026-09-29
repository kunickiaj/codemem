This patch improves OpenCode 2 observer authentication, keeps raw-event capture safer, and makes device sync easier to inspect and run.

## Highlights

- **OpenCode 2 observer:** Newly captured V2 events with implicit OpenCode credentials can use the signed-in service without reading the legacy `auth.json` file. codemem preserves the selected provider and model. OpenCode 1, older unmarked events, explicit credentials, custom endpoints, and selected sidecars keep their previous routes.
- **Settings:** Observer changes can take effect in the running viewer without a restart. Model suggestions and an on-demand synthetic check help verify a choice without silently switching provider or model. A listed model is not a guarantee that the active account can use it.
- **Raw events:** Missing observer authentication no longer discards queued events. Historical recovery processes eligible gaps at a paced rate without rewinding session cursors. Windows containing only assistant usage records finish without an observer call or a new memory; missing or invalid events remain failed for diagnosis.
- **Spool reliability:** Failures report a safe stage and code without logging event contents. A repeated event ID that differs only in top-level delivery timestamps reuses the durable spool entry; other conflicting entries remain conflicts.
- **Devices:** Each paired peer shows sync health, last sync, and past-24-hour inbound and outbound **operation counts**, not bytes. The row action syncs only the selected peer. Local, unpaired, unavailable, and stale states remain distinct; Advanced Sync retains its deeper controls.

## Limits and upgrade

The V2 stateless generation route and the Codex and Claude CLI sidecars do **not** enforce a provider-side output-token cap. codemem limits its wait and the response size it accepts, but those limits do not cap upstream generation or billing. Charges depend on the active provider account; a separately configured API key may incur API charges.

Raw-event POST 409 still rejects database, identity, or contract mismatches. Its response includes `error.code` (already present in 0.46.0), though the toast may not show it.

Install the matching 0.46.1 packages, then restart the viewer and agent host when safe. An already-running viewer does not switch builds automatically.
