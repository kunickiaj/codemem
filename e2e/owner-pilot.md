# Isolated owner-pilot runbook

This unpublished, opt-in pilot checks an owner-enrollment handoff between two
fresh, disposable profiles. It is **not live verified**. The existing app server,
Worker, and public CLI entrypoints are unchanged.

Run it only from an unpublished source checkout on Node 24 with the pnpm version pinned in the root `packageManager` field.
Use two owned devices (A and B), each with a new disposable codemem profile. Do not
point commands at a normal database, config, or key directory. Use the device's
own external browser; do not import browser profiles, cookies, or credentials.

## Approval and prerequisites

Obtain separate explicit approval before using real Google credentials, registering
the redirect URI, using a live Google run, binding a private network address, or
using a real HTTPS origin and certificate. This runbook does not grant that
approval.

Before starting, have all of the following:

- An owned hostname under a public DNS suffix that resolves to the approved private
  bind address. Its certificate must chain to a public CA trusted by both Node 24
  and the devices' external browsers; OS-only trust is not sufficient for Node's
  default fetch. Public DNS does not require exposing this server publicly.
- Google OAuth client credentials whose registered redirect URI is exactly
  the chosen origin plus `/auth/callback`.
- An administrator secret available only in the environment on the coordinator
  host.
- Fresh, empty directories for pilot coordinator state and profiles A and B.

Do not install or trust a new CA, override certificate checks, set
`NODE_TLS_REJECT_UNAUTHORIZED=0`, write an `.env` file, deploy publicly, migrate
a normal database, or delete a profile. This pilot does not reset or clean up
anything automatically. Profile deletion needs the profile owner's explicit
approval.

`pilot.example.com` below is a placeholder: replace it with your owned hostname.
Use an explicit nonprivileged port such as `7348`; the runner refuses port `443`
or an origin without a port. Register the exact callback including that port,
for example `https://pilot.example.com:7348/auth/callback`. Do not run as root or
change system port privileges to make this pilot work.
Google Web-client redirect registration rejects raw IP addresses and private or
reserved suffixes such as `.test`. Do not try to fix a rejected URI or certificate
by disabling TLS checks or adding a new trust root.

## Initialize isolated state

Choose new IDs and directories. `init` requires a new state directory and creates
it with mode `0700`; never reuse an attempt, group, or profile.

```fish
set state_dir "./.tmp/owner-pilot-state"
set profile_a "./.tmp/owner-pilot-a"
set profile_b "./.tmp/owner-pilot-b"
set origin "https://pilot.example.com:7348"
set coordinator_id "owner-pilot-coordinator"
set group_id "owner-pilot-group"

mkdir -p .tmp
pnpm run owner:pilot -- init --state "$state_dir" --origin "$origin" \
  --coordinator-id "$coordinator_id" --group "$group_id"
begin
  set -lx CODEMEM_CONFIG "$profile_a/config.json"
  pnpm run owner:pilot -- init-device --profile "$profile_a" --name "Pilot owner A"
end
```

Record A's `deviceId` and `fingerprint`. Initialization creates A's canonical actor
and name, but no memory or ownership binding.

Enroll A before any review:

```fish
pnpm run codemem -- coordinator enroll-device "$group_id" "$a_device_id" \
  --fingerprint "$a_fingerprint" \
  --public-key-file "$profile_a/keys/device.key.pub" \
  --db-path "$state_dir/coordinator.sqlite"
```

## Review and link A

In a coordinator-host terminal, start the link phase with the approved certificate
and key. `--bind` is optional; omit it for loopback.

```fish
begin
  set -lx CODEMEM_OWNER_PILOT_CLIENT_ID "$OWNER_PILOT_CLIENT_ID"
  set -lx CODEMEM_OWNER_PILOT_CLIENT_SECRET "$OWNER_PILOT_CLIENT_SECRET"
  set -lx CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET "$OWNER_PILOT_ADMIN_SECRET"
  pnpm run owner:pilot -- serve --state "$state_dir" --phase link \
    --cert "./.tmp/pilot-cert.pem" --key "./.tmp/pilot-key.pem" --bind "192.168.1.20"
end
```

On A, scope the profile config and key directory. The review is interactive: `--json`
only previews and the review output does not print an attestation ID.

```fish
begin
  set -lx CODEMEM_CONFIG "$profile_a/config.json"
  set -lx CODEMEM_KEYS_DIR "$profile_a/keys"
  set -lx CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET "$OWNER_PILOT_ADMIN_SECRET"
  pnpm run codemem -- coordinator review-device-owner "$group_id" --coordinator "$origin" \
    --config "$profile_a/config.json" --db-path "$profile_a/mem.sqlite"
  pnpm run codemem -- coordinator link-account "$group_id" --coordinator "$origin" \
    --config "$profile_a/config.json" --db-path "$profile_a/mem.sqlite"
end
```

## Enroll B

Stop the link-phase process, then start the owner phase with the same state, origin,
credentials, and administrator secret. Do not initialize a new coordinator.

```fish
begin
  set -lx CODEMEM_OWNER_PILOT_CLIENT_ID "$OWNER_PILOT_CLIENT_ID"
  set -lx CODEMEM_OWNER_PILOT_CLIENT_SECRET "$OWNER_PILOT_CLIENT_SECRET"
  set -lx CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET "$OWNER_PILOT_ADMIN_SECRET"
  pnpm run owner:pilot -- serve --state "$state_dir" --phase owner \
    --cert "./.tmp/pilot-cert.pem" --key "./.tmp/pilot-key.pem" --bind "192.168.1.20"
end
```

Issue the grant only for A's currently reviewed device. It selects that current
attestation from the maintained store; no attestation ID is accepted from the terminal.

```fish
pnpm run owner:pilot -- issue-grant --state "$state_dir" --device "$a_device_id"

# On B, in an interactive terminal:
begin
  set -lx CODEMEM_CONFIG "$profile_b/config.json"
  set -lx CODEMEM_KEYS_DIR "$profile_b/keys"
  pnpm run owner:pilot -- enroll-b --profile "$profile_b" \
    --coordinator "$origin" --group "$group_id"
  pnpm run codemem -- sync pair --payload-only --db-path "$profile_b/mem.sqlite" --config "$profile_b/config.json"
end
```

`enroll-b` prints B's public device ID and fingerprint before the private browser
URL. Compare both values with the confirmation page, then keep the URL private. Its
receipt Identity must match A's; it persists B's metadata without changing the key.
Record B's device ID from that output. Do not use manual SQL.

Before a final request exists, abandon only this unused disposable profile. After it
exists, use `enroll-b --resume` with the **same** profile, group, and coordinator.
Its exact saved request is mode `0600`; no new attempt or rollback. A config-only
failure after the database commit also resumes.

The pilot's config lock records its process and receipt/key context. Resume clears
only a verified dead pilot writer's lock, never a live writer's lock. Empty legacy,
foreign, or unverifiable locks stop the run unchanged; do not delete them without
explicit operator review. The proof and receipt remain available for that review.

## Scope, project mapping, and delivery

Do not capture or sync before B finishes. After separate explicit membership/trust
approval, create a Sharing domain and grant both devices. Give A `owner` only when
needed to make this scope writable for A's project mapping:

```fish
set scope_id "owner-pilot-scope"
pnpm run codemem -- coordinator create-scope "$group_id" "$scope_id" \
  --label "Owner pilot" \
  --coordinator-id "$coordinator_id" \
  --db-path "$state_dir/coordinator.sqlite"
pnpm run codemem -- coordinator grant-scope-member "$group_id" "$scope_id" "$a_device_id" \
  --effect-id "owner-pilot-grant-a" --role owner \
  --db-path "$state_dir/coordinator.sqlite"
pnpm run codemem -- coordinator grant-scope-member "$group_id" "$scope_id" "$b_device_id" \
  --effect-id "owner-pilot-grant-b" \
  --db-path "$state_dir/coordinator.sqlite"
```

On A, activate the existing sync runtime without changing the profile config. Bind
the viewer only to an owned private interface, and retain the terminal while mapping:

```fish
begin
  set -lx CODEMEM_CONFIG "$profile_a/config.json"
  set -lx CODEMEM_KEYS_DIR "$profile_a/keys"
  set -lx CODEMEM_SYNC_ENABLED true
  set -lx CODEMEM_SYNC_COORDINATOR_URL "$origin"
  set -lx CODEMEM_SYNC_COORDINATOR_GROUP "$group_id"
  pnpm run codemem -- serve start --foreground --host "192.168.1.20" \
    --db-path "$profile_a/mem.sqlite" --config "$profile_a/config.json"
end
```

Create a synthetic project-inventory marker with the same project name that the
delivery memory will use. Do not pair peers yet. This gives the empty profile a
Project to select; the marker is setup data, not delivery evidence.

```fish
begin
  set -lx CODEMEM_CONFIG "$profile_a/config.json"
  set -lx CODEMEM_KEYS_DIR "$profile_a/keys"
  pnpm run codemem -- memory remember -k discovery -t "Owner pilot project marker" \
    -b "Synthetic project inventory only." --project owner-pilot --db-path "$profile_a/mem.sqlite"
end
```

In the existing Advanced **Sharing domains** UI, choose that operator-selected
A Project, then assign it to `owner-pilot-scope`. Use the UI's discovered canonical
workspace identity from the project inventory; do not enter a fixed path or invent
an identity. The UI uses `GET /api/sync/projects` and saves the explicit mapping via
`PUT /api/sync/sharing-domains/project-mappings`.

Review every mapping warning. If the UI asks for guardrail confirmation, confirm only
the tokens it shows after the operator has reviewed the warning; do not use raw SQL,
API calls, or an automatic waiver. Stop if the Project is shown as unmapped/local-only
or the scope is not writable after the approved membership change.

After mapping, add one fresh memory on A only:

```fish
begin
  set -lx CODEMEM_CONFIG "$profile_a/config.json"
  set -lx CODEMEM_KEYS_DIR "$profile_a/keys"
  pnpm run codemem -- memory remember -k discovery -t "Owner pilot memory" \
    -b "Signed pilot delivery check." --project owner-pilot --db-path "$profile_a/mem.sqlite"
end
```

On both profiles, use the same lexical environment (`CODEMEM_SYNC_ENABLED=true`,
coordinator URL/group, `CODEMEM_CONFIG`, and `CODEMEM_KEYS_DIR`), privately exchange
`sync pair --payload-only` payloads, and accept each with `sync pair --accept-file`.
Run `sync once` only after both accepts. Start B's viewer the same way as A's, with
B's profile DB/config and an owned private interface. The viewer-backed runtime
refreshes signed coordinator scope state; `sync daemon` is not current, and `config
workspace` is unnecessary.

Do not create Teams, automatic grants, invitations, recovery flows, or offline leases to bypass this process. Do not rerun the fresh client as a normal migration.

## Completion evidence

Do not call the pilot successful merely because the wiring check passes:

```fish
pnpm run owner:pilot:check
```

It checks source wiring only, not live Google or two-device acceptance. Planned exit
criteria are A's account link, B's binding and audit, the same receipt Identity, a
new B process with that actor ID and unchanged key, no pre-authorization delivery,
and one signed portable memory after explicit grants without A's working directory,
Git state, or deduplication data. Live data flow remains unverified until an approved
real run observes those facts.
