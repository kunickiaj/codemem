import type { Context, Hono } from "hono";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import type { DeviceRemovalBackend } from "./coordinator-device-removal.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";

/*
 * Revoking an invitation that nobody has accepted yet. A revoked invitation can
 * no longer be inspected or accepted: every acceptance path requires
 * `revoked_at IS NULL` and `consumed_at IS NULL` in the statement that accepts,
 * so a revocation and an acceptance cannot both win. An accepted invitation is
 * refused here, because revoking it would not take away what it already granted.
 */

export interface CoordinatorRevokeInviteInput {
	groupId: string;
	inviteId: string;
}

export type CoordinatorRevokeInviteResult =
	/** This call revoked it. */
	| { status: "revoked"; invite_id: string; revoked_at: string }
	/** It was revoked before; the first revocation time is kept. */
	| { status: "already_revoked"; invite_id: string; revoked_at: string }
	/** It was accepted, so it was not revoked. */
	| { status: "consumed"; invite_id: string }
	/** No invitation of the group has this ID. */
	| { status: "not_found"; invite_id: string };

export interface CoordinatorInviteRevocationStore {
	revokeInvite(input: CoordinatorRevokeInviteInput): Promise<CoordinatorRevokeInviteResult>;
}

const REVOKE_SQL = `UPDATE coordinator_invites SET revoked_at = ?
 WHERE invite_id = ? AND group_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`;

const READ_SQL = `SELECT revoked_at, consumed_at FROM coordinator_invites
 WHERE invite_id = ? AND group_id = ?`;

function captureRevoke(raw: CoordinatorRevokeInviteInput): CoordinatorRevokeInviteInput {
	if (
		!raw ||
		typeof raw !== "object" ||
		!isStrictRecipientPolicyId(raw.groupId) ||
		!isStrictRecipientPolicyId(raw.inviteId)
	)
		throw new Error("invalid_input");
	return { groupId: raw.groupId, inviteId: raw.inviteId };
}

function incomplete(): never {
	throw new Error("invite_revocation_incomplete");
}

/** Internal storage capability. The caller authenticates the admin. */
export class InviteRevocationOperations implements CoordinatorInviteRevocationStore {
	constructor(
		private readonly backend: DeviceRemovalBackend,
		private readonly clock: () => number = Date.now,
	) {}

	async revokeInvite(raw: CoordinatorRevokeInviteInput): Promise<CoordinatorRevokeInviteResult> {
		const { groupId, inviteId } = captureRevoke(raw);
		const results = await this.backend.batch([
			{ sql: REVOKE_SQL, values: [new Date(this.clock()).toISOString(), inviteId, groupId] },
			{ sql: READ_SQL, values: [inviteId, groupId], read: true },
		]);
		if (results.length !== 2) return incomplete();
		const changes = (results[0] as { meta?: { changes?: unknown } } | null)?.meta?.changes;
		const rows = (results[1] as { results?: unknown } | null)?.results;
		if (typeof changes !== "number" || !Array.isArray(rows)) return incomplete();
		const row = rows[0] as { revoked_at?: unknown; consumed_at?: unknown } | undefined;
		if (!row) return { status: "not_found", invite_id: inviteId };
		if (row.consumed_at != null) return { status: "consumed", invite_id: inviteId };
		if (typeof row.revoked_at !== "string") return incomplete();
		return {
			status: changes === 1 ? "revoked" : "already_revoked",
			invite_id: inviteId,
			revoked_at: row.revoked_at,
		};
	}
}

export const INVITE_REVOKE_PATH = "/v1/admin/invites/revoke";
const MAX_BODY_BYTES = 4 * 1024;

interface InviteRevocationRouteDeps extends Pick<DeviceAuthLinkDeps, "rateLimitedResponse"> {
	storeFactory(): CoordinatorStore;
	authorizeAdmin(secret: string | undefined): { ok: boolean; error: string };
	readRequestBytes(c: Context, maxBytes: number): Promise<Uint8Array | null>;
	parseJsonObject(raw: Uint8Array): Record<string, unknown> | null;
}

/** Exactly `group_id` and `invite_id`, each a strict identifier; null for anything else. */
function parseRevokeBody(
	data: Record<string, unknown> | null,
): CoordinatorRevokeInviteInput | null {
	if (!data) return null;
	const keys = Object.keys(data);
	if (keys.length !== 2 || !keys.includes("group_id") || !keys.includes("invite_id")) return null;
	const { group_id: groupId, invite_id: inviteId } = data;
	if (!isStrictRecipientPolicyId(groupId) || !isStrictRecipientPolicyId(inviteId)) return null;
	return { groupId, inviteId };
}

/** Admin-only route that revokes an invitation nobody has accepted. */
export function registerCoordinatorInviteRevocationRoute(
	app: Hono,
	deps: InviteRevocationRouteDeps,
): void {
	app.post(INVITE_REVOKE_PATH, async (c) => {
		const auth = deps.authorizeAdmin(c.req.header("X-Codemem-Coordinator-Admin"));
		if (!auth.ok)
			return (
				deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
				c.json({ error: auth.error }, 401)
			);
		const limited = deps.rateLimitedResponse(c, "admin", { authenticated: true });
		if (limited) return limited;
		const raw = await deps.readRequestBytes(c, MAX_BODY_BYTES);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const input = parseRevokeBody(deps.parseJsonObject(raw));
		if (!input) return c.json({ error: "invalid_input" }, 400);
		const store = deps.storeFactory();
		try {
			const result = await store.revokeInvite(input);
			if (result.status === "not_found") return c.json({ error: "invite_not_found" }, 404);
			if (result.status === "consumed") return c.json({ error: "invite_consumed" }, 409);
			return c.json({ version: 1, ...result });
		} finally {
			await store.close();
		}
	});
}
