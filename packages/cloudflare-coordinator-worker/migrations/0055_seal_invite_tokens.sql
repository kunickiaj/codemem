-- Invitation bearer tokens at rest: AES-GCM ciphertext and the ID of the key that sealed it.
-- Additive only. D1 SQL cannot hash or encrypt, so once an operator records the lookup floor the
-- Worker fills these columns and replaces each plaintext token with a placeholder: when an admin
-- copies its link, and in batches through POST /v1/admin/invite-tokens/seal. A Worker from before
-- 0055 keeps working with it applied.
ALTER TABLE coordinator_invites ADD COLUMN token_ciphertext TEXT;
ALTER TABLE coordinator_invites ADD COLUMN token_key_id TEXT;
