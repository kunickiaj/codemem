import { WorkerEntrypoint } from "cloudflare:workers";
import {
	createD1CoordinatorApp,
	type D1DatabaseLike,
} from "@codemem/core/internal/cloudflare-coordinator";
import { RELAY_INGRESS_LOOPBACK, relayAdmissionOptions } from "./relay-admission-options.js";
import { captureRelayEnv, RELAY_ADMISSION_PATH, readRelayConfig } from "./relay-config.js";
import type { RelayAdmissionProps } from "./relay-realm.js";
import { verifyCloudflareCoordinatorRequest } from "./request-verifier.js";

function unavailable(status: number): Response {
	return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Loopback target for RelayRealm admission checks. It serves only the
 * admission-check route, through the coordinator's own D1 app and admission
 * budgets, for the realm named in trusted props. Named entrypoints receive no
 * public traffic. Only this Worker's `ctx.exports`, or a service binding from the
 * same account, reaches it. Same-account Workers are inside the operator's trust
 * boundary, and their checks still need device-signed packets.
 */
export class RelayAdmission extends WorkerEntrypoint<
	{ readonly COORDINATOR_DB?: D1DatabaseLike },
	Partial<RelayAdmissionProps>
> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== RELAY_ADMISSION_PATH) return unavailable(404);
		const config = readRelayConfig(captureRelayEnv(this.env));
		const realmId = this.ctx.props?.realmId;
		const groupId = config && typeof realmId === "string" ? config.realms.get(realmId) : undefined;
		const db = this.env.COORDINATOR_DB;
		if (!config || !groupId || !db) return unavailable(503);
		try {
			// A one-entry map pinned to the props realm. A realm object for one group
			// can never obtain admissions for another group.
			const relayAdmission = await relayAdmissionOptions(config, [groupId], RELAY_INGRESS_LOOPBACK);
			return await createD1CoordinatorApp({
				db,
				requestVerifier: verifyCloudflareCoordinatorRequest,
				relayAdmission,
			}).fetch(request);
		} catch {
			return unavailable(503);
		}
	}
}
