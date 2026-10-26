# Coordinator account-management lifecycle contract

**Status:** The current V2 extension is described first. The later **Historical V3 proposal** section is inactive reference material, not the current implementation plan or authorization to resume the closed V3 rollout.

## Current V2 account-management extension

The current optional V2 extension supports verified profile display, **Refresh
profile**, and explicit **Unlink Google account**, followed by normal linking to the
same or a different Google account. It installs only through the explicit
`upgrade-account-schema` operation for an existing intact V2 coordinator; normal V2
linking does not require it. Fresh coordinators also remain V2 until the extension
is explicitly installed.

The extension moves an unlinked connection into retained history and creates a fresh,
opaque link ID for a later normal Link. It retains the original row ID, proof, and
authorship history; retaining that history is not a promise to keep the link active.
Identity, device keys, access, existing history, and permanent administrator
revocation remain unchanged. Old sessions and proofs cannot authenticate a replacement
connection. Unlink requires the currently authorized device and one local Viewer
confirmation, not Google proof. Link, relink and Refresh still require fresh Google
verification. A normal Link is the only reconnect flow—there is no
switch wizard or automatic unlink.

The Viewer shows **Refresh profile** and **Unlink Google account** only when the
coordinator reports those capabilities. **Check status** reads status; it does not
refresh profile data. Refresh has no extra confirmation. Unlink has one accessible
Viewer confirmation and opens no Google chooser, sign-in window or loopback listener.

That confirmation explains that Unlink ends browser sessions for the connection
and removes its display profile. Identity, device keys, history, membership, and
access grants remain unchanged. Cancelling the local confirmation sends no mutation.
The signed coordinator capability supplies an opaque `unlink_target` before confirmation; both
the Viewer server and coordinator reject a changed target rather than unlinking its
replacement. Without this capability the Viewer hides Unlink; it never falls back
to Google verification. Older browser-proof disconnect routes remain compatible.

`POST /v1/auth/account-unlinks` accepts exactly `{group_id, identity_id, attempt_id,
target_link_id}` through the existing Ed25519 request verifier and rate limiter.
Identity and target are comparison pins, not authority. The winning transaction
rechecks current device/group/key/Identity eligibility and permanent revocation,
archives the exact current link, invalidates its sessions and profiles, and completes
an immutable `coordinator_auth_account_connection_unlinks` receipt. It creates no
browser-attempt row and claims no provider verification.

The receipt binds the signer, configuration, target and canonical request hash,
excluding the transport nonce/signature. One exact retry with a fresh signed nonce
can recover a lost response even after relinking, without repeating effects. Replay
of a nonce is rejected. Changed requests cannot reuse a receipt. After two ambiguous
responses the Viewer retains an unknown outcome and blocks another account action;
status reads and deadlines do not authorize a retry or imply cancellation.

When the Worker's existing scheduled handler runs with browser auth disabled,
it can still scrub expired private account-change material in batches of at most
32 attempts per invocation. Keep the original `coordinatorId` alongside
`enabled: false` in its browser-auth configuration for this cleanup; issuer,
client secret, and browser CSRF key are not needed. Without a valid coordinator
ID, cleanup skips rather than guessing a scope. It preserves completed receipts,
account history, and device access, and does not mount browser-auth routes or
contact Google. This does not configure a schedule or change deployment settings.

For an existing local V2 SQLite database, operators must pause auth writers, drain
pending attempts, back up the database, then obtain approval before running:

```fish
codemem coordinator upgrade-account-schema --db-path PATH
```

The command never applies automatically and creates no backup or pause. It fails
closed when storage is only partly upgraded. Do not use the legacy
`upgrade-auth-schema` command for account management: that command is the authority
cutover, not this extension. The upgrade adds an old-binary fence; after it succeeds,
do not run an older coordinator binary against that database. Stop and inspect errors
instead of resetting, copying tables, synthesizing proof, or attempting an automatic
restore.

An intact prior 38-statement account extension takes a nine-statement atomic delta:
one receipt table, four receipt guards, replacement of the archive guard, and exact
pre/postflight checks. No existing table is rebuilt or copied. Fresh V2 installation
uses 45 statements. For D1, export the prior-extension delta with
`codemem coordinator upgrade-account-schema --export-sql --device-unlink --json`;
the default export is for V2 without the extension. Applying SQL and deploying still
require separate operator approval. Partial or unknown schemas are rejected.

The upgrade keeps the latest existing sign-in profile visible, including an empty
snapshot. It assigns baseline order one to the existing receipt only when its
coordinator, link, session, and timestamp exactly match that profile. Original
proof bytes and row IDs remain intact, and old pending browser transactions keep
NULL orders so they cannot mint new sessions after upgrade.

Administrator revocation records the observed server time and still applies when
the clock moves backward. Revoked authority never depends on timestamp ordering.

## Historical V3 proposal

The sections below are retained history for the discarded generation-based design.
They do not define the current V2 extension, authorize a migration, deployment, or
live account action.

## Purpose and boundary in the historical proposal

This contract specifies a future, user-initiated lifecycle for an account link: disconnect it, refresh its display profile, then optionally link a different provider account. It preserves the Identity, keys, history, access, and existing device-signed access model. Email, name, and picture never prove ownership.

This proposal retained the one-link, revoked-tombstone contract until a full V3 implementation and explicit lifecycle migration were approved. It did not alter revocation behavior. An admin revocation is permanent; user disconnect cannot clear, replace, or bypass it.

There is no **Switch account** operation. A person explicitly disconnects account A and, if eligible, starts a separate Link flow for account B. Leaving between those actions leaves the account truthfully disconnected. The UI must not suggest external provider sign-out as a substitute.

## Terms

- **Identity:** the existing actor-backed principal.
- **association:** immutable reservation of `(coordinator, issuer, subject)` to an Identity.
- **link generation:** one append-only period during which an association is active.
- **security revocation:** an administrator's permanent Identity-wide barrier.
- **disconnect:** the account holder's proofed request to end a live generation.
- **refresh:** a proofed update of display-only profile data for a live generation.

## Association and generation model

The lifecycle migration rebuilds `coordinator_auth_account_links` as append-only generations. It retains every existing birth column and row ID verbatim, assigning each existing row `generation = 1`. New lifecycle fields are:

| Field | Rule |
| --- | --- |
| `generation` | Positive, immutable generation number. |
| `ended_at_ms` | Null while live; otherwise write once. |
| `end_reason` | Null while live; `user_disconnected` for a user disconnect. |
| `end_attempt_id` | Null while live; immutable completed change-attempt ID when disconnected. |
| `signin_sequence_floor` | Immutable browser-sequence cutoff captured at generation commit; migrated generation 1 uses zero. |

The rebuilt table retains `PRIMARY KEY (coordinator_id, link_id)` and `UNIQUE (coordinator_id, attempt_id)`. It removes whole-Identity, whole-account, and device-claim link uniques, adds `UNIQUE (coordinator_id, identity_id, generation)`, and adds partial unique indexes allowing at most one open row per Identity and per `(coordinator_id, issuer, subject)`. An open row has both `revoked_at_ms` and `ended_at_ms` null. Link birth fields are immutable; end and security-revocation fields move only from null to final values.

`coordinator_auth_account_associations` is a new immutable table keyed by `(coordinator_id, issuer, subject)`. It stores `identity_id`, `first_link_id`, and creation time. Migration creates one association from each old link, including revoked links. Account A remains reserved for Identity A after disconnect; it cannot become Identity B's account. Association rows cannot be updated or deleted, and historical link rows cannot be deleted.

Email and profile fields are display data only. They never select an association, reserve an account, or transfer an Identity.

A `BEFORE INSERT` link trigger requires an already inserted association matching the new row's coordinator, issuer, subject, and Identity; missing or differently assigned associations abort. It also aborts if any generation of that Identity is security-revoked. Association insertion, link insertion, and finalization share one atomic batch, so a losing link cannot leave a reservation behind. These are database constraints, not only application checks.

Association and link insert-collision guards run before SQLite conflict handling, like the existing immutable device-claim guards. They reject reuse of permanent keys and eviction of an existing open row, including `INSERT OR REPLACE` when recursive delete triggers are off. Writers insert a reservation only when absent, then validate its owner; they do not replace or upsert historical rows. Exact retries return retained results rather than reinserting them.

## Security revocation remains stronger than disconnect

The existing `revoked_at_ms` remains a write-once security-revocation field and is never set or cleared by disconnect. Revoking **any** generation for an Identity immediately blocks account authentication for every generation: a current account B is also blocked when an administrator revokes an old, ended account A.

The shared live guard enforces that Identity-wide barrier for sessions, owner-account proof, readiness, and every account-authentication entry point. Rejecting only future link inserts is insufficient. Existing independent device-signed access, legacy invitations, grants derived from attestations, and consumed `team_member` memberships remain unchanged. A device claim is never an owner proof, new-grant proof, or account-invitation proof.

## Reconnect rules

Reconnect uses the existing seven-field device-signed link-creation body and a fresh normal link ceremony. The server derives `prior_link_id` and expected prior generation; callers cannot nominate a generation or elevate authority. Creation and the winning finalization each compare-and-swap the same latest ended generation. Computing a maximum generation before insertion is insufficient.

A reconnect requires all of the following:

1. no active generation for the Identity;
2. no Identity-wide security revocation;
3. the same configured issuer and an enabled, revocation-safe current signer;
4. fresh OIDC proof for the selected account; and
5. a passing current authority check.

Configuration revision rotation is allowed only if the issuer is unchanged and fresh current proofs pass. An unknown issuer change fails closed. Reconnecting creates a new link ID and cannot revive old sessions, receipts, or browser cookies.

Current session and attempt proofs always use the current revision; immutable link and genesis evidence retain their birth revisions. A fresh same-issuer proof must validate those historical records rather than rewrite their revisions or pretend they were created under the new configuration. Revision rotation invalidates old sessions and in-flight attempts, not historical associations, and never clears a security barrier.

For device-claim continuation, the server starts from the original claimed device, canonical key, and fingerprint. It reruns every current requester contradiction: enrollment and eligibility, attestation, consumed invitation, ownership binding, and committed-link history for another Identity. It does not check enrollment alone. The original claim remains immutable evidence and the new attempt gets its own audit record. Attested continuation requires a current active attestation; it never inherits an old authority kind without checking it.

### Device-claim provenance across generations

Generation 1 keeps the existing committed-claim predicate unchanged. Later device-claim generations require both that complete historical genesis proof and all of this new tuple:

- The new link points to its own finalized or session-redeemed attempt and creation audit, and to the original immutable `device_claim_id`; its controller fields are null.
- Claim and new attempt match coordinator, Identity, device, exact public-key bytes, fingerprint, and the canonical key ID checked by the signed writer. The original claim's group remains part of its genesis proof; the new attempt and audit pin the currently authorized group.
- The new attempt's issuer, verified subject, revision, finalization time, and link ID match the new link. Its issuer matches the claim's issuer; its revision and timestamps do **not** have to equal the genesis claim's revision and timestamps.
- Its immutable `prior_link_id` and prior generation identify the immediately preceding, ended generation of the same Identity. The CAS checked that relationship when this generation committed.
- A `link_created` audit matches this new link ID, attempt, Identity, group, device, fingerprint, device-claim ID, authority kind, revision, and creation time. All browser/runtime/completion commitments and the existing ordered ceremony checks are present.

Historical genesis validation is independent of normal end state and current enrollment. Account authentication separately requires the current live-generation and Identity-wide security guard; device mutations separately require current device eligibility. Never weaken the genesis join or treat an arbitrary claim row as continuation proof.

Other trusted reader devices may continue their own scoped reads. Management capabilities are derived by the server; being linked alone does not grant a device blanket account-management authority.

### Unlink and refresh authorization

Both intents use the same mandatory predicate at creation and winning finalization:

1. The target is the Identity's current live generation, the configured issuer matches, and no generation has an admin revocation.
2. The signed device is currently enabled in the selected non-archived group, its Identity assignment is valid, and its device and canonical key are not revoked. The complete current-requester contradiction checks listed above pass; a nullable legacy assignment requires the same validated assignment snapshot and statement-local freshness checks as current linking.
3. For a `controller_attestation` target, an active attestation binds the signer's exact key, fingerprint, device, current group, and target Identity. It need not be the historical origin attestation, but must be active now.
4. For a `device_claim` target, the signer is exactly the original claimed device, canonical key, public-key bytes, and fingerprint, with intact genesis/current-generation provenance. Another enrolled or shared-assignment reader does not qualify.
5. Fresh provider verification proves the target generation's exact issuer/subject, and the browser and device ceremony proofs pass.

An ownership binding (ADR 0005 Section 8 rebind) is the third form of the signer's own proof, alongside rules 3 and 4. A binding for the signer's exact device and canonical key that names the target Identity satisfies rules 3 and 4 for either target kind. It also supersedes two kinds of older history for this device. The first is legacy Team completions that included this device under another Identity. The second is this device's own claim under another Identity whose account link is no longer active. Every other requester check still applies, including an owner's exclusion of this device and legacy history for the target Identity's other devices. A shared-assignment reader without its own binding still does not qualify. Account-link status follows the same rule: such a device sees `linked` with the account profile.

All other cases deny without mutation. Google proof alone, an existing website session, a shared reader assignment, or a client-supplied role cannot substitute for this predicate. No management result upgrades a link's authority kind.

## Proofed change attempts

Disconnect and refresh use a new ten-minute `coordinator_auth_link_change_attempts` table. It records an immutable intent (`disconnect` or `refresh`), target link ID and generation, device/group/key/fingerprint tuple, purpose, verifier commitment, start-code commitment, browser-transaction reference, completion hash, config revision, timestamps, and completed receipt/audit data. Nonce and PKCE material stay in the shared browser transaction and are erased on consumption; raw provider tokens are never retained.

`coordinator_auth_browser_transactions` gains a `link_change` purpose through an explicit preserving rebuild. The migration keeps all existing rows, proofs, attempts, audits, row IDs, and pending nonce/PKCE values; it does not manufacture reviews or backfill account profile metadata. Verified display claims are staged privately against their exact attempt and target, not included in permanent completion receipts.

The browser exchange uses fresh OIDC authorization-code verification with state, nonce, and S256 PKCE. It does not promise provider password, MFA, `auth_time`, or `max_age` behavior that the provider may not support. The existing trusted account-selection prompt pattern requests account selection.

The ceremony avoids duplicate confirmations. **Connect** retains its one hosted, verified-account confirmation. **Disconnect** starts from the Viewer **Unlink** gesture, obtains fresh matching provider proof, then presents one hosted CSRF-protected confirmation showing the fresh profile and the preserved-data and session effects. The Viewer must not add a pre-OIDC confirmation dialog.

**Refresh** is a display-only Viewer action with a private, intent-pinned server-side attempt. After matching provider proof, it may enter `confirmed` and release completion automatically; it must publish only after the initiating device's signed finalization. It has no extra “Update profile” confirmation click. The shared `confirmed` state remains a proof fence for both intents: disconnect requires the browser confirmation POST, while refresh reaches it only through server-side verification of its pinned refresh intent.

The verified issuer and subject must exactly match the target live credential. Mismatch responses are generic and must not disclose the expected account. Change attempts transition only as follows:

| Transition | Required event |
| --- | --- |
| `pending` → `browser_claimed` | Bound browser claims the start code. |
| `browser_claimed` → `oidc_verified` | Fresh OIDC callback passes state, nonce, PKCE, issuer, and subject checks. |
| `oidc_verified` → `confirmed` | Disconnect: original browser confirms with CSRF and same-origin checks. Refresh: server advances only the stored refresh intent after the matching verification. |
| `confirmed` → `completed` | Signed-device finalization, runtime verifier, completion secret, current-target CAS, and intent mutation commit atomically. |

Cancellation, expiry, and failure create no lifecycle mutation. Completed receipts and audit records are immutable. Exact retries return the retained result and do not create a second end or profile write.

The cancel endpoint remains available. Browser CSRF, private start-code, state, nonce, PKCE, and literal-loopback safeguards remain unchanged. Intent is selected at attempt creation and is not a browser request-mode flag.

### Ceremony examples

**Disconnect** has one meaningful confirmation:

1. The user chooses **Unlink** in the Viewer. The client starts a `disconnect` attempt; it does not show another confirmation dialog.
2. The browser completes fresh proof for the account bound to the active generation.
3. The hosted page shows that verified account, the data that remains, and that browser sessions for this link end. Its one CSRF-protected confirmation advances the attempt.
4. The original device supplies the verifier and completion secret. The atomic finalization ends the generation and returns a completed receipt.

**Refresh** has no confirmation screen after the user chooses **Refresh**:

1. The client starts a `refresh` attempt with the target link and generation pinned.
2. The browser obtains fresh proof for that same account.
3. The server records `confirmed` for the stored refresh intent and releases the held loopback acknowledgement.
4. Only the initiating device's signed finalization publishes the snapshot.

Neither flow gains a switch wizard, a switch button, or a `switch` intent.

## Disconnect and refresh effects

A successful disconnect atomically ends the target live generation, revokes all of its browser sessions, and purges its display profile. It does not alter the association, Identity, device keys, history, membership, grants, or security-revocation state.

An ended link's session credential never becomes live again, including after a reconnect to the same provider account. A pending normal sign-in begun before the active generation was created must not mint a session for that later generation after disconnect and reconnect. The session guard needs a generation or birth-watermark fence; wall-clock timestamp ties must not let an old transaction pass. The current generic active-link lookup alone is insufficient.

The concrete fence is `browser_sequence INTEGER PRIMARY KEY AUTOINCREMENT` in the rebuilt browser-transaction table. Migration preserves each old row ID as its sequence and retains the former composite primary key as a unique key, together with every other existing unique. AUTOINCREMENT prevents reuse after transaction cleanup; subsequent copies or explicitly approved recovery must preserve its high-water mark, not infer it from surviving rows. At a new generation's atomic commit, `signin_sequence_floor` records the maximum currently allocated browser sequence for that coordinator, with a minimum of zero; ordinary sign-in may issue a session only when its transaction sequence is strictly greater. Existing migrated generation-1 links receive floor zero. This serializes the fence with transaction creation without relying on wall clocks or cancelling other accounts' transactions.

Only a receipt with `source = 'signin'` uses that sequence-floor comparison. A `source = 'link_redeem'` receipt instead proves the exact current generation's own finalized link attempt and browser transaction; its sequence is naturally at or below the floor. Both sources still require a live generation and the Identity-wide security guard.

Target-pinned owner, link, and change attempts deny when their original target generation ended, even if a new active generation has the same account. Their source target link ID participates in the final compare-and-swap. A fresh normal sign-in begun after the new connection may use that new generation. These checks do not cancel unrelated account sign-ins or global browser transactions.

A successful refresh writes a verified snapshot bound to the live generation. The newest source snapshot wins; an empty source snapshot is valid and clears old display fields. Refresh does not change the account binding or browser sessions. Existing empty profile metadata stays empty until a successful refresh; it is not synthetically backfilled.

### Audit and profile storage

`coordinator_auth_link_audit_log` keeps its existing columns, keys, and `link_created` / `link_revoked` action set, with insert-collision and update/delete guards protecting historical receipts from replacement. Completed `coordinator_auth_link_change_attempts` rows are the immutable disconnect/refresh audit receipts; they carry intent, target, signer/proof pins, and outcome, but no raw provider tokens or display payload. `end_attempt_id` must identify the matching completed disconnect receipt in the same atomic commit.

Refresh snapshots live in new `coordinator_auth_link_profile_refreshes`, keyed by `(coordinator_id, link_id)`, with `display_name`, `email`, `email_verified`, `picture_url`, `source_attempt_id`, `verified_at_ms`, and `source_order`. A refresh never invents a session ID or writes through the sign-in-only profile contract. Existing sign-in profile session/time columns stay unchanged.

Each successful V3 snapshot uses `source_order = browser_sequence + 1`, captured from its verified ceremony. Migration assigns existing link-time snapshots order zero and existing sign-in snapshots order one, preserving today's sign-in precedence, including empty snapshots. Readers select the highest committed order across link-time, sign-in, and refresh sources; all new orders exceed both legacy baselines. This is intent order, not wall-clock order: an older intent finishing late cannot overwrite a later committed snapshot. Exact retries cannot change a snapshot at the same order; timestamps are informational. Sequence/order ranges must fail closed before integer overflow.

Transient change claims reuse the sanitized link-profile staging pattern with an explicit server-selected `source_purpose = 'link_change'`, a null published link ID, and all attempt/account/config/binder pins. Initial linking uses `source_purpose = 'link'`. A management finalization copies only its matching staged payload into the refresh snapshot, then removes it; cleanup recognizes both attempt types. Completed receipts do not retain display payload. Cross-purpose or historical attempt-ID collisions deny rather than select another operation's data.

The shared activity check treats a `link_change` transaction as active only while its exact change attempt is live in `pending`, `browser_claimed`, `oidc_verified`, or `confirmed`. Missing, completed, failed, or expired change attempts are inactive after validating the transaction's coordinator/config pins. Wrong config, malformed cookies, and lookup errors still deny. GET and redirects never delete cookies; only a successful credential-bearing start POST replaces them.

No ordinary website-session completion is required. The implementation reuses the COOP-safe held-loopback acknowledgement. A disconnect receipt reports completion, not “linked,” and cannot imply that a session was issued.

## Operational authority

The lifecycle adds no operator role and does not manufacture an administrative review. The server derives change eligibility from the current signer, target generation, current authority source, and revocation checks. A client-provided role, account identifier, Identity identifier, or operation label is not authority.

Admin security revocation remains an independent administrative action. It can block the lifecycle; lifecycle requests cannot reverse it. A disconnect is an account-holder action on one live generation, not a recovery or ownership-transfer mechanism.

## Future routes and request constraints

These are V3 planned routes, not current endpoints:

| Caller | Route |
| --- | --- |
| Signed device | `POST /v1/auth/link-changes` |
| Signed device | `GET /v1/auth/link-changes/:attemptId` |
| Signed device | `POST /v1/auth/link-changes/:attemptId/finalize` |
| Signed device | `POST /v1/auth/link-changes/:attemptId/cancel` |
| Browser | `/auth/link-change/start`, `/auth/link-change/confirm`, `/auth/link-change/cancel` |

A browser completion route is optional only if an implementation needs an explicit website action; it is not required for the lifecycle. Finalization uses purpose `coordinator-account-link-change-v1` and the existing create-body field style. The server selects the target from stored attempt state, not caller privileges.

An optional management completion route must not become a mandatory hop or silently replace an unrelated current account session. GET pages and session redirects never clear a potentially newer transaction cookie. Only the exact credential-bearing successful POST may replace its old transaction cookie.

Every route keeps existing private-URL, token, rate-limit, cancellation, trusted-context, CSRF, and literal-loopback protections. Viewer profile reads and CSRF checks take context only from the trusted local source. First-connect creation keeps its seven fields; it does not gain a caller-selected generation.

Request bodies and signed fields must use the existing request-size limits and canonical-encoding rules. The path attempt ID and body attempt ID must agree. A device status read returns only the requester's attempt status; absent attempts, a different device, invalid proof, and unavailable storage receive a generic response.

| Signed route | Fields |
| --- | --- |
| Create | `group_id`, `identity_id`, `intent`, `attempt_id`, `runtime_verifier_hash`, `browser_start_hash`, `loopback_redirect` |
| Read | `group_id` query only |
| Finalize | `purpose`, `coordinator_id`, `attempt_id`, `group_id`, `identity_id`, `device_id`, `fingerprint`, `runtime_verifier`, `completion` |
| Cancel | `group_id` only |

Create accepts only `disconnect` or `refresh`; no target link, generation, Google subject, role, or authority field comes from the caller. Status never returns private browser URLs, verifier material, or completion secrets.

## Viewer contract

The future account page uses one account card: name, verified email, and photo are primary when available. It shows an honest missing-profile state with **Refresh profile**. Technical identifiers and coordinator URLs are collapsed diagnostics, not primary content. **Unlink Google account** appears only for a linked account and **Link Google account** only for an unlinked or disconnected account.

Status V3 values are `unlinked`, `disconnected`, `linked`, `revoked`, `conflict`, and `review_required`. Identity revocation has priority. `profile` is `{state:"verified", verifiedAtMs, displayName?, email?, pictureUrl?}` for the caller's active generation, or `{state:"unavailable"}`. Email is returned only when provider-verified. Server-derived `actions` contains booleans `connect`, `disconnect`, and `refresh`.

The Viewer operation intent is only `connect`, `disconnect`, or `refresh`. `switch_incomplete` is not a state. Context and coordinator IDs remain opaque API pins; raw diagnostics stay collapsed. A user gesture is required for every actual disconnect—status reads, refresh, cancellation, and UI rendering cannot unlink.

The account card must retain the honest distinction between a live linked account with `profile: unavailable` and an unlinked account. A missing profile enables **Refresh**, not a claim that the account needs relinking. A revoked or conflict state exposes neither profile fields nor a destructive action that could imply recovery.

## Schema checks and write ordering

Migration `0034` must recognize the exact predecessor DDL before any copy. It rejects unsupported shapes or attached objects on affected auth tables, external dependencies on those tables, and reserved migration objects instead of repairing them. Unrelated tables and data stay untouched. Migration-owned assertions fail the transaction when row counts, row IDs, or any preserved raw value differ.

SQLite preflight also rejects every connection-local temporary-schema object before any unqualified migration read or write. Temporary tables and triggers can shadow or alter the recognized main schema; a fresh dedicated connection must pass this check, not silently clear those objects. D1 uses the portable main-schema checks without SQLite's unavailable temporary catalog.

Preflight requires positive existing row IDs in the link and link-audit tables. A nonpositive ID, which supported writers never allocate, stops migration for review rather than being renumbered: SQLite's undefined pre-insert row-ID sentinel must not collide with preserved history.

The copy preserves old link IDs, creation values, authority references, device-claim references, proof commitments, attempt records, audit records, browser-transaction secrets, and profile rows. It then creates associations with the old issuer, subject, Identity, first link ID, and creation time. It must reject a duplicate or inconsistent old association rather than pick a winner.

Install the new link-insert, session/receipt, and genesis guards only after copying historical rows, backfilling associations, and passing the preservation checks. They must not reject legitimate historical revoked rows or require reservations before the migration has built them. Finish guard installation and readiness assertions within the same atomic upgrade before any lifecycle writer can run.

New triggers reject updates and deletes of associations and link birth values, enforce association/Identity-revocation checks on link inserts, and reject session or session-receipt inserts for non-live or security-blocked generations. They allow only the defined monotonic end and security-revocation writes. Session and profile queries join a live generation, its association, and the Identity-wide security barrier in their same authoritative statement.

Writers must avoid an insert when an exact audit receipt already exists; `ON CONFLICT DO NOTHING` alone still reaches the collision guard. In particular, repeated admin revocation must return its retained result without trying to reinsert `link_revoked`.

The winning disconnect transaction checks the target link ID, generation, open state, current config, current signer, current authority, browser confirmation, runtime verifier, completion secret, and barrier. It ends the generation, revokes its sessions, deletes its display profile, writes the receipt and audit, and marks the attempt completed as one atomic effect.

The winning refresh transaction checks the same live target and proofs, writes only the generation-bound snapshot and immutable receipt/audit, then marks the attempt completed. A stale or already ended target makes either transaction fail closed without a partial profile or session change.

## Migration and activation boundary

The explicit future lifecycle migration is `0034`. Its inventory is:

| Object | Change |
| --- | --- |
| `coordinator_auth_account_links` | Preserving rebuild: generation/end fields and `signin_sequence_floor`, retained primary/attempt keys, partial open-row uniques, insert and immutability guards. |
| `coordinator_auth_browser_transactions` | Preserving rebuild: monotonic `browser_sequence`, `link_change` purpose, retained composite and other uniques. |
| `coordinator_auth_link_attempts` | Add nullable server-selected `prior_link_id` and `prior_generation`; existing rows retain null continuation fields. |
| `coordinator_auth_account_associations` | Add and backfill immutable provider-to-Identity reservations. |
| `coordinator_auth_link_change_attempts` | Add proofed disconnect/refresh attempts and immutable completion audit receipts. |
| `coordinator_auth_account_profiles` | Add `source_order` with legacy baseline one; retain all existing session/time/data columns. |
| `coordinator_auth_link_profiles` | Add `source_order` with legacy baseline zero and `source_purpose`; preserve all existing payload/pins. |
| `coordinator_auth_link_profile_refreshes` | Add attempt-sourced refresh snapshots with monotonic source order, never fabricated session provenance. |
| `coordinator_auth_link_audit_log` | Keep columns, keys, and action checks; add immutable-receipt collision and update/delete guards. |
| Device-claim proof guards | Add the first-generation insert guard below; retain all old proof rows and original guards. |
| Sessions and session receipts | Add live-generation/security-barrier insert guards and the ordinary-sign-in sequence fence. |

Readiness inspects the actual expected tables, columns, indexes, triggers, and checks, not a ledger number. Fresh stores initialize **the V3 lifecycle schema**. For a populated predecessor auth schema, store open never rebuilds or creates shadow legacy tables: account-auth operations return upgrade-required while ordinary device-signed sync remains available.

The schema also enforces an older-binary fence. Add a device-claim `BEFORE INSERT` proof guard requiring a matching winning first-link attempt with null continuation pins, device-claim authority, finalized state, matching Identity/device/key/fingerprint/issuer/revision/creation pins, and its generated claim/link ID. Continuations reuse the original claim and cannot mint another genesis claim. This additional guard changes the device-claim table's trigger count from three to four, so the frozen pre-V3 readiness predicate fails its exact three-trigger check. Old `CREATE ... IF NOT EXISTS` initializers cannot remove that guard or restore readiness. V3 checks the updated exact guard set; predecessor recognition and migration definitions remain separately frozen.

Tests must execute the frozen predecessor readiness SQL against both fresh and upgraded V3 schemas, including after rerunning predecessor initialization statements, and prove it still refuses account authentication. An operational instruction not to run old code is not the fence.

The migration validates recognized DDL and dependencies, preserves every old raw row, row ID, proof, browser secret, attempt, and audit, and backfills associations exactly. New code stays gated until the full stack and explicit operator migration are ready. The unreleased V2 line can move to coordinated V3 without compatibility shims; no live migration or deployment is approved here.

D1 execution must remain one atomic batch. Before approving a remote run, confirm the target's query budget, statement accounting, and total batch-size limit with Cloudflare; local native tests do not verify those production limits. Every statement must fit the documented 100,000-byte limit. Do not split the upgrade across batches or change billing to bypass an unverified limit.

After lifecycle writes, an old binary must not run because its owner queries ignore ended generations. There is no automatic backup restore, Time Travel restore, or table drop, even before a lifecycle write: those actions can discard unrelated traffic. If needed, operators may disable browser authentication only with explicit approval, preserve rows, and fix forward. Data restoration is a separately informed and approved recovery decision.

## Required validation

The implementation test matrix covers source constraints and exact migration preservation; account-A reservation against another Identity; revocation of current and historical generations; two concurrent reconnects with one CAS winner; and A-to-B disconnect then reconnect with old cookies dead.

It also covers wrong-A proof, missing or revoked proof, canonical-key aliases, requester contradictions, config rotation, cancellation, expiry, exact retry, refresh that clears an old profile, stale context, popup blocking with a real browser and COOP, role exclusions, and native D1 execution depth. Denials must not leak account values.

| Case | Expected result |
| --- | --- |
| Old ended A is admin-revoked while B is active | All account-auth guards for the Identity deny immediately. |
| Two reconnect finalizations race | One target CAS wins; the other has no link, session, or profile effect. |
| A disconnect succeeds, then B connects | A's association remains with the original Identity; old A cookies are dead. |
| Refresh returns no profile fields | The active binding remains live and the stored display snapshot becomes empty. |
| A target or context becomes stale | Finalization denies without changing a generation, session, or profile. |
| Pending sign-in callback predates a disconnect/reconnect | It cannot mint a session for the later same-account generation. |
| Old and new attempts have identical clock timestamps | The generation fence still rejects the old attempt. |
| Transaction cleanup deletes the highest allocated sequence | The next sequence is higher; neither session nor profile fences regress. |
| A reconnect points to a claim from another Identity or key | Full genesis and continuation tuples reject it without data disclosure. |
| A completed link-change cookie remains in the browser | A new eligible start can replace it without any stale-response deletion. |
| `INSERT OR REPLACE` targets a reservation, generation, or audit receipt | It aborts before an implicit deletion, even with recursive triggers off. |
| Old optional link-session redemption or owner commit resumes | It denies when its pinned source generation ended. |

Browser tests must verify that disconnect has exactly one hosted destructive confirmation after provider proof, refresh has no extra confirmation, and connect retains its existing single hosted confirmation. They must also verify that GET and redirects leave a newer browser transaction cookie intact, while only the matching successful credential POST can replace it.

Callback handlers prepare the complete response before committing verified or confirmed state. The winning write rechecks current authority; a failed preparation leaves no committed completion secret. Network delivery can still fail after commit. Disconnect confirmation likewise renders its completion page before committing, so a rendering failure can be retried with the same confirmation form.

Run the isolated synthetic-provider Chromium suite after `pnpm run build` with `pnpm --filter @codemem/ui test:account-browser`. Install its pinned browser first with `pnpm --filter @codemem/ui exec playwright install chromium` if needed. Normal CI runs this suite in the separate Account Browser Acceptance job. It uses no live Google account or cloud coordinator, and writes generated results under the ignored `.tmp/` directory.

## Exclusions

This proposal does not add account recovery, identity transfer, provider-account reassignment, a personal/work identity split, new device enrollment, account-derived grants, or a role-management surface. It does not alter normal device-signed sync, existing access decisions, or historical authorship.

It does not authorize a migration run, remote database operation, provider enablement, browser route publication, release, or production verification. Those decisions require separate implementation and operator approval after the contract is reviewed.

## Alternatives

Append-only generations are recommended because they retain account history while making session invalidation and reconnect races explicit. A separate connection-ID table adds a larger rewrite surface. Mutating a link row loses history and risks session revival, so it is rejected.

This contract references [ADR 0005](../adr/0005-authenticated-identity-device-and-membership-lifecycle.md). The ADR is not changed until a durable lifecycle decision receives final review.
