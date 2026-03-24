# Deploying the coordinator

The built-in coordinator is the canonical deployment target for team sync. This guide covers how to run it
natively, in a container, and how to expose it to teammates outside your local network.

## Quick start (native)

```fish
# Install codemem CLI (makes the `codemem` command available)
npm install -g codemem

# Create a coordinator group
codemem sync coordinator group-create my-team --db-path ~/.codemem/coordinator.sqlite

# Set an admin secret (required for creating invites via the API)
set -x CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET (openssl rand -base64 32)

# Start the coordinator
codemem sync coordinator serve --db-path ~/.codemem/coordinator.sqlite --host 0.0.0.0 --port 7347
```

The coordinator is now listening on port 7347. Devices on the same network can connect using this machine's IP address.

**Important:** Save the admin secret — you'll need it in your client config to create invites from the UI or API. The
coordinator rejects admin operations (invite creation, join request review) without it.

## CLI reference

### Coordinator server

```fish
codemem sync coordinator serve [OPTIONS]
```

| Option      | Default       | Description                            |
|-------------|---------------|----------------------------------------|
| `--db-path` | (required)    | Path to coordinator SQLite database    |
| `--host`    | `127.0.0.1`   | Bind address (`0.0.0.0` for all interfaces) |
| `--port`    | `7347`        | Listen port                            |

### Team management

```fish
# Create a group
codemem sync coordinator group-create <group-id> --db-path <path>

# Enroll a device directly (admin)
codemem sync coordinator enroll-device <group-id> <device-id> \
  --fingerprint <fingerprint> --public-key-file <path> --db-path <path>

# List enrolled devices
codemem sync coordinator list-devices <group-id> --db-path <path>

# Rename, disable, or remove a device
codemem sync coordinator rename-device <group-id> <device-id> --name "work-laptop" --db-path <path>
codemem sync coordinator disable-device <group-id> <device-id> --db-path <path>
codemem sync coordinator remove-device <group-id> <device-id> --db-path <path>
```

### Invite and join flow

```fish
# Create an invite (admin)
codemem sync coordinator create-invite <group-id> --db-path <path>

# Import an invite (teammate)
codemem sync coordinator import-invite <encoded-invite>

# List pending join requests (admin)
codemem sync coordinator list-join-requests <group-id> --db-path <path>

# Approve or deny (admin)
codemem sync coordinator approve-join-request <request-id> --db-path <path>
codemem sync coordinator deny-join-request <request-id> --db-path <path>
```

## Container deployment

No official Dockerfile is shipped yet. Here is a minimal example:

```dockerfile
FROM node:24-slim

RUN npm install -g codemem

VOLUME /data

EXPOSE 7347

ENTRYPOINT ["codemem", "sync", "coordinator", "serve", \
  "--db-path", "/data/coordinator.sqlite", \
  "--host", "0.0.0.0", "--port", "7347"]
```

Build and run:

```fish
docker build -t codemem-coordinator .
docker run -d --name coordinator -p 7347:7347 -v coordinator-data:/data codemem-coordinator
```

Initialize the group from the host:

```fish
docker exec coordinator codemem sync coordinator group-create my-team --db-path /data/coordinator.sqlite
```

## Exposing the coordinator

If your teammates are not on the same LAN, you need to make the coordinator reachable. Two recommended options:

### Tailscale Funnel

Tailscale Funnel exposes a local port to the internet via your Tailscale network with automatic TLS.

```fish
# Start the coordinator
codemem sync coordinator serve --db-path ~/.codemem/coordinator.sqlite --host 0.0.0.0 --port 7347

# In another terminal, expose via Funnel
tailscale funnel 7347
```

Teammates configure their client with the Funnel URL (e.g. `https://your-machine.ts.net:443`).

### Cloudflare Tunnel

Cloudflare Tunnel exposes a local port through Cloudflare's network, giving you a stable public hostname with TLS.

```fish
# Start the coordinator
codemem sync coordinator serve --db-path ~/.codemem/coordinator.sqlite --host 127.0.0.1 --port 7347

# Start the tunnel
cloudflared tunnel --url http://localhost:7347
```

Use the generated `*.trycloudflare.com` URL for quick testing, or configure a named tunnel with a custom domain for
production use.

## Client configuration

Once the coordinator is reachable, teammates configure their codemem client:

**Admin's machine** (the device running the coordinator):

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://coord.example.com",
  "sync_coordinator_group": "my-team",
  "sync_coordinator_admin_secret": "<the secret you generated above>"
}
```

The admin secret lets you create invites and review join requests from the viewer UI or API. Only the admin needs this.

**Teammate devices:**

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://coord.example.com",
  "sync_coordinator_group": "my-team"
}
```

Or via environment variables:

```fish
set -x CODEMEM_SYNC_COORDINATOR_URL "https://coord.example.com"
set -x CODEMEM_SYNC_COORDINATOR_GROUP "my-team"
```

Or through the viewer UI: Settings → Device Sync → Coordinator URL / Group.

**Note:** Teammates who join via an invite link don't need to configure anything manually — the invite import
auto-configures `sync_coordinator_url` and `sync_coordinator_group`.

## Onboarding teammates

### Admin-driven enrollment

The admin enrolls a teammate's device directly:

```fish
codemem sync coordinator enroll-device my-team <device-id> \
  --fingerprint <fingerprint> --public-key-file <path> \
  --db-path ~/.codemem/coordinator.sqlite
```

### Invite-driven enrollment (recommended)

The admin creates an invite and shares it:

```fish
codemem sync coordinator create-invite my-team --db-path ~/.codemem/coordinator.sqlite
```

This outputs an encoded invite string. Share it with the teammate, who imports it:

```fish
codemem sync coordinator import-invite <encoded-invite>
```

Or paste the invite in the viewer UI under Team sync → Join team.

If the invite policy is `approval_required`, the teammate's join request will appear in the admin's pending queue. The
admin approves it from the CLI or the viewer UI.

## Data model

The coordinator stores:

- group definitions
- enrolled device records (device ID, public key, fingerprint, display name, status)
- presence records (device addresses, TTL-based expiry)
- invite tokens (group-scoped, policy, expiry)
- join requests (pending, approved, denied)

All data lives in a single SQLite database. The coordinator does **not** store or relay memory payloads — direct
peer-to-peer sync remains the data path.

## Troubleshooting

**Coordinator not reachable**: verify the `--host` binding. Use `0.0.0.0` to listen on all interfaces. Check firewall
rules and that the tunnel/funnel is active.

**Device not enrolled**: run `codemem sync coordinator list-devices <group> --db-path <path>` to confirm enrollment.
Use the invite flow for self-service enrollment.

**Presence not refreshing**: check that the client's `sync_coordinator_url` matches the coordinator's reachable address
and that `sync_coordinator_group` matches a group the device is enrolled in.
