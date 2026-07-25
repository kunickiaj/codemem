# Signed identity-owned add-device invitations

**Date:** 2026-07-25
**Status:** approved
**Bead:** `codemem-wosg.2`

## Goal

Allow an active enrolled device to create an add-device invitation for its own coordinator-bound Identity without possessing the coordinator admin secret. The caller must not be able to select another Identity or create Team invitations.

## Authority boundary

The coordinator enrollment is the only authorization source. A signed request identifies a device, and `authorizeRequest` resolves its active enrollment. The endpoint derives `target_identity_id` from that enrollment's non-null `identity_id`; it never accepts a target Identity or invitation kind from the client.

Team-member invitation creation remains on the admin-only endpoint. Legacy, admin, and Project enrollments have null Identity bindings and cannot use signed add-device issuance.

## Endpoint

Add `POST /v1/invites/add-device` with the existing signed request headers. The body contains:

- `group_id`;
- `expires_at`;
- `reviewed_preview_digest`;
- canonical add-device `reviewed_intent`.

The coordinator URL is derived from the request origin, the policy is fixed to `auto_admit`, and `created_by` is the bound Identity. Unknown fields fail closed so callers cannot smuggle `kind`, `policy_team_id`, `target_identity_id`, or `assigned_identity_id` into the request.

After signature and nonce validation, the coordinator requires an enabled enrollment with a valid non-null Identity binding. It verifies the reviewed intent and digest against that Identity, creates the invitation through the existing store contract, and returns the normal digest-only payload/link response.

## Viewer flow

The viewer keeps local preview and stale-review checks. Team invitation preview and creation still require coordinator-admin readiness. Add-device preview requires only a configured coordinator URL/group and the current local Identity. A non-admin device creates through the signed endpoint without reading or sending an admin secret. An explicitly admin-configured owner continues to use admin issuance, which supports the intentionally unbound initial-owner enrollment; selection happens before the request and never falls back after a signed failure.

## Error handling

- Missing or invalid signed headers: existing `authorizeRequest` 401 errors.
- Disabled device: `device_disabled` (403).
- Null enrollment binding: `identity_binding_required` (403).
- Unknown request fields: `unexpected_add_device_invite_fields` (400).
- Invalid expiry, reviewed intent, or digest: existing stable 400/409 recipient-invite errors.
- Replayed nonce: `nonce_replay` (401).

No failed request falls back to coordinator-admin authorization.

## Alternatives rejected

1. **Dual-auth the admin invite endpoint.** Rejected because kind-specific authorization would share one broad mutation boundary and make accidental Team issuance easier.
2. **Accept a target Identity and compare it with enrollment.** Rejected because the client does not need to provide an authorization principal; deriving it removes an entire confused-deputy input.
3. **General signed recipient-invite endpoint.** Rejected as unnecessary scope. Signed callers need only add-device issuance.

## Validation

- API tests cover valid signed issuance, bad signatures, nonce replay, disabled/unbound devices, unexpected fields, Team-kind attempts, cross-Identity reviewed intent, and malformed reviews.
- Viewer tests prove add-device preview/creation works without an admin secret and signs the exact body; Team creation still fails without admin credentials.
- Worker integration proves the real request verifier and D1 store produce an invitation bound to the caller's persisted Identity.
- Full TypeScript, lint, workspace tests, and Worker tests pass.
