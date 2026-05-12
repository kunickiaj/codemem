# Mixed Sharing-domain dogfood validation

**Date:** 2026-05-12  
**Status:** completed with follow-ups  
**Related:** `codemem-vsn0.5`, `2026-05-06-sharing-domain-release-readiness-ux-design.md`, `2026-05-08-sharing-domain-guided-setup-flow.md`

## Scope

Validate the 0.31 Projects and Sharing-domain workflow against a realistic mixed setup:

- personal projects and memories;
- work/client projects and memories;
- OSS/dev projects and memories;
- at least one always-on peer or always-on-peer stand-in;
- project/worktree rows with imperfect metadata.

The purpose is product validation, not release automation. File confusing states as follow-up Beads instead of expanding this slice.

## Invariants to verify

- Sharing domain (`scope_id`) remains the hard access boundary.
- Project, folder, git remote, branch, and workspace identity are hints or retrieval labels, not access grants.
- Changing a project row's Sharing domain affects future scope resolution only; it does not recall already-copied data.
- Changing a row's project updates project retrieval/grouping only; it does not change Sharing-domain grants.
- Coordinator/group context and project filters only narrow or organize already-authorized sync.

## Current dogfood findings already addressed

- Projects tab could show fresh HTML with stale JavaScript, making the new tab appear but not route. Fixed in PR `#1081` with cache-safe viewer shell and bundle headers.
- Projects auto-refresh collapsed expanded rows. Fixed in PR `#1082` by preserving expanded row state by workspace identity.
- Projects auto-refresh reset an in-progress Sharing-domain dropdown selection. Fixed in PR `#1082` by preserving draft domain selections by workspace identity until save/remove succeeds.
- Duplicate display names (common for worktrees) were treated as persistent attention states. Fixed in PR `#1082`; duplicate-name collisions are informational in inventory and still require confirmation before non-local assignment.
- Projects cards were too dense at 50/page. Fixed in PR `#1082`; Projects requests 25/page.
- Rows with correct workspace identity but wrong stored project were hard to fix from Feed. Fixed in PR `#1083`; Projects rows can now use **Change project…** to update `sessions.project` while leaving Sharing-domain assignment unchanged.
- Mapping-only rows with no sessions exposed a guaranteed-failing **Change project…** action. Fixed in PR `#1083`; the action is disabled with explanatory title text.

## Follow-up Beads filed during validation

- `codemem-m1wy` — Clarify the two-step Sharing-domain guardrail confirmation copy (`Save domain` vs `Confirm and save`).
- `codemem-vsn0.7` — Flag peer/domain grant role mismatches before treating sync as validated.
- `codemem-vsn0.8` — Reorder viewer tabs to follow the primary workflow: Feed, Projects, Sync, Health, Coordinator Admin.

## 2026-05-12 local validation pass

The local viewer was restarted from the current `main` checkout so the Projects API reflected the merged Projects implementation rather than a stale background server. Evidence below is intentionally anonymized.

Observed setup:

- Sync is enabled with two known peers.
- Both peers were syncing successfully in the later validation pass.
- Sharing-domain settings exposed four domains: local-only, legacy-review, personal, and OSS.
- No work/client Sharing domain was configured in this local pass, so work/client grant-boundary acceptance criteria remain unverified.
- Projects inventory returned 39 rows in the first pass and 39 rows in the later pass; the later pass resolved 33 local-only, 3 personal, and 3 OSS rows.
- Inventory identity sources included cwd, git remote, workspace id, and one unmapped row.
- Five duplicate display-name groups were present; duplicates did not appear as a persistent review status in the inventory counts.
- Five explicit mappings were present in the first pass and six in the later pass; no mapping-only zero-session row was present in this database snapshot.
- Peer grants showed one peer with no domain grants and one peer with two explicit domain grants plus project filters. This confirmed the UI/API model can represent "filters narrow authorized domains" separately from domain grants.
- The peer intended to represent the work/client side did not have a work/client-only grant in this setup. Instead, the available grants were personal and OSS. That is not a safe pass for the personal/work boundary acceptance criteria; it is a dogfood setup/product-follow-up finding.
- The assignment confirmation flow is behaviorally correct: selecting a Sharing domain and clicking **Save domain** performs the initial save attempt, then backend guardrails require the user to acknowledge warnings with **Confirm and save**. The copy is the problem. It stacks an unmapped/local-only explanation with a duplicate-display-name collision warning, without making it clear that the second action is the required guardrail acknowledgement before saving. This belongs under `codemem-m1wy`.
- Aside from confirmation-copy clarity, the Projects workflow behaved as expected in dogfood. The initial top-level order was Feed, Health, Projects, Sync, Coordinator Admin; Projects belonged closer to Sync because it explains what data can sync, while Health is diagnostic. The cleanup changed the order to Feed, Projects, Sync, Health, Coordinator Admin.

Validation outcome for this pass: useful evidence plus concrete follow-ups. The active setup did not provide a clean work/client-domain boundary check, so the peer-role mismatch is tracked separately instead of expanding this validation slice.

## 2026-05-12 cleanup fixes

Follow-up fixes landed from the dogfood findings:

- The guardrail confirmation panel now states that confirmation is required before saving, explains that codemem can save after the warnings are acknowledged, separates warning categories, and labels the final action **I understand, save domain**.
- Viewer tabs now follow the primary workflow order: Feed, Projects, Sync, Health, Coordinator Admin.

These fixes close the actionable UI findings from this validation pass. The remaining peer-role mismatch is tracked separately by `codemem-vsn0.7` as guided-setup/review work rather than a blocker for this dogfood validation record.

## Manual validation checklist

### 1. Project inventory sanity

- [ ] Search finds known personal, work/client, and OSS projects by project name. _(partial: personal and OSS inventory present; work/client domain not configured in this pass)_
- [x] Search finds worktrees by cwd, git remote, branch, or workspace identity without exposing private path details in committed notes.
- [x] Duplicate display names no longer produce persistent **Review before mapping** noise.
- [x] Duplicate display names still produce a confirmation panel when assigning a non-local Sharing domain. _(copy clarified by `codemem-m1wy`)_
- [ ] Saved mappings with no sessions are visible but cannot invoke **Change project…**. _(not observed in this database snapshot)_

### 2. Project correction

- [ ] A row with wrong stored project but correct workspace identity can be changed with **Change project…**.
- [ ] The prompt previews affected session and memory counts.
- [ ] After correction, project-filtered retrieval finds those memories under the corrected project.
- [ ] Sharing-domain assignment remains unchanged after project correction.

### 3. Sharing-domain assignment

- [ ] Personal project rows resolve to a personal/local domain only after explicit confirmation.
- [ ] Work/client project rows resolve to work/client domains only after explicit confirmation.
- [ ] OSS/dev project rows can map to an OSS domain independently of personal/work domains.
- [ ] **Keep local-only** leaves the row local-only and does not grant peers access.
- [ ] **Remove mapping** falls back to the next resolution rule and explains that future writes change only by resolution.
- [x] Guardrail confirmation copy is understandable enough to proceed safely; confusing copy should reference `codemem-m1wy`. _(fixed: the panel now explains the required acknowledgement step and uses **I understand, save domain**)_

### 4. Peer grant boundaries

- [ ] Work peer is granted only work/client domains. _(blocked: no work/client Sharing domain configured in this pass)_
- [ ] Personal peer is granted only personal domains.
- [ ] OSS peer is granted only OSS domains.
- [ ] Always-on peer receives only explicitly selected domains. _(partial: one peer had no grants; one peer had explicit grants)_
- [ ] Project include/exclude filters are shown as narrowing rules only.
- [ ] A peer without a domain grant cannot receive that domain even if its project filter would match.

### 5. Retrieval/sync spot checks

- [ ] Memory pack/search for a project includes all sessions whose stored `sessions.project` matches that project label, across workspace identities.
- [ ] Correcting `sessions.project` moves retrieval to the corrected project.
- [ ] Sync/retrieval behavior respects `scope_id` visibility before project filters.
- [ ] Personal data is not visible to work peers. _(blocked: no work/client Sharing domain configured in this pass)_
- [ ] Work/client data is not visible to personal peers. _(blocked: no work/client Sharing domain configured in this pass)_
- [ ] OSS data can be shared independently. _(partial: OSS domain and explicit grants are present; peer-side visibility still needs spot check)_

## Notes for recording evidence

Use anonymized labels in committed docs: `personal`, `work-client`, `oss-dev`, `anchor-peer`. Do not commit local absolute paths, internal hostnames, private repo names, device IDs, or screenshots containing them.

If a screenshot is useful, redact it before committing or keep it outside the repo and summarize the finding here.
