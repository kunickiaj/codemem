# 0.46.1 release notes (draft)

OpenCode 2 observer extraction can use the signed-in OpenCode service instead of relying on the legacy `auth.json` credential file. Newly captured V2 events with implicit OpenCode credentials take the stateless service path automatically, preserving the selected provider and model. OpenCode 1 events, older unmarked events, explicit API credentials, custom endpoints, and selected sidecars retain their previous behavior. Historical recovery stays on its configured route.

Settings shows model suggestions from OpenCode's catalog and offers an on-demand synthetic model check. A listing is not a guarantee that the active connection can use that model; a failed request does not silently select another model or provider. OpenCode chooses the active account for the provider, so subscription and API billing depend on that account.

**Output limits:** The V2 stateless generation route does not accept a provider-enforced output-token cap or report token usage. Codemem limits its wait and the response size it accepts, but these do not cap upstream generation or billing. The existing Codex and Claude CLI sidecars and legacy OpenCode OAuth Codex path have the same lack of a provider-side cap. For a provider-enforced cap, configure a direct API-key observer route; direct API requests may incur separate API charges.

Raw events remain queued through missing-observer-auth failures. Historical recovery retries eligible gaps at a paced rate without rewinding session cursors or silently changing the configured observer route. Failed windows remain recorded for diagnosis rather than being marked recovered.

Raw-event spool failures now report a safe failure stage and code without logging event contents. Repeated event IDs whose only differences are top-level delivery timestamps reuse the durable spool entry instead of producing a false memory-only warning; other conflicting entries remain conflicts. Viewer raw-event POST 409 responses already include a target-validation `error.code` in 0.46.0; this release does not remove those checks or make the toast display the code.

Devices now shows each paired peer's sync health, last sync, and past-24-hour inbound and outbound operation counts, with an action to sync **only that selected peer**. Local, unpaired, unavailable, and stale states are labeled separately. Advanced Sync retains the deeper controls.
