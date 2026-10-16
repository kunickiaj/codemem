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

This is an optional normal Worker route, not a separate pilot. The implementation is available in the current source
checkout and has passed its compile and test checks, but it is unreleased. Do not
use it for a live deployment or device onboarding until the live workflow is approved; operator-managed enrollment
remains the current path.

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

## 6. Deploy the Worker

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

From `examples/cloudflare-coordinator/`:

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
