# Cloudflare Worker wrapper config

This directory now exists only to hold `wrangler.toml.example` for the experimental Cloudflare Worker deployment path.

- Worker implementation: `../../packages/cloudflare-coordinator-worker/src/index.ts`
- D1 schema: `../../packages/cloudflare-coordinator-worker/schema.sql`
- Canonical runbook: `../../docs/cloudflare-coordinator-deployment.md`

The old Python bootstrap and smoke-check helpers were archived with the legacy runtime cleanup.
