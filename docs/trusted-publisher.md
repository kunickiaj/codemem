# npm Trusted Publishing Setup

This project uses GitHub OIDC + npm provenance for release publishing.

## Required npm configuration

Use npm trusted publishing for this GitHub repo:

- **Owner**: `kunickiaj`
- **Repository**: `codemem`
- **Workflow**: `release.yml`
- **Environment**: `release`

## GitHub workflow behavior

`.github/workflows/release.yml` publishes on `v*` tags via the `publish-npm` job.

Published packages (in dependency order):

1. `@codemem/core`
2. `@codemem/mcp`
3. `@codemem/server`
4. `codemem`

Publish command shape:

- `pnpm --filter <package> publish --provenance --access public --tag <dist-tag>`

Dist-tag selection is automatic from the Git tag:

- `*-alpha*` → `alpha`
- `*-beta*` → `beta`
- `*-rc*` → `rc`
- otherwise → `latest`

## Verification checklist

- Tag push `vX.Y.Z` runs `Release`
- `publish-npm` job succeeds
- Package versions on npm match the release tag
- npm provenance attestation is present for published artifacts
