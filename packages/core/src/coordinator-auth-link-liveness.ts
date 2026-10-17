/** Lifecycle state only, not historical provenance or current device authority.
 * Callers must also validate the link's full authority-specific proof.
 */
export function authLinkLiveGenerationSql(options: { link: "l" | "cl" }): string {
	const link = options.link;
	if (link !== "l" && link !== "cl") throw new Error("auth_link_alias_invalid");
	return `(${link}.revoked_at_ms IS NULL AND ${link}.ended_at_ms IS NULL
 AND EXISTS (SELECT 1 FROM coordinator_auth_account_associations live_association
  WHERE live_association.coordinator_id = ${link}.coordinator_id
  AND live_association.issuer = ${link}.issuer AND live_association.subject = ${link}.subject
  AND live_association.identity_id = ${link}.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links security_barrier
  WHERE security_barrier.coordinator_id = ${link}.coordinator_id
  AND security_barrier.identity_id = ${link}.identity_id
   AND security_barrier.revoked_at_ms IS NOT NULL))`;
}
