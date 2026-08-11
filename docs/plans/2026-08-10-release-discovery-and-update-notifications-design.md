# Release Discovery and Update Notifications

## Status

Approved for implementation on 2026-08-10.

## Problem

Codemem's existing backend compatibility check compares the active runtime with a configured minimum version. It does not discover newer stable releases. As a result, healthy installations can remain several releases behind without notifying users, and operators must inspect and upgrade every device manually.

## Goals

- Notify users when a newer stable Codemem release is available.
- Expose the same release status through the CLI, OpenCode plugin, and Viewer.
- Show optional runtime versions for paired devices so fleet drift is visible.
- Support opt-in automatic updates for eligible npm installations.
- Give Docker operators exact rebuild guidance without granting Codemem access to the Docker socket.

## Non-goals

- Remote command execution or fleet-wide unattended orchestration.
- Automatic Docker image or container replacement.
- Updating repository-development, pinned, prerelease, downgrade, or unknown installations.
- Using reported runtime versions for authorization, trust, or protocol negotiation.
- Replacing the existing minimum-version compatibility check.

## Product policy

`notify` remains the default update policy. `auto` requires explicit configuration. Notifications can appear as soon as a newer stable release is discovered, while automatic installation requires the release to have been observed for at least 24 hours.

The existing `CODEMEM_BACKEND_UPDATE_POLICY` values remain the policy surface:

- `notify`: report newer stable releases and provide an installation-specific action.
- `auto`: notify immediately, then install only after the first-seen delay when the runner is eligible.
- `off`: perform no user-facing release notification or automatic installation.

Compatibility-floor checks remain separate and continue to run even though they share the policy value.

## Architecture

### Shared release discovery

`@codemem/core` owns a leaf release-discovery module with no store, SQLite, sync, or embedding dependencies. The module:

- Queries the fixed npm registry endpoint for `codemem`.
- Accepts only bounded, stable semantic versions.
- Uses an injected fetch implementation and clock for deterministic tests.
- Applies a short timeout, process-local single-flight behavior, and a six-hour refresh interval.
- Persists disposable device-local cache state under the Codemem home directory using an atomic write.
- Records when the current latest version was first observed.
- Reuses a valid stale cache after refresh failure but never authorizes an automatic update from failed or malformed refresh data.

The shared result uses a stable, additive JSON contract:

```ts
interface UpdateStatus {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  first_seen_at: string | null;
  checked_at: string | null;
  stale: boolean;
  install_kind: "npm-global" | "npx" | "docker" | "repo-dev" | "pinned" | "unknown";
  auto_update_eligible: boolean;
  recommended_action: string;
  error: string | null;
}
```

### CLI

`codemem update check` is the canonical human and automation surface. It supports `--json` and `--refresh`. Human output explains whether the installation is current and what to do next. JSON output is one stable object. An unavailable check returns structured failure output and a non-zero exit code unless valid stale status can answer the request.

The later automatic-update slice adds `codemem update install`. It refuses ineligible installation kinds before executing anything.

### Plugin and Viewer

The OpenCode plugin invokes the CLI update check through its existing runner boundary rather than importing core. Release notifications are distinct from compatibility warnings and are rate-limited to once per discovered release. The plugin reuses its existing argv-based process execution and guarded viewer restart path.

The Viewer exposes a dedicated update-status route. `/api/runtime` remains a local readiness endpoint and never performs registry work. The Health page renders current, available, stale, and unavailable states with installation-specific guidance.

### Peer runtime versions

The signed peer status response may include an optional `runtime_version`. Receivers validate its length and stable-semver shape after the existing peer identity and fingerprint checks, then persist it in nullable additive peer columns. Missing or malformed values become unknown.

The Devices UI may display a paired peer's reported version. The value is informational only and must not participate in capability negotiation, trust seeding, authorization, or update execution.

### Installation kinds

- `npm-global`: eligible for opt-in automatic installation.
- `npx`: receives runner-specific guidance; automatic behavior is allowed only where the existing updater can prove an unpinned generic source.
- `docker`: never self-updates; guidance names the durable version pin and Compose rebuild/start workflow.
- `repo-dev`, `pinned`, and `unknown`: never self-update.

Detection fails closed to `unknown`. Docker images set an explicit installation-kind marker rather than relying exclusively on filesystem heuristics.

## Failure and security behavior

- Registry access uses a fixed HTTPS origin and strict response validation.
- Fetch, cache, and toast failures never block plugin or Viewer startup.
- Cache writes are atomic; malformed cache content is ignored.
- Stale cache data may inform a notification but cannot trigger installation.
- Automatic updates never select prereleases, downgrades, or versions other than the validated latest stable release.
- Commands are executable-plus-argv arrays and never shell strings.
- Successful installation is verified by querying the active CLI version.
- Viewer restart is attempted only when the plugin started and owns that viewer lifecycle.
- Docker and unknown environments return guidance instead of executing a process.

## Validation

- Release resolver unit tests cover semantic versions, first-seen transitions, cache expiry, stale fallback, malformed data, timeout, atomic-write failure, and single-flight behavior.
- CLI tests cover human output, JSON output, forced refresh, stale success, and structured failure.
- Plugin tests cover `notify`, `off`, delayed `auto`, ineligible runners, failed installation, verification, and guarded restart.
- Viewer tests cover the route contract and Health banner states.
- Sync tests cover current, missing legacy, oversized, malformed, and untrusted reported versions.
- Devices tests cover version presentation without changing device identity or status behavior.
- Each stack slice runs focused tests; the complete stack runs the UI build and `pnpm run check`.

## Delivery stack

1. `feat(update): add release discovery`
2. `feat(update): surface release notifications`
3. `feat(sync): report peer runtime versions`
4. `feat(update): enable opt-in npm upgrades`

Each pull request is independently reviewable. Release discovery lands without UI or execution behavior; notifications remain read-only; peer versions remain display-only; automatic execution is isolated in the top pull request.
