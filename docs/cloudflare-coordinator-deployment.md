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

### Commands that print secrets or signed URLs

Several commands in this guide print, or can print, a secret or a signed download URL. Keep that output out of shared
terminals, agent transcripts, CI logs, support requests and chat, because none of it can be recalled once copied:

- `wrangler d1 export` prints a presigned URL that downloads the whole coordinator database for about an hour and cannot
  be revoked. Use the form in [Back up the database](#back-up-the-database), which writes the export and everything
  the command prints to files with mode 600 and prints nothing.
- `wrangler secret put` reads the value from its prompt. Type or paste it there; do not pass it with `echo`, a pipe or
  an argument, and do not print it afterwards. The one exception is the
  [invitation token key](#invitation-token-key-0055), which nobody types: pipe it straight from the generator.
- Admin requests with `curl` read the admin secret from `CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET`. Do not type the
  secret into the command, save it in a request file, or add `-v`, `--verbose` or `--trace`, which print request
  headers.
- `codemem coordinator owner enroll --prepare` writes a private request file that holds a browser-start code. Do not
  print the file or paste it.
- An invitation is a bearer credential: whoever holds it can use it. Send it only to the person it is for, over a
  private channel.

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

This secret is required for admin routes such as invite creation and join-request review. Enter the value at
Wrangler's prompt; see [Commands that print secrets or signed URLs](#commands-that-print-secrets-or-signed-urls).

The Worker also needs `CODEMEM_INVITE_TOKEN_KEY` before it can create invitations. Set it as described in
[Invitation token key (0055)](#invitation-token-key-0055).

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

For the grant endpoint, the maintained operator wrapper is `codemem coordinator group grant-identity <attestation-id>`.
Use the stored `controller-v1:` reference returned by confirmed `review-device-owner`, with the same coordinator
configured in the existing operator configuration. The wrapper keeps the admin credential out of arguments and
output, refuses redirects, and defaults confirmation to **No**. `--json` and noninteractive calls send no request.
It grants transport enrollment eligibility only, not Team/Project access; it does not run Google or alter a local
profile. See the [first-owner bootstrap recipe](user-guide.md#first-owner-bootstrap-before-teams).

Use the maintained CLI in three steps:

1. **Pause capture, then review and prepare.** Stop this profile's capture plugin, viewer, and sync daemon until the
   command reports `Verified coordinator Identity`. Run `codemem coordinator owner enroll <group> --prepare --config <path>
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

The example Wrangler template already sets `migrations_dir`. The numbered migrations are the complete schema: a new
database that applies them all, through `0047`, ends on the current coordinator schema, including the authority
cutover and account management. No exported SQL, separate install or `schema.sql` baseline is needed.
`packages/cloudflare-coordinator-worker/schema.sql` describes the same fresh schema, but using it directly does not
record which migrations were applied.

For a **new, empty database**, run this from the repository root after setting the real database ID in the ignored
deployment config:

```fish
pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 migrations apply codemem-coordinator --remote --config ../../examples/cloudflare-coordinator/wrangler.toml
```

For an existing database, the same command applies only the migrations its ledger lacks. Before running it on a
deployment that has users, pause auth writers, drain pending link attempts,
[back up the database](#back-up-the-database) and obtain separate approval. See [Auth schema stages](#auth-schema-stages-0045-to-0047) for what the last three migrations require.

### Back up the database

Take a backup before applying migrations or running any statement that changes an existing database.
`wrangler d1 export` writes the SQL to the `--output` file, and it also prints a presigned URL for the same export.
Anyone who has that URL can download the whole coordinator database until it expires, about an hour later, and it
cannot be revoked. Run the export into a new private directory outside the repository, so that its output goes to
files only you can read, and print nothing from it:

```fish
set backup ~/coordinator-backup-(date -u +%Y%m%dT%H%M%SZ)
mkdir -m 700 $backup
and sh -c 'umask 077 && log=$1 && shift && exec "$@" >"$log" 2>&1' sh "$backup/export.log" \
    pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 export codemem-coordinator \
    --remote --output "$backup/coordinator.sql" --config ../../examples/cloudflare-coordinator/wrangler.toml
echo $status
```

- `mkdir -m 700` creates a directory only you can open. It fails if the directory already exists, and then nothing
  else runs, so the export never writes into an older file that someone else could read.
- `umask 077` makes `coordinator.sql` and `export.log` mode 600. To confirm, run `stat -c '%a %n' $backup $backup/*`
  on Linux or `stat -f '%Lp %N' $backup $backup/*` on macOS: the directory must show `700` and both files `600`.
- Exit status `0` means the export finished. That is the only output to look at or report.
- Do not print, `cat`, paste or attach `export.log`: it holds the signed URL. If the export fails, read the log in a
  private terminal and describe the error in your own words, without the URL.
- The SQL file holds every coordinator row. Keep the directory private, never paste from it, and delete it once it is
  no longer needed.
- A running export blocks other requests to the database, so take it while writers are paused.

For a database originally created from `schema.sql` or an exported install, follow
[the baseline procedure](#baseline-a-d1-database-whose-schema-came-from-outside-the-migrations) before applying
migrations; do not replay from `0001` or reset the database to make the migration bookkeeping match.

### Team member removals (0052)

Migration `0052_add_team_member_removals.sql` only creates new objects: one empty table, two indexes and two
triggers that refuse any update or delete of its rows. It changes no existing table or row. A Worker from before
0052 keeps working with it applied, so apply it before deploying the Worker that uses it. That Worker answers
`503 team_member_removal_unavailable` on both admin routes until every object exists with exactly the shipped
definition, and every other route keeps working. A SQLite coordinator installs the same storage when it opens its
file and leaves an object of the same name but another definition in place, still unavailable.

An admin device records that a person was removed from one Team with
`POST /v1/admin/team-member-removals` and the body `{ "group_id", "team_id", "identity_id" }`, plus an optional
`removed_by_device_id` kept for display. A removal is permanent for that identity and numbered by one
coordinator sequence. A new removal answers `201`. Removing the same person from the same Team again writes
nothing and answers `200` with the first removal. An unknown group answers `404 group_not_found`, and a body with
any other field or a malformed identifier `400 invalid_input`. No route restores, edits or deletes a removal.

A removed person comes back only through a new Team invitation, which assigns a new identity that no removal
names. Add-device invitations, account linking, rejoin, owner enrollment and invitation-based device rejoin keep
the removed identity, so they never lift its removal. A Team invitation that was issued before the removal and
is still unused also brings the person in under a new identity, and the coordinator cannot tell it apart from an
invitation for someone else. The Viewer's removal step therefore lists the Team's pending, unexpired and
unrevoked invitations and lets the admin revoke them in the same step.

`POST /v1/admin/invites/revoke` with the body `{ "group_id", "invite_id" }` revokes a Team invitation that
nobody has accepted. It answers `200` with `status` `revoked`, or `already_revoked` and the first revocation
time. An accepted invitation answers `409 invite_consumed` and is left as it is, and an invitation the group
does not have answers `404 invite_not_found`. Any other kind of invitation, such as an add-device invitation or
an older device invitation, answers `409 invite_kind_unsupported` and stays open. Older device invitations are
admitted by a path that checks revocation before it writes and never marks the invitation accepted, so a
revocation could race an admission there. A revoked Team invitation can no longer be inspected or accepted. The
statement that accepts a Team invitation requires it to be neither revoked nor accepted, so a revocation and an
acceptance cannot both win. The route requires the admin secret and needs no migration.

`GET /v1/admin/team-member-removals?group_id=...` only reads. It lists a group's removals oldest first, 200 per
page, and accepts `team_id` and the previous page's `next_after_seq` as `after_seq`. Both routes require the
admin secret. A removal grants and revokes nothing on the coordinator. Clients that support Team member removal
read the removals to keep those memberships removed.

An admin device's Viewer reads the full list for each configured group on every enrollment check, after it reads
the accepted invitations, and applies both in one local transaction. It revokes each removed membership, wakes
the affected Project access, and keeps every Team setup and Team invitation from making that person a member
again. From the moment the removal is recorded, the device's sync admission refuses the person's devices every
scope that holds one of the Team's Projects, through a mapping of any kind or through memories already stored
there. A scope that holds only Projects the person still has another way, such as a direct share or another
Team, stays open to them. A removal applies only in the Team's own coordinator group. A Team's group comes from
its completed setup, from the group an admin device created it for in the Viewer, and from the group the
coordinator bound it to, which each enrollment check reads with `GET /v1/admin/team-group-bindings`. An accepted
invitation is never evidence of a Team's group, and it grants its Team only when the Team's group is the
invitation's group. A Team that the coordinator has not bound yet, with nothing else naming a group, has no group:
no removal applies to it and its invitations grant nothing, but its current access stays. When the sources
disagree, or nothing names a group and the coordinator reports Team invitations for it from more than one group,
the Team's group is a conflict. Then no new removal applies to it, its invitations grant nothing, the Viewer's
removal step refuses it and lists it as a warning, and the device refuses the scopes that hold the Team's Projects
to every device of a current or former member until the conflict is resolved, for example by binding the Team with
`POST /v1/admin/team-group-bindings`. A removal the device already enforced keeps applying during a conflict.
Devices of the admin device's own person keep their access. A record for any other Team is kept without effect and
reported.

A Team invitation goes only through the Team's own group, because the first one binds the Team on the coordinator
for good. When the Team's group is known on the admin device and differs from the configured group, or is a
conflict, the Viewer refuses the invitation with `409 team_group_mismatch` or `409 team_link_conflict` and sends
nothing to the coordinator. The Viewer also reads the list before it applies a
Team setup that another admin device completed. If that read fails, it applies nothing in that pass and leaves the
Team as it is.

If the removal list or the Team bindings cannot be read, for any reason, the Viewer still reconciles enrolled
devices but grants no Team access from an accepted invitation in that check, and reports each invitation it held
back. A removal list that was read still applies to every Team whose group the device already knows, even when the
bindings cannot be read. A not-found
answer counts as a failure, because the coordinator exposes nothing that proves it predates removals. A coordinator
from before 0052, or a Worker deployed without the migration, therefore holds back new Team members on upgraded
admin devices until the migration and Worker are in place. That is why the migration goes in before the Worker.

Removals take effect only on admin devices that run a version that reads them. Admin devices on 0.50.0-beta.2 or
earlier ignore the list: they can still add a removed person back from an accepted invitation, and they keep
serving that person's devices until the coordinator drops them from the Team's scopes. Upgrade every admin device
of the group before relying on Team member removal.

### Team group bindings (0053)

Each Team belongs to one coordinator group, and a Team member removal applies only in that group. Migration
`0053_add_team_group_bindings.sql` adds a table that records each Team's group, with an index and two triggers
that refuse any update or delete of its rows. The first Team invitation minted for a Team binds the Team to the
minting group, in the same write as the invitation. A binding never changes, and no route removes one.

Apply 0053 before deploying the Worker that uses it. A Worker from before 0053 keeps working with it applied.
The new Worker refuses Team invitations with `503 team_group_binding_unavailable` until every object exists with
exactly the shipped definition. Other invitations and every other route keep working. A SQLite coordinator
installs the same storage, and runs the same backfill, when it opens its file.

The migration also binds existing Teams. Each Team whose Team invitations all came from one group is bound to
that group. A Team whose Team invitations came from more than one group stays unbound, and the migration changes
no other row. The migration then checks that every Team of one group is bound, and fails without being recorded
if one is not, so a later `migrations apply` runs it again. Before applying it, you can count such Teams on a copy of the database:

```sql
SELECT COUNT(*) FROM (SELECT policy_team_id FROM coordinator_invites
 WHERE invite_kind = 'team_member' AND policy_team_id IS NOT NULL
 GROUP BY policy_team_id HAVING COUNT(DISTINCT group_id) > 1);
```

After 0053, the coordinator refuses a Team invitation with:

- `409 team_bound_to_other_group` when the Team is bound to another group.
- `409 team_binding_conflict` when the Team is unbound and another group already has Team invitations for it.

Nothing is written in either case. An admin binds an unbound Team to one group with
`POST /v1/admin/team-group-bindings` and the body `{ "team_id", "group_id" }`. A new binding answers `201`, the
same binding again `200`, a Team bound to another group `409 team_bound_to_other_group`, and an unknown group
`404 group_not_found`. Binding a Team does not revoke Team invitations that another group issued before 0053.
Revoke those with `POST /v1/admin/invites/revoke`.

`GET /v1/admin/team-group-bindings?team_id=...` only reads. It accepts up to 50 `team_id` values and answers each
Team as `bound` with its `group_id`, `unbound`, or `conflict` when it is unbound and Team invitations for it came
from more than one group. Both routes require the admin secret.

### Invitation token digests (rollback floor)

This Worker matches a presented invitation token by its SHA-256 digest only. Earlier Workers also compared it with
the stored `token` column. Join requests now keep only the digest of the token they were made with, as
`sha256:<digest>`, and approving one first resolves its invitation by that digest: a join request whose
invitation cannot be resolved is refused with `404 invite_invalid`, so no approval skips the check that its
inviter was not removed. A lookup that matches nothing writes nothing.

This Worker never hands out a stored value that is not a bearer token. When an invitation's `token` column holds a
placeholder, which a later Worker leaves when it encrypts the token, **Copy invite** and a create retry of that
invitation answer `409 invite_link_unavailable`. The invitation can still be accepted with its token.

Migration `0054_add_coordinator_metadata.sql` adds an empty `coordinator_metadata` table. This Worker records
its invitation token lookup version there when an admin runs the digest backfill or reads or records the floor
below. Anonymous requests never write to it. You record the lowest lookup version of every Worker that serves the
database. Later Workers encrypt stored tokens only once that recorded floor is at least this Worker's version, so
the floor must describe every deployment that serves the database.

Earlier Workers cannot read the join requests this one stores. When an earlier Worker approves one, it finds no
invitation for it and approves it without checking whether the inviter was removed. No value in the join
request's `token` column makes an earlier Worker refuse instead: it treats every invitation it cannot find as
having a current inviter. So no earlier Worker may serve the database once this one has stored a join request,
and the deploy is a full cutover, never a gradual rollout.

Invitations from before token digests, and join requests that copied a token, need a backfill that SQL cannot
do, because D1 cannot compute SHA-256. Upgrade in this order:

1. [Back up the database](#back-up-the-database) and apply the migrations, which include 0054.
2. Pause join approvals: tell every admin not to approve join requests until step 5 is done. Approval requests
   in flight during a deploy can reach either Worker.
3. Deploy the Worker as a full cutover with `wrangler deploy`, not `wrangler versions deploy` with a percentage.
   Wait until `wrangler deployments list` shows only this version, at 100 percent, for every Worker bound to the
   database, including other environments and routes.
4. Right away, run the digest backfill until it reports nothing left. Until then, an invitation from before token
   digests cannot be accepted, and a pending join request for one cannot be approved. Both work once the
   backfill has filled them, so nothing is lost:

   ```fish
   curl --fail-with-body --request POST \
     --header "X-Codemem-Coordinator-Admin: $CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET" \
     --header 'Content-Type: application/json' \
     --data '{"limit":100}' \
     "$CODEMEM_SYNC_COORDINATOR_URL/v1/admin/invite-tokens/digests"
   ```

   The response is `{ version: 1, filled_invites, hashed_join_requests, remaining_invites_without_digest,
   remaining_plaintext_join_requests }`. Each request changes at most 100 rows of each table, with one read and
   one write per table, so it stays within D1's per-request query limit. Repeat it until both `remaining` counts
   are `0`. Requests are safe to repeat.
5. Confirm the counts. Both must be `0`. Then resume join approvals:

   ```fish
   pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 execute codemem-coordinator --remote --config ../../examples/cloudflare-coordinator/wrangler.toml --command "SELECT (SELECT COUNT(*) FROM coordinator_invites WHERE instr(token, ':') = 0 AND token_digest IS NULL) AS invites_without_digest, (SELECT COUNT(*) FROM coordinator_join_requests WHERE instr(token, ':') = 0) AS plaintext_join_requests"
   ```

6. Confirm that no earlier Worker serves the database: every deployment and version of every Worker bound to it,
   including gradual deployments, other environments and routes, runs this Worker or a later one. For each
   Worker, `wrangler deployments list` and `wrangler versions list` show what serves traffic. Then record the
   floor. It only rises, never above the lookup version of the Worker that records it:

   ```fish
   curl --fail-with-body --request POST \
     --header "X-Codemem-Coordinator-Admin: $CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET" \
     --header 'Content-Type: application/json' \
     --data '{"min_serving_lookup_version":1}' \
     "$CODEMEM_SYNC_COORDINATOR_URL/v1/admin/invite-tokens/lookup-floor"
   ```

   The response is `{ version: 1, build_lookup_version, lookup_version_seen, min_serving_lookup_version }`. A `GET`
   of the same path reads these values. The same record as one SQL statement, for a database you reach only with
   `wrangler d1 execute`:

   ```sql
   INSERT INTO coordinator_metadata (name, value, updated_at)
   VALUES ('invite_token_min_serving_lookup_version', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
   ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
   WHERE excluded.value > coordinator_metadata.value;
   ```

This Worker is the **rollback floor** for invitation tokens. Once the floor is recorded, roll back only to this
Worker or a later one, and never deploy an earlier one beside it. An earlier Worker compares a presented token
with the stored `token` column and copies links from it, so it would accept and hand out the placeholders that
later Workers store. It would also approve the join requests this one stored without checking whether their
inviter was removed, so if you roll back below this Worker at any point, pause join approvals until this Worker
serves the database again. A SQLite coordinator fills the digests and records its lookup version when it opens its file; record
its floor the same way once no earlier codemem release opens that file.

### Invitation token key (0055)

The coordinator keeps each invitation's bearer token only as its SHA-256 digest, which acceptance looks up, and as
AES-GCM ciphertext, which it decrypts when an admin copies the invitation link again or retries its creation. The
stored `token` column then holds `sealed:` followed by 32 random bytes. The ciphertext is bound to its invitation's
ID and records the ID of the key that sealed it. Accepting an invitation drops its ciphertext in the same write.

This Worker encrypts nothing until the database records the [rollback floor](#invitation-token-digests-rollback-floor):
until then it stores bearer tokens exactly as the digest-only Worker does, and the sealing backfill answers
`409 invite_token_lookup_floor_unset`. Record the floor only once no Worker below it serves the database. A Worker
below the floor compares a presented token with the stored `token` column and builds **Copy invite** links from
it, so it would accept and hand out the placeholders this Worker stores. The placeholder is random, so nobody can
derive it from public values such as the invite ID. After a rollback to the digest-only Worker, invitations
sealed here stay acceptable, and **Copy invite** for them answers `409 invite_link_unavailable` until this Worker
is back.

Migration `0055_seal_invite_tokens.sql` only adds the `token_ciphertext` and `token_key_id` columns. A Worker from
before 0055 keeps working with it applied.

Once the floor is recorded, without the key, or with a value that is not a key, the Worker refuses to create
invitations, and to rebuild a link with **Copy invite**, with `503 invite_token_key_unavailable` or
`503 invite_token_key_invalid`. Accepting an invitation needs only the digest, so it keeps working. A key is 32
random bytes, as 64 hexadecimal characters or as base64 or base64url.

Upgrade in this order:

1. Finish [the digest-only upgrade](#invitation-token-digests-rollback-floor), including its digest backfill and
   the recorded floor. `GET /v1/admin/invite-tokens/lookup-floor` must report `min_serving_lookup_version: 1`.
2. [Back up the database](#back-up-the-database) and apply the migrations, which include 0055.
3. Set the key. The value comes from the generator and goes straight to Wrangler, so it is never shown, logged or
   written to a file:

   ```fish
   openssl rand -hex 32 | pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler secret put CODEMEM_INVITE_TOKEN_KEY --config ../../examples/cloudflare-coordinator/wrangler.toml
   ```

4. Deploy the Worker.
5. Seal the tokens that existing rows still hold. Lookups write nothing; the Worker also seals a row when an admin
   copies its link. This admin request seals up to `limit` rows, at most 100, per call, with one read and one write
   per table, so it stays within D1's per-request query limit:

   ```fish
   curl --fail-with-body --request POST \
     --header "X-Codemem-Coordinator-Admin: $CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET" \
     --header 'Content-Type: application/json' \
     --data '{"limit":100}' \
     "$CODEMEM_SYNC_COORDINATOR_URL/v1/admin/invite-tokens/seal"
   ```

   The response is `{ version: 1, sealed_invites, cleared_spent_invites, hashed_join_requests,
   remaining_plaintext_invites, remaining_plaintext_join_requests, remaining_spent_ciphertext }`. Repeat the request
   until all three `remaining` counts are `0`. `remaining_spent_ciphertext` counts consumed invitations that still
   keep ciphertext, which happens when an earlier Worker accepted them during a rollback. Requests are safe to
   repeat. Without the key the route answers `503 invite_token_key_unavailable` and changes nothing.
6. Confirm that no row still holds a token or spent ciphertext. All three counts must be `0`:

   ```fish
   pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 execute codemem-coordinator --remote --config ../../examples/cloudflare-coordinator/wrangler.toml --command "SELECT (SELECT COUNT(*) FROM coordinator_invites WHERE instr(token, ':') = 0) AS plaintext_invites, (SELECT COUNT(*) FROM coordinator_join_requests WHERE instr(token, ':') = 0) AS plaintext_join_requests, (SELECT COUNT(*) FROM coordinator_invites WHERE token GLOB 'consumed:*' AND token_ciphertext IS NOT NULL) AS spent_ciphertext"
   ```

After any rollback to the digest-only Worker, run steps 5 and 6 again once this Worker is back.

Invitation links do not change, so clients from 0.50.0-beta.3 and earlier keep creating, copying and accepting
them as before. A SQLite coordinator adds the columns when it opens its file and follows the same floor rule: it
encrypts nothing until `codemem coordinator invitation record-floor 1` records the floor, which also encrypts the
tokens it stored before. Run it only while no process has the database open, and only once its key works: the
command checks the key, or creates the key file, before it records the floor, and records nothing when it cannot.
[The self-hosting guide](coordinator-deployment.md) lists the steps. It reads the key from `CODEMEM_INVITE_TOKEN_KEY`, or from
`sync_coordinator_invite_token_key` in the codemem config file. Without either, it creates a key on first use in a
file next to the database's real path, `<database>.invite-token-key`, readable only by its user, and logs
`created invite token key at <path>`, never the key. It refuses an existing key file that is not a regular file,
that other users can read, or that holds no 32-byte key. A configured key always wins over the file.

#### Rotate the key

The Worker seals with `CODEMEM_INVITE_TOKEN_KEY` and also opens ciphertext of
`CODEMEM_INVITE_TOKEN_KEY_PREVIOUS`. To rotate, you need the current value:

1. Set `CODEMEM_INVITE_TOKEN_KEY_PREVIOUS` to the current value, at Wrangler's prompt.
2. Set `CODEMEM_INVITE_TOKEN_KEY` to a new key with the command above, and deploy.
3. Keep the previous key until no open invitation uses it. This count of open invitations per key ID tells you
   when; key IDs are not secret:

   ```sql
   SELECT token_key_id, COUNT(*) FROM coordinator_invites
    WHERE token_ciphertext IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    GROUP BY token_key_id;
   ```

4. Delete `CODEMEM_INVITE_TOKEN_KEY_PREVIOUS` with `wrangler secret delete` once only the new key ID remains.

If the current value was never kept, set a new key without a previous one. Open invitations stay acceptable, but
their links can no longer be copied (`503 invite_token_key_unavailable`). Revoke and re-create those you still need.

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

### Relay admission tables (0041 and 0042)

Migrations `0041_add_relay_admission_metadata.sql` and `0042_add_admission_budgets.sql` add the
empty policy, readiness, and admission budget tables that `POST /v1/relay/admission-check` reads.
They are generated from the core schema constants. With no rows, every relay admission check is
denied, so applying them changes nothing for coordinator-only deployments.

### Headless account linking storage (0043)

Migration `0043_add_headless_account_linking.sql` adds two empty tables for linking a Google
account to a device without a browser: code-entry counts per client and per coordinator,
and a record of which links were made this way. It changes no existing table or row. Until both
tables exist, headless linking stays off and every other sign-in and linking flow works as
before. A self-hosted SQLite coordinator creates the tables when it opens. Once the tables exist,
devices can run `codemem coordinator account link <group> --headless`; a coordinator without them
answers that command's requests with 404, and the CLI asks the user to contact you.

The code-entry page at `/auth/link/device` counts every submitted code, including ones that
work, and allows 10 per client address and 200 per coordinator in each 15-minute window. Over
either limit it answers 429 with `Retry-After`. The Worker identifies a client only by
`CF-Connecting-IP` and stores an HMAC of that address, keyed from
`CODEMEM_COORDINATOR_BROWSER_CSRF_KEY`. Rotating that key starts every client window over. A
host that cannot supply a platform-verified client address does not serve the page.

### Rebind start authority (0044)

Migration `0044_add_rebind_start_authority.sql` additively adds
`start_authority_json` to rebind attempts. It pins the server-derived authority
snapshot for **Connect this device** self-binds. It creates no table and leaves
existing attempts with a null value under their original rebind rules. Migration
0040 remains unchanged.

Apply 0044 before deploying a Worker that offers this authority path. That order
keeps ordinary rebind routes available. If the Worker is deployed first, its
rebind-backend check requires `start_authority_json` as part of the current rebind
shape and returns controlled `404` responses for every rebind route until 0044
exists, rather than letting requests reach missing-column SQL. A self-hosted SQLite
coordinator adds the column during its existing schema upgrade.

Applying the D1 migration still needs separate approval. Validate the additive
upgrade with native D1 coverage before offering the feature. The Worker does not
apply the D1 migration automatically.

### Optional relay host (off by default)

[Relay](relay.md) explains what relay does for users, its privacy limits, and how to turn it off. The relay runs as the `RelayRealm` Durable Object in the coordinator Worker (ADR 0006). It stays
off unless `CODEMEM_RELAY_ENABLED` is exactly `"true"`. While it is off, the coordinator answers
relay upgrades and the relay quota route exactly as before, and no object is created. To turn it on, deploy with
`main` set to `packages/cloudflare-coordinator-worker/src/worker.ts`, which exports `RelayRealm`,
`RelayHealth`, and `RelayAdmission`, and copy these settings from the package's `wrangler.jsonc`:

- the `RELAY_REALM` and `RELAY_HEALTH` Durable Object bindings, and the `v1-relay-realm` and
  `v2-relay-health` migrations with `new_sqlite_classes`
- `CODEMEM_RELAY_AUTHORITY_URL`, the coordinator origin with no path
- `CODEMEM_RELAY_GROUPS`, a JSON array of up to 8 group IDs, one realm each
- the Ed25519 service key as a secret: `wrangler secret put CODEMEM_RELAY_SERVICE_KEY`
- the health probe settings described in [Relay health on Workers](#relay-health-on-workers)

Admission checks from realm objects reach the `RelayAdmission` entrypoint through the Worker's own
`ctx.exports`, so no service binding is needed. A Worker in the same account could also bind to
that entrypoint. Same-account Workers are inside the operator's trust boundary, and their checks
still need device-signed packets. The public admission route serves every configured group and
picks the group from the device-signed packet body. Each realm's loopback admits only its own
group.

With relay on, the coordinator also serves `GET /v1/relay/info?group_id=<group>` to enrolled
devices. It uses the same device-signed authorization as `/v1/peers`, and it returns the service
public key derived from `CODEMEM_RELAY_SERVICE_KEY` as `ssh-ed25519` text, the group's
`/v1/relay/<realmId>` path, and `/v1/relay/admission-check`. A group outside
`CODEMEM_RELAY_GROUPS`, and every group while relay is off, gets the same `401 unknown_device` that
`/v1/peers` gives a non-member. A device running the local service with this coordinator and group
configured fetches the route, pins the key on first fetch for each coordinator and group, and
pauses relay when the key changes until its user approves the new key with
`codemem sync approve-relay-key`. Rotating the service key secret therefore pauses relay on every
pinned device until each user approves the new key. Devices relay only after the steps below are
complete. Until then, every group resolves as disabled and devices sync directly.

Turning relay on takes these steps, in order:

1. Apply the D1 migrations, including 0041 and 0042.
2. Enroll the health probe device in every configured group, and make it a member of one
   synthetic scope in each group.
3. Set the service key and probe key secrets.
4. Set `CODEMEM_RELAY_ENABLED`, `CODEMEM_RELAY_AUTHORITY_URL`, `CODEMEM_RELAY_GROUPS`,
   `CODEMEM_RELAY_HEALTH_PROBE_DEVICE`, and `CODEMEM_RELAY_HEALTH_SCOPES`.
5. Deploy.
6. Write the admission rows with `POST /v1/admin/relay/admission`. This also arms the health alarm.
7. Provision each realm's quota with `POST /v1/admin/relay/quota`.
8. Wait about six minutes. Admission checks are denied until the health object has seen five
   complete healthy minutes and published ready readiness rows.

The admission route takes an empty JSON object, because every value comes from the Worker's relay
config and a fixed budget profile in code. It uses the same admin secret and request checks as the
quota route, and the same 20-per-minute admin rate limit, counted separately from the quota route.
It rejects an `Origin` header and any query string. The command reads the coordinator URL and admin secret from the
environment; do not type the secret into it or add verbose output:

```fish
curl -sS -X POST "$CODEMEM_SYNC_COORDINATOR_URL/v1/admin/relay/admission" \
  -H "Content-Type: application/json" \
  -H "X-Codemem-Coordinator-Admin: $CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET" \
  --data '{}'
```

It writes the authority policy, the relay audience, a `relay_admission_realms` row for each
configured group, and the `authority`, `device`, `device-registration`, `relay-route`, and
`relay-registration` budget allocations, all in one D1 batch. The reply lists each realm ID for
step 7, reports `"changed"`, and always carries `"readiness":"not_written"`: this route never writes
readiness rows. Its `"health"` field is `"scheduled"` when the health alarm is armed,
`"not_configured"` when a probe setting is missing or invalid, and `"unavailable"` when the health
object could not be reached; repeat the call to retry. While relay is off the coordinator answers the
path, which returns 404.

| Allocation | Rate per minute | Burst |
| --- | --- | --- |
| Each group, in `relay-route` and in `relay-registration` | 120 | 64 |
| Each pool's audience parent (`group_id` `''`) | 120 × groups | 64 × groups |
| `authority` | 240 × groups | 128 × groups |
| `device` | 96 | 16 |
| `device-registration` | 2 | 2 |

The D1 triggers require each parent to cover the sum of its children and the `authority` row to
cover the sum of the audience parents, so each parent is set to exactly that sum. The per-group
values are the default one-group profile: 120 route checks per minute admit about 40 route opens per
minute, because each open needs a source, relay, and responder check, which stays below the
contract's realm open ceiling of 128 per minute. Eight groups need 960/512 per audience parent and 1,920/1,024 at the
authority, which is far below the schema ceilings, so the per-group allotment needs no scaling.
The `device` and `device-registration` values are the schema maximums.

Rows are permanent, and the route only adds or raises:

- Repeating setup with the same config writes nothing.
- A new group in config raises the authority and audience parents by its share first, then adds
  its realm row and allocations. The policy revision goes up by one in the same batch, as the
  metadata triggers require. Existing per-group allocations are never raised. Adding a group or
  rotating the key bumps `policy_revision`, so admission checks already in flight fail closed once
  and then recover.
- A group removed from config keeps all its rows and still counts toward its parents. The Worker
  just stops serving its realm.
- A rotated service key gives a new audience, so setup adds that audience and its parents. The old
  audience's parents still count toward the authority. Optionally, an operator can revoke the old
  audience and close its allocations by hand, setting the children to 0/0 before their parents, so
  the authority total stays meaningful.
- A stored row is never lowered, and a disabled policy or realm is never re-enabled.

The route answers 409 instead of writing when a change would need something the schema or this
policy forbids: `relay_audience_revoked` for a revoked audience, which can never be re-enabled
(rotate the service key to get a new audience), `relay_budget_closed` when a parent that must grow
is stored as 0/0, which this route treats as an operator closure, and `relay_budget_ceiling` when a
value would exceed a schema limit. `relay_admission_conflict` means a concurrent writer changed the
rows first, so read them and retry. To change a budget by hand, update D1 directly: lower children
before their parent, and raise a parent before its children, so every statement passes the
triggers.

Checks are charged before authentication. A packet that names a configured group charges that
group's ingress bucket as well as the shared buckets, so anyone who knows a group ID can drain that
group's bucket with junk packets until it refills. This is an accepted risk: the shared buckets
already allow the same junk to delay checks for every group. A packet that does not decode, or
names an unconfigured group, charges only the shared buckets.

Each realm also needs its quota provisioned (step 7) before upgrades succeed:

```fish
curl -sS -X POST "$CODEMEM_SYNC_COORDINATOR_URL/v1/admin/relay/quota" \
  -H "Content-Type: application/json" \
  -H "X-Codemem-Coordinator-Admin: $CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET" \
  --data '{"realm_id":"<64-hex realm ID>","enabled":true}'
```

The first call stores that realm's equal share of the service ceilings. Adding a group needs a
deploy, and after it each provisioned realm lowers its stored allotments to the new, smaller share
on its first event, so the total stays within each ceiling without another call. Allotments are
never raised. Relay supports at most 8 groups per Worker, because each group's control share must keep two tokens for the challenge and registration that every connection sends back to back. With more groups, relay stays off.
Each realm also limits upgrades per client address, using the `CF-Connecting-IP` header that
Cloudflare sets: at most two sockets that have not registered yet, and ten upgrade attempts a
minute with a burst of two. IPv6 clients are grouped by /64. Excess upgrades get `429`. Devices behind one NAT, or in one IPv6 /64, share that
allowance, so a third device connecting to the same group at the same moment retries a few
seconds later.
`"enabled":false` switches the realm off without a deploy: new upgrades are refused and open
sockets close. Changing `CODEMEM_RELAY_ENABLED` needs a deploy. A realm object reads it when it
starts, so after the deploy it refuses upgrades and closes each existing socket on that socket's
next event.

#### Relay health on Workers

Admission checks need a fresh `ready` readiness row for the authority and for the check's realm. The
`RelayHealth` Durable Object writes them. One instance serves the Worker. Every 30 seconds an alarm
runs one probe cycle per configured group: a signed `GET /v1/scopes` and a signed
`GET /v1/scopes/<synthetic scope>/members`, each with the group's `group_id`. The object keeps the
health windows in its own storage, so they survive eviction between alarms, and it publishes to
`relay_admission_readiness` in `COORDINATOR_DB`. On its first cycle it inserts tripped readiness rows
for the authority and for every realm row that setup created. Readiness starts tripped and turns
ready after five complete healthy minutes. A ready row expires 50 seconds after its observation.

The probe needs three settings:

- `CODEMEM_RELAY_HEALTH_PROBE_DEVICE`: the device ID of a normal, low-privilege enrolled device.
  Enroll it in every configured group.
- `CODEMEM_RELAY_HEALTH_SCOPES`: a JSON object that maps every configured group ID to a synthetic
  scope ID in that group. The probe device must be a member of each one, and nothing else should
  depend on those scopes.
- the probe device's Ed25519 private key, base64 PKCS#8, as a secret:
  `wrangler secret put CODEMEM_RELAY_HEALTH_PROBE_KEY`

If any of these is missing or invalid, or relay is off, the object arms no alarm and an alarm that
is already set does not re-arm itself. Readiness then expires and admission is denied.

Things to know before relying on it:

- **Probe path.** A Worker cannot fetch its own `workers.dev` URL, so the probe calls the Worker's
  default handler through `ctx.exports`. It measures the coordinator's handling of a real signed
  request, including auth, nonce, and D1 work, but not the public HTTPS path in front of it. On a
  custom domain the probe could use the real path. That needs a DNS change and separate approval.
- **Clock.** The object treats the Cloudflare host clock as verified UTC with a declared 1 second
  error bound. Cloudflare publishes no skew figure, so this is an operator assumption.
- **Real-client samples.** Authenticated scope reads in any group are timed in the isolate that
  serves them. A failure or a slow read can pause or trip readiness. Each isolate forwards at most one
  real-client sample per second, with a burst of ten, through `ctx.waitUntil`, so the read never
  waits for the health object. Probe-originated samples are always forwarded.
- **Authority row.** Each realm row carries only its own group's state. The schema makes every realm
  update also bump the authority row, so each publication writes the authority row with a value
  combined from every group: ready when at least one group is ready, with the freshest ready
  group's observation time. Otherwise it takes the least severe group state, paused before tripped.
  A check still needs its own realm row to be ready and fresh, so one group's trip denies only that
  group's checks.
- **Restarts.** The object discards saved windows older than two minutes when it loads them. After
  relay is disabled and re-enabled, or the object was idle that long, each group starts tripped and
  needs five healthy minutes again. A disable and re-enable, or a deploy, within two minutes keeps
  the saved windows, so readiness can return after one healthy cycle, as after an ordinary eviction.
- **Alarm delivery.** Alarms run at least once and can be delayed by up to a minute. A repeat within
  29 seconds of the last cycle skips its probe and keeps the original 30 second schedule. The handler
  never throws, so platform retries do not add cycles. A delayed cycle publishes paused, never a
  stale ready.
- **Sample cap.** A one-minute window holds at most 4,096 samples per endpoint and cohort. A sample
  past that trips the group. At the forwarding cap of one sample per second per isolate, roughly 68
  or more isolates serving steady scope reads in one group would reach it.

The cost per Worker is about 2,880 alarms a day. Each alarm makes two coordinator requests per group,
each with the usual auth, nonce, and scope queries in D1, and up to three readiness publications per
group, each one D1 read and one two-statement batch. Each forwarded sample costs one Durable Object
request and one storage write of that group's saved windows, which grow with the window's samples.
Under steady authenticated scope reads, forwarded samples keep the object resident, so expect
continuous duration charges and one storage write per forwarded sample rather than activity only
during alarms.

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

### Auth schema stages (0045 to 0047)

Three numbered migrations move a coordinator's auth schema forward one stage each:

| Migration | Starts from | Leaves |
| --- | --- | --- |
| `0045_cut_over_auth_link_authority.sql` | the legacy controller-attested authority schema, with no pending attempts | V2 authority kinds and device-claim proof |
| `0046_add_account_connections.sql` | intact V2 without account management | the first account-management extension: refresh, connection history and browser ordering |
| `0047_add_account_unlink.sql` | exactly the `0046` schema | the current schema, with device unlink receipts and the archive guard |

Each file is generated from the statements a SQLite coordinator runs and checks its starting schema before it changes
anything that schema contains. `0046` and `0047` start with that check, so on any other schema, including a partial or
unknown one, their first statement aborts the file. `0045` first creates a small check table and then refuses through
it, so it relies on the file being applied atomically to leave nothing behind. Wrangler records a migration only when
its whole file succeeds. Existing link rows, IDs, proofs, sessions and history are
kept. `0046` gives each known coordinator its first connection order and keeps the latest sign-in profile visible; it
does not backfill orders for old pending browser transactions, which therefore cannot create new sessions.

Apply these migrations and deploy the matching Worker in the same paused-writer window, then resume writers. Old
binaries reject the new schema, and do not roll back to an older Worker after `0047` or after new unlink receipts
exist. Local `applyD1Migrations` runs each file as one atomic D1 batch, and the native Worker tests show that a refused
file leaves the database unchanged there. Remote `wrangler d1 migrations apply` sends each file's SQL as one query. Nobody has yet confirmed against remote D1 that one migration
request is atomic, or that it accepts the largest file: `0047` is about 138 KB in nine statements, and its largest
statement is about 72 KB, under D1's 100 KB statement limit. Try the chain on a copy of the production database first.

`0049` installs triggers on `enrolled_devices` that the writes of a Worker or CLI from before 0.50 do not pass. With
the triggers installed, an older release can still enroll a new device until the first removal is recorded. It can no
longer remove a device, and it can no longer enroll a device that is already enrolled in the group, whether or not any
removal exists. Apply `0049` in the same window as the 0.50 Worker deploy. A SQLite coordinator installs the same
triggers the first time 0.50 opens its file, so an older binary pointed at that file fails the same way.

Apply `0056_add_readiness_preparations.sql` before deploying the Worker that clears
group generations on enrollment writes. Without its nullable column on `groups`,
those transactions fail. SQLite adds the column on startup. It starts NULL for
every group. This migration does not start a preparation or change access.

Before resuming writers on D1, fill the key IDs of enrollments that predate `0048`.
The migration leaves them null because SQL cannot compute the Ed25519 key ID.
Device removal remains unavailable until every enrollment has a key ID. SQLite fills
them on startup, but a D1 upgrade needs this admin request to the newly deployed Worker:

```fish
curl --fail-with-body --request POST \
  --header "X-Codemem-Coordinator-Admin: $CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET" \
  --header 'Content-Type: application/json' \
  --data '{"limit":500}' \
  "$CODEMEM_SYNC_COORDINATOR_URL/v1/admin/devices/key-id-fill"
```

Use the coordinator URL and admin secret already configured for the deployment.
Do not paste the secret into a command, save it in a request file, or enable verbose
HTTP logging (`-v`, `--verbose` or `--trace`). The response is
`{ version: 1, filled, blocked, skipped, remaining, next }`. Each request fills at most
500 rows and binds at most 1,000,000 serialized UTF-8 bytes per JSON value, so byte
size can end a page earlier. While `remaining` is true, repeat with `{"limit":500,"after":NEXT}`, replacing
`NEXT` with the previous response's integer `next`. Add `blocked` and `skipped` across
the pages. `next` includes individually oversized rows counted as skipped; they
stay null while later pages can still progress. `remaining` refers to rows beyond
that cursor, not skipped or blocked rows left before it. Inspect skipped rows:
those exceeding the byte budget need operator inspection/correction, and a blind
rerun will not fix them. Only rows skipped because another writer changed them
should be retried after pausing that writer. A blocked row matches an active removal
and keeps removal unavailable. Inspect that enrollment before changing it.
When the pass has no blocked or skipped rows and `remaining` is false, removal is
available. Requests are safe to repeat and never lift a removal or delete an enrollment.
Missing removal storage returns `503 device_removal_unavailable`. Other failures
return `500 device_removal_incomplete`.

To run an older Worker after `0049`, drop the nine `enrolled_devices_*` triggers that `0049` created. An older Worker
does not enforce the removals recorded so far, so a removed device can then be enrolled again. When 0.50 returns, it
reports device removal as unavailable until the triggers are back. Every statement of `0049` is
`CREATE TRIGGER IF NOT EXISTS`, so running that file again with `wrangler d1 execute --file` restores them.

On any error, stop and inspect the database rather than resetting tables, copying data, synthesizing proof, or
restoring unrelated traffic. Existing sessions remain valid until unlink or administrator revocation.

A self-hosted SQLite coordinator needs no command: on startup it installs account management on intact V2 or the
`0046` schema in one transaction. It leaves a current schema alone, and it leaves a partial or unknown auth schema
unchanged and keeps reporting `coordinator_auth_schema_upgrade_required`.

#### Baseline a D1 database whose schema came from outside the migrations

A database built from `schema.sql`, or one that received the cutover or account management through
`codemem coordinator schema upgrade-auth --export-sql` or `upgrade-account --export-sql`, has the schema but no
matching migration records, and often no `d1_migrations` ledger at all. `wrangler d1 migrations apply` would then run
every migration from `0001` and fail on the first change that already exists. Record what is already present first:

1. Pause auth writers and back up the database. Compare its schema with the numbered chain for the expected stage,
   including indexes, triggers and constraints, before recording migration history.

   Older `schema.sql` installations omitted `coordinator_owner_enrollment_qualifications` and its five triggers.
   If inspection confirms that this table is absent, review migration `0035_add_owner_enrollment_qualifications.sql`
   and apply that file alone as a prerequisite repair, with operator approval:

   ```fish
   pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 execute codemem-coordinator --remote --file migrations/0035_add_owner_enrollment_qualifications.sql --config ../../examples/cloudflare-coordinator/wrangler.toml
   ```

   This creates empty qualification storage and its triggers. It does not issue qualifications or record migration
   history. Compare the resulting table and trigger definitions with that migration before proceeding. If the table
   already exists with different definitions, stop for a separate repair rather than relying on `IF NOT EXISTS`.
   Do not record `0035` as applied while its storage is missing.
2. Check, read-only, whether the ledger exists and what it holds:

   ```fish
   pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 execute codemem-coordinator --remote --command "SELECT name FROM sqlite_master WHERE name = 'd1_migrations'" --config ../../examples/cloudflare-coordinator/wrangler.toml
   ```

   If it exists, also read `SELECT name FROM d1_migrations ORDER BY id`. If it already lists migrations, stop and
   compare them with the schema before going on.
3. Only if the ledger is missing, create it as a separate step. `wrangler d1 migrations list` creates Wrangler's empty
   `d1_migrations` table and applies nothing:

   ```fish
   pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 migrations list codemem-coordinator --remote --config ../../examples/cloudflare-coordinator/wrangler.toml
   ```

   Do not use `migrations apply` for this: it creates the ledger and then replays the chain from `0001`.
4. Export the baseline for the stage you expect. A database on the current Worker schema is at `current`:

   ```fish
   codemem coordinator schema baseline-d1 --stage current > baseline.sql
   ```

   The statement records every numbered migration from `0001` through that stage's last migration (`0045` for `v2`,
   `0046` for `prior_extension`, `0047` for `current`). For `current` it also records `0048` when the device removal
   storage that `0048` adds already exists, `0049` when its enrollment triggers already exist,
   `0050` when its readiness record storage already exists, `0051` when its rejoin storage already exists,
   and `0052` when every object of its Team member removal storage exists with the shipped definition. Each is
   checked on its own. It never records `0053`, even when its objects exist, because `0053` also binds existing
   Teams and checks that it bound every Team whose invitations came from one group. The next `migrations apply`
   runs `0053` on top of the existing objects and records it only when that check passes.
   A migration whose objects are missing stays unrecorded and the next
   `migrations apply` runs it. The statement requires that stage's auth readiness checks to pass and
   checks table and column names for the remaining earlier tables, including controller attestations and sign-in
   purge floors. This inventory does not validate column types, constraints, indexes, triggers or row validity.
   The auth-stage checks validate their own definitions and selected row invariants, not the whole database.
   A successful baseline does not replace the operator's schema comparison and
   [backup](#back-up-the-database). Names already recorded
   are skipped, so running it twice records nothing new.
5. Run it once:

   ```fish
   pnpm --filter @codemem/cloudflare-coordinator-worker exec wrangler d1 execute codemem-coordinator --remote --file baseline.sql --config ../../examples/cloudflare-coordinator/wrangler.toml
   ```

6. Read the ledger again. The outcomes mean:
   - `no such table: d1_migrations`: the ledger is missing. Go back to step 3. This error says nothing about the schema.
   - The ledger now lists the migrations: the baseline matched.
   - Nothing was recorded, or another `no such table` or `no such column` error: the schema is not at that stage, or
     part of the earlier chain is missing. A database you expected to be current but that matches no stage is partial
     or unknown and needs inspection. Retry with `--stage prior_extension` or `--stage v2` only if you have evidence the
     database stopped at that stage.
7. Apply the remaining migrations with `wrangler d1 migrations apply`, then deploy the Worker.

Nothing runs the baseline automatically, and Workers never write the migration ledger.

The `upgrade-account` and `upgrade-auth` commands remain for local SQLite files and for exporting the same statements;
`upgrade-account --owner-resolution` is still the only installer for owner-resolution receipt storage.

### Optional owner-resolution receipt storage

The explicit `--owner-resolution` mode adds only the reviewed 0037 receipt table,
indexes and immutability triggers. It requires the **current account-management
schema** first, which SQLite coordinators install at startup and D1 deployments get
from migrations `0046` and `0047`. Pause auth writers, drain pending
attempts, back up the coordinator database and obtain separate approval before applying:

```fish
codemem coordinator schema upgrade-account --owner-resolution --db-path 'coordinator.sqlite'
codemem coordinator schema upgrade-account --owner-resolution --export-sql --json
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

The command does not pause writers, drain attempts or create a backup; take one first as described in
[Back up the database](#back-up-the-database). D1 export
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

### Account routes answer 503 `auth_link_unavailable` on D1

SQLite 3.54.0 and 3.54.1 refuse to compile a statement that resolves a `WITH` name after
about 100 table references, and they count every table inside a `WITH` block again for each
reference to it. D1 reports this as `VIEWs and/or subqueries nested too deep`, and the Worker
answers 503. SQLite replaced the check with a limit of 50,000 on 2026-10-18, after 3.54.1.

Coordinator statements no longer resolve `WITH` names that deeply. Each authorization decision
reads its facts with small statements and repeats those reads at the start of the batch that
writes, so **Connect this device**, account refresh and disconnect, owner enrollment checks,
legacy owner resolution and legacy team completion compile on an affected D1. The built-in
coordinator and local Wrangler bundle SQLite 3.53.4, which never had the limit, so ordinary
local tests cannot show a regression.

`pnpm --filter @codemem/cloudflare-coordinator-worker check:d1-statements` compiles every
coordinator statement, of any length, on Wrangler's local D1, which runs the same SQLite as
production. It records each statement, with the schema it was prepared on, while the core
coordinator tests run, and compiles it on each of those schemas with its parameters bound
to NULL. The check fails when a statement exceeds a D1 limit on any schema, compiles on none
of them, or a schema object cannot be created. The limits it recognizes are D1's documented
ones (columns per table, bound parameters, function arguments, statement and value size,
LIKE patterns) and its SQLite's caps on `WITH` nesting, expression depth, result columns
and compound `SELECT` terms. `scripts/d1-statement-check/classify.mjs` lists the few
statements whose failure is excused because they never run on D1, such as test probes and
the local memory store, each by the exact function and SQL that prepare it. The check prints
every excused statement, and it fails when an excuse matches nothing. Statements that no
captured test prepares are not checked. Its report gives the seconds spent capturing and
compiling separately.

CI runs this check as its own job alongside the Worker tests. Pull requests that change
neither `packages/core` nor the Worker package nor the lockfile skip it. Set
`CODEMEM_D1_STATEMENT_CHECK_VERBOSE=1` to list the checked statements.

To check one statement against a real database without running it, prefix it with `EXPLAIN`
and replace each `?` with a literal:

```fish
wrangler d1 execute codemem-coordinator --remote --command "EXPLAIN <statement>"
```

## Current limitations

- the Worker path is still secondary to the built-in coordinator runtime
- enrollment remains operator-managed rather than polished end-user onboarding
- direct peer sync is still separate from coordinator discovery
- new coordinator features may land in the built-in runtime first and reach the Worker later
- on a D1 that runs SQLite 3.54.0 or 3.54.1, some account actions answer 503; see
  [the troubleshooting entry](#account-routes-answer-503-auth_link_unavailable-on-d1)
