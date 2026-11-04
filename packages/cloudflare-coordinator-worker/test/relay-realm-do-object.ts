import type { RelayServerLimits } from "@codemem/core/internal/relay-host";
import {
	decodeRelayCheckPacket,
	getRelayAdmissionTimeBudget,
} from "../../core/src/relay-admission-codec.js";
import { relayBodyDigest } from "../../core/src/relay-service-proof.js";
import {
	RELAY_DURABLE_OBJECT_LIMITS,
	type RelayAdmissionFetcher,
	RelayRealm,
} from "../src/relay-realm.js";

/**
 * Shared between the test file and the object, which run in one isolate.
 * The object reads it in its constructor, as a deploy would refresh env.
 */
export interface RelayRealmTestState {
	enabled: boolean;
	limits: Partial<RelayServerLimits>;
	admissions: { pathname: string; kind: string; deviceHeader: string }[];
	/** Overrides CODEMEM_RELAY_GROUPS, as a deploy that adds or removes groups would. */
	groups?: string[];
}
export function relayRealmTestState(): RelayRealmTestState {
	const scope = globalThis as { __relayRealmTest?: RelayRealmTestState };
	scope.__relayRealmTest ??= { enabled: true, limits: {}, admissions: [] };
	return scope.__relayRealmTest;
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/**
 * Stands in for the coordinator admission route. It trusts every well-formed
 * packet, because signature and enrollment checks belong to the coordinator.
 */
async function stubAdmission(url: string, init: RequestInit): Promise<Response> {
	const headers = new Headers(init.headers);
	const bodyBytes = new Uint8Array(await new Response(init.body).arrayBuffer());
	const packet = {
		body: base64Url(bodyBytes),
		timestamp: headers.get("X-Opencode-Timestamp") ?? "",
		nonce: headers.get("X-Opencode-Nonce") ?? "",
		signature: headers.get("X-Opencode-Signature") ?? "",
	};
	const check = decodeRelayCheckPacket(packet);
	relayRealmTestState().admissions.push({
		pathname: new URL(url).pathname,
		kind: check.kind,
		deviceHeader: headers.get("X-Opencode-Device") ?? "",
	});
	const decidedAtMs = Math.ceil(Date.now());
	const health = {
		revision: 1,
		state: "ready",
		observedAtMs: decidedAtMs,
		validUntilMs: decidedAtMs + 50_000,
	};
	const common = {
		v: 1,
		packetDigest: relayBodyDigest(bodyBytes),
		requestNonce: check.nonce,
		decidedAtMs,
		health,
	};
	const reply =
		check.kind === "registration"
			? {
					...common,
					registered: true,
					role: "registration",
					deviceId: check.value.deviceId,
					keyId: check.value.keyId,
					remainingMs: 900_000,
				}
			: {
					...common,
					eligible: true,
					role: check.value.role,
					routeNotAfter: check.value.routeNotAfter,
					remainingMs: getRelayAdmissionTimeBudget(check.value, decidedAtMs).remainingMs,
				};
	return new Response(JSON.stringify(reply));
}

/** Test-only realm object. The production Wrangler config never binds it. */
export class RelayRealmTestObject extends RelayRealm {
	constructor(ctx: DurableObjectState, env: Readonly<Record<string, unknown>>) {
		const state = relayRealmTestState();
		super(ctx, {
			...env,
			CODEMEM_RELAY_ENABLED: state.enabled ? "true" : "false",
			...(state.groups ? { CODEMEM_RELAY_GROUPS: JSON.stringify(state.groups) } : {}),
		});
	}
	protected override admissionFetcher(): RelayAdmissionFetcher {
		return { fetch: stubAdmission };
	}
	protected override relayLimits(): Readonly<RelayServerLimits> {
		return { ...RELAY_DURABLE_OBJECT_LIMITS, ...relayRealmTestState().limits };
	}
}

type Loopback = (options: { props: { realmId: string } }) => RelayAdmissionFetcher;

/**
 * Test-only realm object with the relay switch on. Admission goes over the real
 * `ctx.exports` loopback to RelayAdmission code and D1, through the test export
 * that also turns the switch on.
 */
export class RelayRealmLoopbackTestObject extends RelayRealm {
	constructor(ctx: DurableObjectState, env: Readonly<Record<string, unknown>>) {
		super(ctx, { ...env, CODEMEM_RELAY_ENABLED: "true" });
	}
	protected override admissionFetcher(realmId: string): RelayAdmissionFetcher | null {
		const exports = this.ctx.exports as { RelayAdmissionEnabledTest?: Loopback };
		return exports.RelayAdmissionEnabledTest?.({ props: { realmId } }) ?? null;
	}
}
