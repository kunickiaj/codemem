# Issue tracking

This repository uses Beads with a Dolt backend. Task status, dependencies, decisions, and completion evidence belong in Beads rather than committed implementation checklists.

```text
bd ready
bd show <issue-id>
bd update <issue-id> --status in_progress
bd close <issue-id> --reason "Validation and completion evidence"
```

When `bd dolt remote list` reports a configured remote, use `bd dolt pull` and `bd dolt push` to exchange task changes. Git commits do not synchronize the task database.

`.beads/issues.jsonl` is an ignored local export, not the collaboration source of truth. Keep database files, credentials, and generated server configuration out of Git.
