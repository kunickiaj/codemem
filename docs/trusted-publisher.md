# npm Trusted Publishing Setup

This project uses GitHub OIDC + npm provenance for release publishing.

## Required npm configuration

Use npm trusted publishing for this GitHub repo:

- **Owner**: `kunickiaj`
- **Repository**: `codemem`
- **Workflow**: `release.yml`
- **Environment**: `release`

Trusted publishing must be configured for every package the workflow publishes:

- `@codemem/core`
- `@codemem/mcp`
- `@codemem/server`
- `codemem`
- `@codemem/opencode-plugin`

## GitHub workflow behavior

`.github/workflows/release.yml` publishes from two triggers:

- `push` of a `v*` tag — the normal release path.
- `workflow_dispatch` with a `tag` input — a recovery path for re-running a
  failed release without retagging.

In both cases the publish job checks out the workspace at the resolved tag,
builds, and then runs `Publish packages`. Each package is published in
dependency order:

1. `@codemem/core`
2. `@codemem/mcp`
3. `@codemem/server`
4. `codemem`
5. `@codemem/opencode-plugin`

Publish command shape:

- `pnpm --filter <package> publish --provenance --access public --tag <dist-tag>`

The publish step is **idempotent per package version**: before publishing it
checks `npm view <name>@<version>` and skips any package whose exact version is
already on the registry. A rerun after a partial failure publishes only the
packages still missing.

Dist-tag selection is automatic from the resolved release tag:

- `*-alpha*` → `alpha`
- `*-beta*` → `beta`
- `*-rc*` → `rc`
- otherwise → `latest`

## Re-running a failed release

If `Publish to npm` fails partway through (for example a transient OIDC error
on one package), use the `workflow_dispatch` path instead of retagging:

1. Confirm the tag (e.g. `v0.31.1`) still points at the merged release commit.
2. Trigger the workflow on `main` with the tag input:
   - `gh workflow run release.yml --ref main -f tag=v0.31.1`
3. The workflow checks out the tag, skips the `CI` job (already passed for
   the original tag push), and reruns `Publish to npm`. Already-published
   versions are skipped, missing ones are published.
4. The `Create GitHub Release` job runs after publish and is also idempotent —
   it skips creation if the release already exists.

## Verification checklist

- Tag push `vX.Y.Z` runs `Release` and `publish-npm` succeeds
- All five package versions on npm match the release tag
- npm provenance attestation is present for published artifacts
- For recovery: `workflow_dispatch` rerun completes with `skip:` lines for
  packages already at the tag's version and `publish:` lines for any that
  were missing
