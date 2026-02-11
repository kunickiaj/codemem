# PyPI Trusted Publisher Setup

This project uses GitHub OIDC to publish to PyPI without long-lived API tokens.

## Required PyPI configuration

Create a Trusted Publisher entry for each project:

- `codemem`
- `codemem-core`

Production PyPI values:

- **Owner**: `kunickiaj`
- **Repository name**: `codemem`
- **Workflow name**: `release.yml`
- **Environment name**: `release`

TestPyPI values:

- **Owner**: `kunickiaj`
- **Repository name**: `codemem`
- **Workflow name**: `release.yml`
- **Environment name**: `testpypi`

## GitHub workflow behavior

`.github/workflows/release.yml` includes:

- `publish-pypi` on tag pushes (`v*`) for production PyPI
- `publish-testpypi` on manual workflow dispatch when `publish_target=testpypi`

Both jobs:

1. downloads `dist/` artifacts from the build job
2. publishes via `pypa/gh-action-pypi-publish@release/v1`
3. authenticates using OIDC (`permissions: id-token: write`)

## TestPyPI verification process

1. In GitHub Actions, run the `Release` workflow manually.
2. Set `publish_target` to `testpypi`.
3. Confirm `publish-testpypi` succeeds.
4. Verify package appears on TestPyPI.

## Verification checklist

- Tag push `vX.Y.Z` runs `Release` workflow
- `publish-pypi` job completes successfully
- Package appears on PyPI with matching version
- `uvx`/`pipx` install command resolves published version
