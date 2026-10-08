import type { Context } from "hono";
import type { CoordinatorEnrollment, CoordinatorStore } from "./coordinator-store-contract.js";

/** Only this current member/key snapshot can supply remote cache authority.
 * Catalogue version 1 is discovery metadata, not permission or an account login. */
export async function scopeAuthorizationResponse(
	c: Context,
	store: CoordinatorStore,
	input: { groupId: string; scopeId: string; requester: CoordinatorEnrollment },
): Promise<Response> {
	try {
		const result = await store.getScopeAuthorization({
			groupId: input.groupId,
			scopeId: input.scopeId,
		});
		if (result.kind === "rejected") {
			switch (result.error) {
				case "scope_not_found":
				case "scope_inactive":
				case "scope_source_mismatch":
				case "group_archived":
					return c.json({ error: "scope_not_found" }, 404);
				default:
					return c.json({ error: "scope_authorization_unavailable" }, 503);
			}
		}
		if (
			result.kind !== "authorized" ||
			result.authorizationVersion !== 1 ||
			result.scope.scope_id !== input.scopeId ||
			result.scope.group_id !== input.groupId
		) {
			return c.json({ error: "scope_authorization_unavailable" }, 503);
		}
		// Match the principal copied before signature verification, not a newly
		// read enrollment: rotation after admission must not grant an unchecked key.
		const requester = input.requester;
		const authorized = result.members.some(
			({ membership, enrollment }) =>
				membership.device_id === requester.device_id &&
				enrollment.device_id === requester.device_id &&
				enrollment.group_id === input.groupId &&
				requester.group_id === input.groupId &&
				enrollment.public_key === requester.public_key &&
				enrollment.fingerprint === requester.fingerprint &&
				enrollment.identity_id === requester.identity_id,
		);
		if (!authorized) return c.json({ error: "scope_membership_required" }, 403);
		return c.json({
			authorization_version: 1,
			scope: result.scope,
			items: result.members.map(({ membership, enrollment, keyId }) => ({
				membership,
				enrollment,
				key_id: keyId,
			})),
		});
	} catch {
		return c.json({ error: "scope_authorization_unavailable" }, 503);
	}
}
