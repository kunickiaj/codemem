ALTER TABLE coordinator_reciprocal_approvals ADD COLUMN pending_pair_low_device_id TEXT;
ALTER TABLE coordinator_reciprocal_approvals ADD COLUMN pending_pair_high_device_id TEXT;

UPDATE coordinator_reciprocal_approvals
SET
  pending_pair_low_device_id = CASE
    WHEN requesting_device_id <= requested_device_id THEN requesting_device_id
    ELSE requested_device_id
  END,
  pending_pair_high_device_id = CASE
    WHEN requesting_device_id <= requested_device_id THEN requested_device_id
    ELSE requesting_device_id
  END
WHERE pending_pair_low_device_id IS NULL OR pending_pair_high_device_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_reciprocal_pending_pair
ON coordinator_reciprocal_approvals(group_id, pending_pair_low_device_id, pending_pair_high_device_id)
WHERE status = 'pending';
