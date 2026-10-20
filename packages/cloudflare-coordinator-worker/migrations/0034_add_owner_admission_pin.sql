-- Source only. Apply explicitly with writers paused and a reviewed backup; never backfill owner pins.
-- Existing owner attempts retain NULL and the v1 operator path.
ALTER TABLE coordinator_owner_enrollment_attempts ADD COLUMN admission_owner_hash TEXT CHECK (admission_owner_hash IS NULL OR (typeof(admission_owner_hash) = 'text' AND length(admission_owner_hash) = 64 AND admission_owner_hash NOT GLOB '*[^0-9a-f]*' AND instr(admission_owner_hash, char(0)) = 0));
CREATE TRIGGER IF NOT EXISTS owner_enrollment_admission_update
BEFORE UPDATE ON coordinator_owner_enrollment_attempts
WHEN OLD.admission_owner_hash IS NOT NEW.admission_owner_hash
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_admission_immutable'); END;
CREATE TRIGGER IF NOT EXISTS owner_enrollment_admission_insert
BEFORE INSERT ON coordinator_owner_enrollment_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a
 WHERE (a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id
 AND (a.attempt_id = NEW.attempt_id OR a.browser_start_hash = NEW.browser_start_hash
 OR a.browser_transaction_hash = NEW.browser_transaction_hash OR a.completion_secret_hash = NEW.completion_secret_hash)))
 AND a.admission_owner_hash IS NOT NEW.admission_owner_hash)
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_admission_immutable'); END;
