# 0.46.1 release notes (draft)

OpenCode 2 observer extraction can use the signed-in OpenCode service instead of relying on the legacy `auth.json` credential file. Newly captured V2 events with implicit OpenCode credentials take the stateless service path automatically, preserving the selected provider and model. OpenCode 1 events, older unmarked events, explicit API credentials, custom endpoints, and selected sidecars retain their previous behavior. Historical recovery stays on its configured route.

Settings shows model suggestions from OpenCode's catalog and offers an on-demand synthetic model check. A listing is not a guarantee that the active connection can use that model; a failed request does not silently select another model or provider. OpenCode chooses the active account for the provider, so subscription and API billing depend on that account.

**Output limits:** The V2 stateless generation route does not accept a provider-enforced output-token cap or report token usage. Codemem limits its wait and the response size it accepts, but these do not cap upstream generation or billing. The existing Codex and Claude CLI sidecars and legacy OpenCode OAuth Codex path have the same lack of a provider-side cap. For a provider-enforced cap, configure a direct API-key observer route; direct API requests may incur separate API charges.

Other included fixes retain raw events through missing-observer-auth failures, recover historical auth gaps at a paced rate without rewinding session cursors, and apply observer Settings changes in the running viewer. Verify release CI and recovery failures before publishing this patch.
