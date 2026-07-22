ALTER TABLE coordinator_invites ADD COLUMN invite_kind TEXT;
ALTER TABLE coordinator_invites ADD COLUMN policy_team_id TEXT;
ALTER TABLE coordinator_invites ADD COLUMN target_identity_id TEXT;
ALTER TABLE coordinator_invites ADD COLUMN reviewed_preview_digest TEXT;

UPDATE coordinator_invites
SET invite_kind = CASE
  WHEN operation_id IS NOT NULL THEN 'project_share'
  ELSE 'legacy_enrollment'
END
WHERE invite_kind IS NULL;
