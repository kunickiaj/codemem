# Cloudflare Worker + D1 coordinator deployment

Use this runbook when you specifically want to deploy the coordinator discovery contract on Cloudflare Workers + D1.

This is the canonical Cloudflare deployment reference for the current TypeScript worker path. It is still a secondary
deployment target behind the built-in coordinator service in `codemem coordinator serve`, but if you are choosing
the Worker path, this document is the source of truth.

## What this deploys

Current source-of-truth files:

- Worker entrypoint: `packages/cloudflare-coordinator-worker/src/index.ts`
- Worker request verifier: `packages/cloudflare-coordinator-worker/src/request-verifier.ts`
- D1 schema: `packages/cloudflare-coordinator-worker/schema.sql`
- Example Wrangler config wrapper: `examples/cloudflare-coordinator/wrangler.toml.example`

The example wrapper is the only deployment template. The package's `wrangler.jsonc` is the checked-in local-test and bundle-validation configuration with a placeholder database ID; do not edit it with a production database ID. Keep real deployment configuration in the ignored `examples/cloudflare-coordinator/wrangler.toml` file.

The Worker currently provides:

- signed `POST /v1/presence`
- signed `GET /v1/peers`
- D1-backed device enrollment
- invite creation/import flows
- join request review flows
- reciprocal approval persistence in schema
- nonce replay protection

It does **not** relay memory payloads or replace direct peer-to-peer sync.

## Before you start

Recommended sequence:

1. validate the built-in TypeScript coordinator flow first via `docs/coordinator-e2e-runbook.md`
2. deploy the Worker only after the local TS path is already behaving correctly

If the basic coordinator flow is broken locally, the Worker path will mostly just make the debugging more annoying.

## Prerequisites

- Cloudflare account with Workers + D1 enabled
- Wrangler installed and authenticated
- a local codemem install with a real device identity
- a public or shared-network Worker URL that teammate devices can actually reach

Install and log into Wrangler:

```fish
npm install -g wrangler
wrangler login
```

## 1. Create the D1 database

```fish
wrangler d1 create codemem-coordinator
```

Copy the returned database id.

## 2. Create a real Wrangler config

Start from the example wrapper config:

```fish
cp examples/cloudflare-coordinator/wrangler.toml.example examples/cloudflare-coordinator/wrangler.toml
```

Then replace `REPLACE_WITH_D1_DATABASE_ID` in `examples/cloudflare-coordinator/wrangler.toml` with the real D1 id.

That file points at the live Worker package source, not a separate example implementation:

- `main = "../../packages/cloudflare-coordinator-worker/src/index.ts"`

The current Worker path uses the Worker-native WebCrypto request verifier in
`packages/cloudflare-coordinator-worker/src/request-verifier.ts`, but the checked-in Worker config still keeps
`nodejs_compat` enabled for now because the shared coordinator code path still pulls in some transitive `node:*`
dependencies during Worker startup.

## 3. Set the admin secret

Admin operations use a separate secret header path. Set it before deploy:

```fish
wrangler secret put CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET --config examples/cloudflare-coordinator/wrangler.toml
```

This secret is required for admin routes such as invite creation and join-request review.

## 4. Optional Google owner authentication

This optional Worker route supports owner admission from an existing reviewed profile. The source remains unreleased;
no live deployment or device onboarding is authorized. Operator deployment, D1 setup, and approval remain separate work.

When this route is available, its non-secret configuration will be loaded from
`CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG` as JSON:

```json
{
  "enabled": true,
  "ownerEnrollmentEnabled": true,
  "coordinatorId": "your-coordinator-id",
  "issuer": "https://accounts.google.com",
  "clientId": "your-google-client-id",
  "redirectUri": "https://your-worker.example.workers.dev/auth/callback",
  "revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

- `enabled` and `ownerEnrollmentEnabled` are booleans.
- `coordinatorId` must retain the namespace used by existing coordinator authority and Team decisions. Inspect that
  stored authority before choosing it; a new identifier must not bypass existing exclusions or revocations.
- `issuer` must be exactly `https://accounts.google.com`.
- `redirectUri` must be an HTTPS authentication callback URL.
- `revision` must contain 64 lowercase hexadecimal characters.
- Keep `CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET` separate from that JSON. Set
  `CODEMEM_COORDINATOR_BROWSER_CSRF_KEY` separately to a stable 64-character lowercase hexadecimal value representing
  32 cryptographically random bytes; it must remain the same across Worker isolates.

Owner enrollment will require an existing linked Google account and an explicit grant for an eligible coordinator
group. It will not grant access by email matching, create a team, transfer legacy ownership, or create automatic
grants. Before moving an existing CLI profile to this flow, an operator must review its current coordinator enrollment;
stop the transition if it conflicts with the existing enrollment.

Admin-issued owner-enrollment capabilities are signed, bound to one exact signed start value, and short-lived. They do
not allow arbitrary anonymous writes. The admin endpoints are server/admin calls, not browser calls:

- `POST /v1/admin/owner-enrollment-capabilities` with `{ "start": { ... } }`. The `start` object contains exactly six
  string fields: `attemptId`, `deviceId`, `publicKey`, `loopbackRedirect`, `browserStartCode`, and `signature`.
  Submit the prepared signed object unchanged; `publicKey` uses canonical `ssh-ed25519 BASE64` spelling without a comment.
- `POST /v1/admin/identity-group-grants` with `{ "attestation_id": "..." }`

They use the `X-Codemem-Coordinator-Admin` header, must not include a browser `Origin` header, and never create
automatic grants.

Controller review previews at `POST /v1/admin/auth-controller-reviews` include
`legacy_history`: the complete retained Team history relevant to the selected
device and its verified key aliases. Review it before confirming; the
`evidence_digest` includes that history, and newly relevant records or key bindings
invalidate the approval.

Malformed relevant history returns `needs_review` with `legacy_history_invalid`
instead of permitting confirmation. Historical labels do not themselves grant
account authority or Team access.

For the grant endpoint, the maintained operator wrapper is `codemem coordinator grant-identity-group <attestation-id>`.
Use the stored `controller-v1:` reference returned by confirmed `review-device-owner`, with the same coordinator
configured in the existing operator configuration. The wrapper keeps the admin credential out of arguments and
output, refuses redirects, and defaults confirmation to **No**. `--json` and noninteractive calls send no request.
It grants transport enrollment eligibility only, not Team/Project access; it does not run Google or alter a local
profile. See the [first-owner bootstrap recipe](user-guide.md#first-owner-bootstrap-before-teams).

Use the maintained CLI in three steps:

1. **Pause capture, then review and prepare.** Stop this profile's capture plugin, viewer, and sync daemon until the
   command reports `Verified coordinator Identity`. Run `codemem coordinator enroll-owner <group> --prepare --config <path>
   --db-path <path> --keys-dir <path>`. It prints the current identity, device, public key, own and foreign memory counts,
   the review digest, and the private request-file path. It writes
   `capability-request.json` in owner-enrollment state beside the database by default; use
   `--state-dir <new-private-directory>` to select a fresh private directory instead. The file contains the private
   browser-start code; do not print it or paste it into chat.
2. **Request operator admission.** Review the output, then submit the unchanged private request file to the capability
   admin endpoint. Do not send client secrets or capability material in chat, and do not put admin secrets in a curl
   command.
3. **Confirm in Google and resume interactively.** Run the same command with `--resume`, `--review-digest <digest>`,
   and the required `--capability` flag. Obtain and supply the capability outside chat or shared command transcripts.
   Resume retains the final exact request. After a final request and receipt are retained, an unchanged retry or a
   configuration-only retry does not need `--capability` again.

If a start succeeds but no final request is saved, retrying that start is not recovery. Retain the old state and prepare
a new attempt in a new `--state-dir`; do not delete or replace an existing final request after an ambiguous response.

The implementation preserves keys, devices, authorship, history, and unrelated configuration. It populates bootstrap
state only when it has immutable creation proof; it does not populate existing identity devices or access authorities,
infer managed authority or private history, or create automatic grants. A denied already-enrolled coordinator key does
not transfer legacy ownership automatically.

Eligibility for an existing profile remains unknown until it is checked on the real device. Google confirmation and the
normal device finish line have not been verified in a live workflow.

Before account admission, the operator must create the first Worker group and enrolled device in D1, then use the
[first-owner bootstrap recipe](user-guide.md#first-owner-bootstrap-before-teams). It covers the separate local review,
the returned `controller-v1:` reference, the explicit transport grant, account linking, and `enroll-owner` preparation
and resume. `--account-admission` requires a verified management session, an active reviewed account link, and an
eligible existing group grant; it does not create them.

## 5. Apply the D1 migrations

The example Wrangler template already sets `migrations_dir`. For a new database, prefer applying the complete migration
history through `0031`, which adds the owner-auth audit table, so migration records support later upgrades.
`packages/cloudflare-coordinator-worker/schema.sql` also includes the complete owner-auth tables and can initialize a
fresh database; using it directly does not record which migrations were applied.

For a **new, empty database only**, run this from the repository root after setting the real database ID in the ignored
deployment config:

```fish
pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 migrations apply codemem-coordinator --remote --config ../../examples/cloudflare-coordinator/wrangler.toml
```

For a database originally created from `schema.sql`, first compare its schema with the migration history and review
the migration records. Baseline only the migrations whose changes are already present, then apply the remaining
migrations; do not replay from `0001` or reset the database to make the migration bookkeeping match.

### Device rebind storage (0038)

Migration `0038_add_device_rebind.sql` adds two tables for signing in on a device whose
Identity differs from the account's (ADR 0005 Section 8): rebind attempts and their audit log.
It only creates tables, indexes and triggers; it changes no existing table or row. Nothing
writes to these tables until the rebind routes ship. Apply it with the usual migration
command after separate approval; a self-hosted SQLite coordinator creates the tables when it
opens.

### Durable ownership bindings (0039)

Migration `0039_guard_device_ownership_rowid.sql` replaces one trigger on the ownership
bindings table so `INSERT OR REPLACE` can't remove a binding by reusing its row ID. It changes
no rows. A database built from `schema.sql` without migration records can run the file directly
with `wrangler d1 execute --remote --file`; a self-hosted SQLite coordinator upgrades the
trigger when it opens.

### Device self-binds (0040)

Migration `0040_allow_device_self_bind.sql` rebuilds the rebind attempts table without the
check that kept the target Identity different from the current one, so a device can sign in
with the account already linked to its own Identity. It keeps every row, index, and trigger.
Apply it before deploying a Worker that offers self-binds. A self-hosted SQLite coordinator
rebuilds the table when it opens.

## 6. Deploy the Worker

### Owner admission pin source (not activated)

Migration `0034_add_owner_admission_pin.sql` adds the nullable immutable `admission_owner_hash` birth fact and
UPDATE/REPLACE protections. Fresh SQLite and Worker DDL include the same column and triggers. Existing attempts
retain NULL, meaning the existing v1 operator flow; do not backfill pins or edit migrations 0029/0030.
Existing databases require explicit upgrade before using owner enrollment: owner runtime operations refuse a table
without the pin column or both immutable-pin triggers, before production provider discovery. Production composition
stays lazy. Normal SQLite startup and legacy signed/direct coordinator operations remain available without this
optional upgrade; startup leaves
an existing owner-attempt table unchanged.
There is no automatic ALTER, owner conversion, or migration command in this slice. After separate approval,
pause writers, back up the database, review its exact schema/migration records, and apply the source SQL explicitly
before starting upgraded readers/writers. Do not replay it against an already upgraded or fresh database.

The internal `startOwnerBound` method verifies v2 admission against server-resolved account/link facts before
inserting a non-NULL pin. Only the trusted browser admission handler calls it; it is not a public JSON endpoint.
Public starts and operator issuance remain v1-only.
Fresh OIDC must independently resolve the same issuer, subject, Identity and exact active controller-attestation
link; confirmation and atomic finalization repeat the pin and live-link checks. No new identity
source, device-claim owner support, deployment, or live provider workflow is included.

### Owner browser admission Worker source (not activated live)

The internal `createOwnerBrowserAdmissionHandler(options)` factory returns an async
`(request, trustedClientKey) => Response | null` handler. It matches only `/auth/owner/admit`, returns
NULL for other paths, and returns 404 when its explicit owner opt-in is off. It captures current browser
configuration and rejects an OIDC callback collision. The configured Worker mounts this fixed path before
browser-app setup or OIDC discovery, only when authentication and `ownerEnrollmentEnabled` are both enabled.
Default and explicitly disabled configurations return 404; invalid or missing required settings fail closed.
The path is reserved against OIDC callback configuration. Existing operator routes and client behavior are unchanged.

The handler requires an existing management session from `/auth/sign-in`, an active exact
controller-attestation link, and an eligible trusted group grant. It uses the existing management-session
provenance and connection-revocation predicates, without requiring the old controller device to remain enrolled.
POST repeats the grant exclusion predicate for the uploaded device and canonical key. The trusted internal
`sessionCookieHash` start option repeats this authority check in the winning attempt INSERT, including exact
link, Identity, issuer, subject, current config and session expiry. Public start JSON cannot supply that option.

GET renders a session-CSRF multipart form. POST accepts exactly `csrf` (string) and `request` (File), with
the existing private `capability-request.json` format `{ "start": { ...six signed string fields... } }`.
The dedicated reader limits the entire multipart body to 16 KiB before calling `formData()`; ordinary browser
forms retain their 4 KiB limit. Invalid UTF-8, duplicate JSON/form fields and extra fields fail closed.
Client and Identity rate limits share the configured Worker's existing per-isolate limiter with the owner HTTP
and browser composition, not a fleet-wide quota. The real D1 backend and `AuthSessionOperations.readAuthSession`
read the current captured config; GET admission may read D1 but never starts provider discovery.

The initial button explicitly authorizes a request after local review. A signature proves key possession,
not that the key belongs to this computer. The form warns against uploading someone else's file; the next
page displays the exact device ID and canonical-key fingerprint before fresh OIDC and existing confirmation.
Session-scoped CSRF protects this explicit action; the existing attempt-ID tombstone makes the signed start
one-use. No separate pending-upload job or digest credential is created. V2 capability issuance and consumption
stay server-side; only a newly started result renders the existing start-cookie/CSRF form, never an old attempt.

The lazy `getEnrollment` dependency reuses the exact owner HTTP composition/backend, CSRF key, admission key,
provider options and limiter. Only validated session/link/grant/upload admission initializes it; denied requests
cannot initialize a provider, start an attempt, or reset shared quotas. No migration runs automatically.
This source change does not approve or perform migration 0034, live Google validation, configuration changes,
secret access, or deployment.

The maintained client has explicit `--account-admission`: it binds its receiver and retains its start marker before
displaying the fixed admission path, omits the operator capability and initial start POST, and retains final/receipt
retries. It does not make ordinary `device_claim` authority available. End-to-end CLI acceptance against a live Worker
has not yet been validated.

### Linked-account display metadata rollout

Migration `0033_add_auth_link_profiles.sql` adds an empty display-only table. Review and apply it before deploying
upgraded Worker readers and writers; both require the new table and report a schema upgrade error when it is absent.
Pause auth writers and back up the database first. This change includes
source SQL only: it does not apply a migration or deploy a Worker. SQLite coordinators create the empty table during
normal schema initialization. Existing links receive no backfill; they remain without display metadata until an
explicit verified sign-in refreshes their profile.

Only verified callback claims are staged, tied to the exact attempt, issuer, subject, browser transaction and auth
configuration. Finalization promotes them in the same transaction as the account link. Cancelled, failed, expired,
conflicting or mismatched attempts cannot publish a profile. Maintenance removes failed/expired/config-changed
staging and revoked-link snapshots; authenticated revocation cleanup also purges promoted display rows. Readers
must join promoted rows to the matching live account link, and never return private staging. Explicit sign-in
snapshots take precedence, including an intentionally empty snapshot. Names, email and pictures are display hints,
not identity or permission evidence. No coordinator browser session is required to persist a successful link profile.

### Optional account-management extension

The current V2 extension adds profile refresh and explicit unlink/reconnect support without changing normal V2 linking. It is not the legacy authority cutover and it is not the deferred V3 generation migration. For an existing intact V2 database, pause auth writers, drain pending attempts, back up the database, obtain approval, and use the local CLI only for a local SQLite coordinator:

```fish
codemem coordinator upgrade-account-schema --db-path PATH
```

The command does not pause writers, create a backup, or apply itself by default. Its D1 export opens no database:

```fish
codemem coordinator upgrade-account-schema --export-sql --json
```

It returns `{ "statements": [...], "applied": false }`. Plain output warns that the whole statement array must run in **one atomic D1 binding batch**; do not add `BEGIN`/`COMMIT`, split it into chunks, or treat Wrangler `execute` or migrations as a safe apply path here. Remote query and batch limits are not verified by this export.

The default export installs the extension on V2 without account management (45 statements).
For the intact prior 38-statement extension, export the nine-statement device-only
unlink delta instead with `codemem coordinator upgrade-account-schema --export-sql --device-unlink --json`.
The delta adds one receipt table and its guards and replaces the archive guard;
it does not rebuild tables or change existing rows. The local SQLite command detects
either supported starting schema. Both exports reject partial or unknown schemas
inside the atomic batch. Backup, live SQL application and deployment remain separate
operator actions requiring approval; exporting does not perform them.

Apply the atomic delta and deploy the new Worker in the same paused-writer window,
then resume writers: old binaries reject the new schema, and new binaries reject
the prior 38-statement schema. Do not roll back to an old binary after applying the
delta or creating new unlink receipts.

On any error, stop and inspect the database rather than resetting tables, copying data, synthesizing proof, or restoring unrelated traffic. The extension retains original link rows, IDs, proofs, and history; it does not backfill old browser orders.

Existing sessions remain valid until unlink or administrator revocation, but old pre-upgrade transactions without an order cannot create a new session. After the upgrade, do not run an older coordinator binary against the database.

### Optional owner-resolution receipt storage

The explicit `--owner-resolution` mode adds only the reviewed 0037 receipt table,
indexes and immutability triggers. It requires the **current account-management
schema** first; for an older supported SQLite coordinator, use the normal
`upgrade-account-schema` command before this mode. Pause auth writers, drain pending
attempts, back up the coordinator database and obtain separate approval before applying:

```fish
codemem coordinator upgrade-account-schema --owner-resolution --db-path 'coordinator.sqlite'
codemem coordinator upgrade-account-schema --owner-resolution --export-sql --json
```

Local installation accepts only an explicitly selected existing regular SQLite file,
not a symlink, URI or in-memory database. Use a trusted maintenance account that owns
the file and its containing folder. The file and folder must not be group- or
world-writable; ancestors must belong to that account or root and must not permit
other accounts to replace path components. Root-owned sticky temporary directories
are accepted only above a protected operator-owned subdirectory, not directly above
the database. Normal system parent aliases, such as macOS's temporary-directory
alias, are supported. The command checks ownership and permission bits without
changing them; platforms without the required ownership information are rejected.

The command snapshots the regular file's identity and metadata, resolves its canonical
path, and rechecks both the original and canonical routes before opening, after opening,
before the transaction and immediately before receipt DDL after asynchronous readiness
checks. It also checks that SQLite reports the selected canonical main filename.
Observed replacements, redirects or permission changes abort with an error asking the
operator to inspect the selection and retry from a protected folder. An unsafe initial
location is rejected before opening; post-open failures close the connection.

These checks **do not prove the identity of SQLite's opened file descriptor**. The
driver exposes a filename, not that descriptor's identity. A hostile process running
as the same account can still swap and restore files between checks, including WAL
companions; WAL is not protection against this race. Permission bits also do not
fully describe ACLs or every platform/filesystem's replacement rules. Stop all other
writers and ensure no untrusted process can change the file, companions or path during
maintenance. Inspect ACLs separately where applicable; do not run this command in an
untrusted location or treat these checks as a security boundary against that account.

It holds an IMMEDIATE transaction before
checking readiness, installs the shared statements only when receipt storage is
missing, verifies the exact result before committing, and rolls back on failure.
An exact installed schema is a no-op; partial, unknown or colliding definitions are
rejected without repair. Existing rows and file permissions remain unchanged. This
installs empty historical receipt storage, not owner records or authority, and does
not resolve an owner, change access or ship a recovery UI. Runtime requests and normal
store startup do not install this schema.

The command does not pause writers, drain attempts or create a backup. D1 export
returns the shared 0037 statement boundaries as `{ "statements": [...], "applied": false }`;
it opens no database, ignores environment database defaults, applies nothing and
does not check remote schema prerequisites or execution limits. Before separately
approved D1 application, verify the current account schema and that receipt storage
is missing or exactly matches the reviewed definitions; do not use this SQL to repair
a partial or unknown installation. Execute the full array in **one atomic D1 binding
batch**, not split requests, and do not add `BEGIN`/`COMMIT`. `--export-sql` rejects
`--db-path` and its `--db` alias; `--owner-resolution` rejects `--device-unlink`.

### Account-owner recovery review

The Viewer recovery UI and this scoped review path first shipped in client
**0.47.0-beta.4**. Installing the client does not upgrade a coordinator. Do not
offer this workflow to users until the coordinator upgrade and live rollout are
separately approved.

After the receipt-storage upgrade, an actual coordinator administrator can review an
existing linked account owner through authenticated `POST /v1/admin/auth-controller-reviews`.
Use the selected operator profile's existing server-side admin configuration
(`CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET` or `sync_coordinator_admin_secret`); never put
that credential in a browser field, support request, or copied reply. The operator must
preview the current full history and target with `purpose` `existing_account_owner` and
`resolution_scope` `historical_included_owner_labels_only`, then confirm with the
distinct fresh `confirm_owner_resolution_digest`. `review-device-owner` does not expose
this scope or confirmation flag, so its ordinary approval cannot complete owner recovery.

A scoped review can create or reuse the administrator's normal device approval as
well as the immutable owner resolution. Existing coordinator permission checks still
govern that approval; the separate owner-display result is not a management capability.

For a requester without that operator configuration, convert the confirmed HTTP
response into this exact noncredential reply for **Verify operator reply**. HTTP response
names map as follows: `coordinator_id`, `device_id`, `fingerprint`, `identity_id`,
`group_id`, `attestation_id`, `recovery_receipt.review_receipt_id`,
`recovery_receipt.evidence_digest`, `owner_resolution.resolution_id`, and
`owner_resolution.evidence_digest` become the camel-cased reply fields below.

```json
{
  "version": 1,
  "purpose": "existing_account_owner",
  "scope": "historical_included_owner_labels_only",
  "coordinatorOrigin": "https://coordinator.example.test",
  "coordinatorId": "coord-demo",
  "deviceId": "device-demo",
  "fingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "ownerIdentityId": "identity-existing",
  "groups": [{ "groupId": "group-demo", "attestationId": "attestation-demo", "reviewReceiptId": "review-demo", "reviewEvidenceDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "resolutionId": "resolution-demo", "resolutionEvidenceDigest": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" }]
}
```

These IDs and digests are synthetic. Receipt references are query selectors, not
credentials or proof. The requester backend fetches fresh signed status for the exact
receipt and owner before retaining anything locally. Partial, lost, or unknown results
stay per group; inspect current status and make a fresh preview when the target changes.

### Deploy after separate approval

Only after any required schema apply is complete and deployment is approved, run
from `examples/cloudflare-coordinator/`:

```fish
wrangler deploy
```

Expected result:

- Wrangler prints a `https://...workers.dev` URL
- that URL becomes `sync_coordinator_url`

## 7. Enroll the first device

The Worker path assumes explicit operator-managed enrollment in D1. The old Python bootstrap helper has been archived with
the legacy runtime, so the current path is manual.

Generate or write SQL that creates the group and inserts the enrolled device row:

```sql
INSERT INTO groups(group_id, display_name, created_at)
VALUES ('team-alpha', 'Team Alpha', CURRENT_TIMESTAMP)
ON CONFLICT(group_id) DO NOTHING;

INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, display_name, created_at)
VALUES (
  'team-alpha',
  'device-1',
  'ssh-ed25519 AAAA... user@host',
  'SHA256:...',
  'laptop',
  CURRENT_TIMESTAMP
);
```

Apply it:

```fish
wrangler d1 execute codemem-coordinator --remote --command "<paste generated SQL here>"
```

## 8. Configure codemem clients

Admin device example:

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://your-worker.example.workers.dev",
  "sync_coordinator_group": "team-alpha",
  "sync_coordinator_timeout_s": 3,
  "sync_coordinator_presence_ttl_s": 180,
  "sync_coordinator_admin_secret": "<same secret you stored with wrangler secret put>"
}
```

Teammate device example:

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://your-worker.example.workers.dev",
  "sync_coordinator_group": "team-alpha",
  "sync_coordinator_timeout_s": 3,
  "sync_coordinator_presence_ttl_s": 180
}
```

## 9. Validate the deployment

There is no longer a repo-shipped Python smoke-check script. Validate the Worker with real codemem clients instead:

- configure an admin device against the deployed Worker
- confirm the device can complete presence + peer discovery through normal codemem flows
- then run the invite and join checks below

Treat the deployment as minimally valid only when a real client can register, discover peers, and complete the onboarding
flow below.

No live Google configuration, deployment, or migration has been applied as part of this code-in-progress route. Do not
consider the normal device finish line verified until an approved live workflow completes it.

## 10. Validate invite and join behavior

After smoke validation, confirm the actual onboarding flows.

Expected admin flow:

- admin device can create an invite against the deployed Worker
- invite payload contains the real reachable Worker URL

Expected teammate flow:

- teammate imports the invite successfully
- `sync_coordinator_url` and `sync_coordinator_group` are set automatically
- `auto_admit` invites complete enrollment immediately
- `approval_required` invites leave the teammate pending until review

Expected approval flow:

- admin can list pending join requests
- admin can approve or deny them
- after approval, both devices appear in coordinator-backed discovery

Expected reciprocal-approval behavior:

- devices can progress through the current reciprocal approval flow without schema/runtime errors
- discovery success still does not create a direct `sync_peer` automatically; acceptance and scope review remain separate

If you need the exact end-to-end acceptance path after enrollment, use `docs/coordinator-e2e-runbook.md` for the direct
sync steps.

## Troubleshooting

### `missing_d1_binding`

The Worker is running without the `COORDINATOR_DB` binding.

Check:

- `examples/cloudflare-coordinator/wrangler.toml` has the real D1 id
- you deployed with the right Wrangler config
- the binding name is still `COORDINATOR_DB`

### `missing_headers`

The request did not include the required signed auth headers.

Use codemem-built clients. Plain curl requests against signed endpoints will fail.

### `unknown_device`

The device id is not enrolled in the target group.

Confirm the D1 row exists in `enrolled_devices` for the exact `group_id` and `device_id`.

### `invalid_signature`

The enrolled public key does not match the device actually making the request, or the stale device record is wrong.

Common fixes:

- re-enroll the device with its current public key
- delete stale enrollment rows and bootstrap again cleanly
- confirm the Worker URL and signed path/query are the ones the client is actually using

### Invite import or join request times out

The embedded `sync_coordinator_url` is reachable from your machine but not from the teammate device.

Recreate the invite with the real public/shared-network Worker URL.

### Cloudflare 1010 or other edge-blocking behavior

Cloudflare is blocking the request before it reaches the Worker.

Check Cloudflare security/bot settings for the zone and test again with the same signed request path used by a real
codemem client.

### Wrong schema or partial schema

If invite, join-request, or reciprocal-approval flows fail even though `presence` and `peers` work, you probably
applied the old example schema instead of `packages/cloudflare-coordinator-worker/schema.sql`.

### Placeholder all-zero D1 id still present

If `00000000-0000-0000-0000-000000000000` is still in Wrangler config, you deployed a placeholder config. Replace it
with the real D1 id and redeploy.

## Current limitations

- the Worker path is still secondary to the built-in coordinator runtime
- enrollment remains operator-managed rather than polished end-user onboarding
- direct peer sync is still separate from coordinator discovery
- new coordinator features may land in the built-in runtime first and reach the Worker later
