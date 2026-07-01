# Docker deployment example

This directory runs codemem from the published npm package, not from a source checkout.
It is intended for a NAS, homelab server, or other Docker host where the viewer and MCP
HTTP server should share one persistent codemem database.

The default topology is:

```text
Tailscale Funnel / HTTPS ingress
  -> 127.0.0.1:38889/mcp  codemem MCP HTTP server

Tailscale private access / local host
  -> 127.0.0.1:38888      codemem viewer

Peer-to-peer sync
  -> NAS Tailnet/LAN address:7337  codemem sync protocol
```

No Caddy container is included because Tailscale Funnel or another ingress is expected
to terminate TLS before forwarding to the MCP port.

## Files

- `Dockerfile` installs `codemem` from npm using `CODEMEM_VERSION`.
- `docker-compose.yml` starts two containers from the same image:
  - `codemem-viewer` on container port `38888`
  - `codemem-mcp` on container port `38889`
- `environment.example` lists the required runtime settings.

## Setup

From this directory:

```fish
cp environment.example .env
```

Edit `.env` and set:

- `CODEMEM_MCP_HTTP_PUBLIC_URL` to the public MCP URL, including `/mcp`
- `CODEMEM_MCP_OIDC_ISSUER_URL`
- `CODEMEM_MCP_OIDC_CLIENT_ID`
- `CODEMEM_MCP_OIDC_CLIENT_SECRET`
- `CODEMEM_MCP_OAUTH_ALLOWED_EMAIL` or `CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT`
- `CODEMEM_SYNC_ADVERTISE` to the NAS Tailnet/LAN sync URL

Build and start:

```fish
docker compose up -d --build
```

Check status:

```fish
docker compose ps
docker compose logs -f codemem-mcp
```

The Compose file sets container DNS to `1.1.1.1` and `8.8.8.8`. Some NAS Docker
setups have working host networking but broken container DNS, especially with VPN or
Tailscale packages installed. If you create containers through a UI instead of Compose,
set the same DNS servers there.

## Tailscale Funnel

Expose only the MCP port publicly. For example, from the Docker host:

```fish
tailscale funnel --bg 38889
```

Then add the custom connector in Claude with the same URL configured as
`CODEMEM_MCP_HTTP_PUBLIC_URL`.

The viewer port is intentionally bound to `127.0.0.1` on the Docker host. Do not expose
the viewer publicly unless you add your own authentication layer.

## Sync address advertisement

When Docker runs in bridge mode, codemem's automatic address discovery sees container
network interfaces, not the NAS host's Tailscale interface. Set an explicit advertised
sync address so other peers and the coordinator learn a dialable address:

```text
CODEMEM_SYNC_PORT=7337
CODEMEM_SYNC_BIND_IP=0.0.0.0
CODEMEM_SYNC_ADVERTISE=http://your-nas-tailnet-name:7337
```

`CODEMEM_SYNC_ADVERTISE` should be reachable from your other peers. With Tailscale on
the NAS host, use the NAS MagicDNS name or 100.x Tailnet IP. The Compose file publishes
host port `7337` to the viewer container because `codemem serve` owns the sync listener.

The Compose example passes `CODEMEM_SYNC_ENABLED` from `environment.example` into the
viewer container. Keep it set to `1` so sync starts automatically after the container has
coordinator config and a trusted peer. After importing a team invite, restart the services
so the long-running viewer process picks up the updated config:

```fish
docker exec -it codemem-viewer codemem coordinator import-invite '<invite>'
docker restart codemem-viewer codemem-mcp
```

The Compose environment sets `CODEMEM_DB`, `CODEMEM_CONFIG`, and `CODEMEM_KEYS_DIR`, so
commands executed inside `codemem-viewer` use the shared mounted database, config, and
keys by default.

## Persistent data

Compose creates named volumes:

- `codemem-data` for `/data/mem.sqlite`
- `codemem-config` for `/config/codemem.json`
- `codemem-keys` for sync keys and peer identity material
- `codemem-home` for `/home/node/.codemem`, including hosted-connector OAuth state

Both services use the same database path:

```text
/data/mem.sqlite
```

The MCP service stores dynamically registered hosted-connector clients and token hashes
in `/home/node/.codemem/mcp-oauth-state.json`. Keep `codemem-home` mounted across
image upgrades and container recreates so Claude, ChatGPT, and other hosted MCP clients
do not lose their registered `client_id`s after a redeploy.

## Observer credentials

Observer/model credentials are optional for this deployment. If the NAS is only an
always-on retrieval and sync peer, leave observer settings unset. Search, MCP retrieval,
viewer browsing, and sync still work as long as the memories are already present in the
shared database.

Configure an observer only if you want this Docker host to extract new memories from raw
events or other ingestion backlogs. For example, with OpenCode Zen:

```text
CODEMEM_OBSERVER_PROVIDER=opencode
CODEMEM_OBSERVER_MODEL=opencode/gpt-5.4-mini
CODEMEM_OBSERVER_API_KEY=...
OPENCODE_API_KEY=...
```

Do not bake observer API keys into the Dockerfile or committed Compose file. Put them in
the local `.env`, Docker secrets, or the container manager's private environment settings.

## Useful commands

```fish
docker compose pull
docker compose up -d --build
docker compose restart codemem-mcp
docker compose logs -f codemem-viewer
```
