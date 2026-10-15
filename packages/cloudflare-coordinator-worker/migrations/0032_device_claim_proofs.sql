-- Committed proofs only; finalization writes logical references atomically.
CREATE TABLE IF NOT EXISTS coordinator_auth_device_claims (
  claim_id TEXT PRIMARY KEY NOT NULL CHECK(
    typeof(claim_id) = 'text' AND length(claim_id) BETWEEN 1 AND 256
    AND claim_id = trim(claim_id) AND instr(claim_id, char(0)) = 0),
  coordinator_id TEXT NOT NULL CHECK(
    typeof(coordinator_id) = 'text' AND length(coordinator_id) BETWEEN 1 AND 256
    AND coordinator_id = trim(coordinator_id) AND instr(coordinator_id, char(0)) = 0),
  identity_id TEXT NOT NULL CHECK(
    typeof(identity_id) = 'text' AND length(identity_id) BETWEEN 1 AND 256
    AND identity_id = trim(identity_id) AND instr(identity_id, char(0)) = 0),
  group_id TEXT NOT NULL CHECK(
    typeof(group_id) = 'text' AND length(group_id) BETWEEN 1 AND 256
    AND group_id = trim(group_id) AND instr(group_id, char(0)) = 0),
  device_id TEXT NOT NULL CHECK(
    typeof(device_id) = 'text' AND length(device_id) BETWEEN 1 AND 256
    AND device_id = trim(device_id) AND instr(device_id, char(0)) = 0),
  public_key TEXT NOT NULL CHECK(
    typeof(public_key) = 'text' AND length(public_key) BETWEEN 1 AND 4096
    AND length(trim(replace(replace(public_key, char(13), ''), char(10), ''))) > 0
    AND instr(public_key, char(0)) = 0),
  fingerprint TEXT NOT NULL CHECK(
    typeof(fingerprint) = 'text' AND length(fingerprint) = 64
    AND fingerprint NOT GLOB '*[^a-f0-9]*' AND instr(fingerprint, char(0)) = 0),
  key_id TEXT NOT NULL CHECK(
    typeof(key_id) = 'text' AND length(key_id) = 64
    AND key_id NOT GLOB '*[^a-f0-9]*' AND instr(key_id, char(0)) = 0),
  attempt_id TEXT NOT NULL CHECK(
    typeof(attempt_id) = 'text' AND length(attempt_id) BETWEEN 1 AND 256
    AND attempt_id = trim(attempt_id) AND instr(attempt_id, char(0)) = 0),
  issuer TEXT NOT NULL CHECK(
    typeof(issuer) = 'text' AND length(trim(issuer)) > 0
    AND issuer = trim(issuer) AND instr(issuer, char(0)) = 0),
  auth_config_revision TEXT NOT NULL CHECK(
    typeof(auth_config_revision) = 'text' AND length(auth_config_revision) = 64
    AND auth_config_revision NOT GLOB '*[^a-f0-9]*' AND instr(auth_config_revision, char(0)) = 0),
  created_at_ms INTEGER NOT NULL CHECK(
    typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (coordinator_id, identity_id),
  UNIQUE (coordinator_id, device_id),
  UNIQUE (coordinator_id, key_id),
  UNIQUE (coordinator_id, attempt_id)
) WITHOUT ROWID;

-- REPLACE's implicit deletes may skip DELETE triggers when recursive triggers are off.
-- Check every unique identifier before conflict handling, including UPSERT DO NOTHING.
CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_insert_collision
BEFORE INSERT ON coordinator_auth_device_claims
WHEN EXISTS (
  SELECT 1 FROM coordinator_auth_device_claims
  WHERE claim_id = NEW.claim_id OR (coordinator_id = NEW.coordinator_id AND (
    identity_id = NEW.identity_id OR device_id = NEW.device_id
    OR key_id = NEW.key_id OR attempt_id = NEW.attempt_id
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_collision');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_immutable_update
BEFORE UPDATE ON coordinator_auth_device_claims
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_immutable_delete
BEFORE DELETE ON coordinator_auth_device_claims
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_immutable');
END;
