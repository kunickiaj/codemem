# Documentation

## Using codemem

- [User guide](user-guide.md): viewer workflows, configuration, and troubleshooting.
- [Plugin reference](plugin-reference.md): adapter behavior and environment controls.
- [Sharing guide](sharing-guide.md): sharing Projects and adding devices.
- [Migration guide](rename-migration.md): this repository's former installation name.

## Architecture and contracts

- [Architecture](architecture.md): components and data flow.
- [Pack ranking](pack-ranking.md): keyword and semantic candidate ordering.
- [Architecture decisions](adr/): durable decisions and their consequences.
- [Contracts](contracts/): interface contracts, including the adapter event schema and fixtures.
- [UI patterns](design/): reusable interaction and presentation patterns.
- [Design history](plans/): active designs and explicitly historical decisions, not current setup instructions.

## Operating and contributing

- [Coordinator deployment](coordinator-deployment.md) and [Cloudflare deployment](cloudflare-coordinator-deployment.md).
- [Remote MCP OAuth](remote-mcp-oauth.md) and [two-instance partner setup](remote-mcp-partner-v1.md).
- [Versioning](versioning.md) and [contributing](../CONTRIBUTING.md).

Keep one maintained home for each behavior. Link to that home from overview pages rather than copying detailed contracts. See [documentation expectations](../CONTRIBUTING.md#docs-expectations) for where new material belongs.
