# Viewer Screenshot Guide

Use the synthetic viewer to capture the current generated UI without opening a real Codemem database or configuration. The fixture content is fictional. Do not use a real database, configuration, device name, project name, or local path.

## Start the fixture

Build the UI, then start the foreground fixture. It prints JSON containing a random loopback URL; open that URL in a dedicated CMux docs surface.

```fish
pnpm --filter @codemem/ui build
pnpm exec tsx --conditions source scripts/docs-viewer.ts
```

Leave that command running. In a second terminal, use the printed URL to create a browser surface, then copy the returned surface reference:

```fish
set viewer_url "http://127.0.0.1:<printed-port>"
cmux browser open "$viewer_url" --focus false --json
set surface "<returned-surface-ref>"
cmux browser --surface "$surface" viewport 1440 1050
cmux browser --surface "$surface" wait --text "Reject duplicate watering commands" --timeout-ms 10000
cmux browser --surface "$surface" snapshot --interactive
```

The launcher starts a sanitized child with a fresh temporary database containing six invented private memories for `atlas-notes` and `garden-api`. It disables embeddings, observer work, sweeper work, sync, and update checks, and blocks non-loopback server calls through `fetch`. That block does not cover other HTTP clients or raw sockets; the viewer also loads public CDN fonts and icons in the browser, so this is not a network sandbox.

The fixture serves the current working tree, including uncommitted UI changes. It is visual evidence only—not release evidence or validation of extraction or semantic-recall quality. Stop it with `ctrl-c`; its temporary runtime remains available for inspection. After stopping the fixture, verify the printed runtime belongs to this run before removing it manually; never substitute your normal Codemem directory.

## Capture

Use a dedicated docs workspace/surface, wait for the page to render, and capture only the browser viewport. A background CMux workspace can return text while its paint is suspended, producing a blank image.

Before **every** capture—and again after navigation or reload—inject this CSS. It hides only the fixture database-path line; it does not change memory text or controls.

```fish
cmux browser --surface "$surface" addstyle '#metaLine { visibility: hidden !important; }'
```

Create an inspection directory and write captures there first:

```fish
mkdir -p .tmp/docs-screenshots
cmux browser --surface "$surface" screenshot --out ".tmp/docs-screenshots/docs-feed-dark.png" --json
```

Set the viewport to `1440x1050`, wait for rendering, then capture these states:

- Feed in dark theme: `docs-feed-dark.png`
- Feed in light theme: `docs-feed-light.png`
- Feed with a memory's **Facts** button active, dark theme: `docs-memory-facts-dark.png`
- Feed with a memory's **Facts** button active, light theme: `docs-memory-facts.png`
- Projects, dark theme: `docs-projects-dark.png`
- Projects, light theme: `docs-projects.png`

CMux screenshots capture the viewport only; do not describe them as full-page captures. Do not capture the terminal or the full desktop.

### Devices sync status

The Devices captures use the current built viewer assets with fictional API responses. Laptop is the local device. Three paired devices show the following states:

| Device | Fixture state | Expected presentation |
| --- | --- | --- |
| Studio | Send and receive succeeded | Recent exchange, with acknowledged and applied operation counters. |
| Workshop | Receive succeeded, send has not been observed | Not verified overall, with successful receiving shown separately. |
| Notebook | Send failed, receive has not been observed | Needs attention, with unknown history left unavailable. |

The helper freezes the browser clock and uses US Pacific time. The overall summary shows `needs_attention`, even though Studio succeeded. A successful peer cannot hide an unknown or failing peer.

The capture fixture must return the current `sync_health` API contract. Each peer response uses a `sync_health` object with an overall `state` and separate `send` and `receive` directions. Each direction may include `last_attempt_at`, `last_success_at`, `operations_24h`, `pending_count`, and `reason_code`; absent history uses `null`. The root `/api/sync/status` response summarizes peer, attention, unverified, and stale counts in its own `sync_health` object.

Build the current UI and run the helper from the repository root:

```fish
pnpm --filter @codemem/ui exec playwright install --no-remove chromium
pnpm --filter @codemem/ui build
pnpm exec tsx --conditions source scripts/docs-sync-screenshots.ts
```

The first command installs the browser if needed and keeps other installed browser versions.

The helper:

- serves `packages/viewer-server/static` on loopback
- fulfills every viewer API request with fictional fixture data
- blocks external requests, WebSockets, mutations, and unmatched API routes
- writes `docs-devices-sync-dark.png` and `docs-devices-sync-light.png` to `.tmp/docs-screenshots/` for inspection before publication.

The helper captures the Devices viewport at `1440x1050` in both themes. After inspection, copy the files to `docs/images/docs-devices-sync-dark.png` and `docs/images/docs-devices-sync-light.png`. Link those checked-in images in the PR description and identify the data as fictional.

## Publish after review

Inspect each temporary image before copying it to `docs/images/`. Confirm that it contains no private data or local paths, uses the intended theme and fixture content, has the fixed viewport, and carries the expected fixture state. Keep the Projects image framed as an informational review state: it has two Sharing review findings, no recipients, and no sync activity. For Devices, confirm that the fixture contains only Laptop, Studio, Workshop, and Notebook, that the overall state shows attention, and that the capture has no browser error or blocked-request overlay. The local Laptop row appears as **This device**.
