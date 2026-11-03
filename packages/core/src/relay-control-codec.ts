import { decodeRelayCheckPacket, type RelayCheckPacket } from "./relay-admission-codec.js";

export type RelayControl = { readonly v: 1; readonly session: string } & (
	| { readonly type: "SERVICE_CHALLENGE"; readonly body: { readonly audienceId: string } }
	| { readonly type: "SERVICE_PROOF"; readonly body: RelayServiceProofBody }
	| {
			readonly type: "SOCKET_CHALLENGE" | "ACCEPTED" | "REJECTED";
			readonly body: Record<string, never>;
	  }
	| { readonly type: "REGISTER"; readonly body: RelayCheckPacket }
	| {
			readonly type: "REGISTERED";
			readonly body: {
				readonly deviceId: string;
				readonly keyId: string;
				readonly authorityId: string;
				readonly realmId: string;
				readonly remainingMs: number;
			};
	  }
	| {
			readonly type: "OPEN";
			readonly body: { readonly checks: readonly [RelayCheckPacket, RelayCheckPacket] };
	  }
	| { readonly type: "CLOSE"; readonly body: { readonly mode: "end" | "abort" } }
);
export interface RelayServiceProofBody {
	readonly keyId: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly signature: string;
}

export function relayExact(
	value: unknown,
	fields: readonly string[],
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Reflect.ownKeys(value);
	return keys.length === fields.length && fields.every((field) => keys.includes(field));
}
export function relayRequire(value: unknown): asserts value {
	if (!value) throw new Error("Invalid relay control");
}
export function relayInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
export function relayHex(value: unknown, length = 64): value is string {
	return typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);
}
export function relayDevice(value: unknown): value is string {
	return typeof value === "string" && /^[\x21-\x7e]{1,64}$/.test(value);
}
export function relayJson(bytes: Uint8Array, max: number): unknown {
	relayRequire(bytes instanceof Uint8Array && bytes.length <= max);
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	relayRequire(JSON.stringify(value) === text);
	return value;
}
function packet(value: unknown): RelayCheckPacket {
	decodeRelayCheckPacket(value);
	const fields = value as RelayCheckPacket;
	return {
		body: fields.body,
		timestamp: fields.timestamp,
		nonce: fields.nonce,
		signature: fields.signature,
	};
}
function serviceProofBody(body: unknown): RelayServiceProofBody {
	relayRequire(relayExact(body, ["keyId", "issuedAt", "expiresAt", "signature"]));
	const { keyId, issuedAt, expiresAt, signature } = body;
	relayRequire(
		relayHex(keyId) &&
			relayInteger(issuedAt, 9_999_999_999) &&
			relayInteger(expiresAt, 9_999_999_999) &&
			expiresAt > issuedAt &&
			expiresAt - issuedAt <= 30,
	);
	relayRequire(
		typeof signature === "string" &&
			signature.length === 88 &&
			Buffer.from(signature, "base64").length === 64 &&
			Buffer.from(signature, "base64").toString("base64") === signature,
	);
	return { keyId, issuedAt, expiresAt, signature };
}
function openBody(body: unknown, session: string): Extract<RelayControl, { type: "OPEN" }>["body"] {
	relayRequire(
		relayExact(body, ["checks"]) && Array.isArray(body.checks) && body.checks.length === 2,
	);
	const checks = [packet(body.checks[0]), packet(body.checks[1])] as const;
	const first = decodeRelayCheckPacket(checks[0]);
	const second = decodeRelayCheckPacket(checks[1]);
	relayRequire(
		first.kind === "admission" &&
			second.kind === "admission" &&
			first.value.role === "relay" &&
			second.value.role === "responder" &&
			first.nonce !== second.nonce,
	);
	relayRequire(first.value.routeSessionId === session && second.value.routeSessionId === session);
	relayRequire(
		JSON.stringify({ ...first.value, role: "responder" }) === JSON.stringify(second.value),
	);
	return { checks };
}
function control(value: unknown): RelayControl {
	relayRequire(
		relayExact(value, ["v", "type", "session", "body"]) &&
			value.v === 1 &&
			relayHex(value.session, 32),
	);
	const { type, session, body } = value;
	const header = { v: 1 as const, type, session };
	switch (type) {
		case "SERVICE_CHALLENGE":
			relayRequire(relayExact(body, ["audienceId"]) && relayHex(body.audienceId));
			return { ...header, type, body: { audienceId: body.audienceId } };
		case "SERVICE_PROOF":
			return { ...header, type, body: serviceProofBody(body) };
		case "SOCKET_CHALLENGE":
		case "ACCEPTED":
		case "REJECTED":
			relayRequire(relayExact(body, []));
			return { ...header, type, body: {} };
		case "REGISTER": {
			const owned = packet(body);
			relayRequire(decodeRelayCheckPacket(owned).kind === "registration");
			return { ...header, type, body: owned };
		}
		case "REGISTERED": {
			relayRequire(
				relayExact(body, ["deviceId", "keyId", "authorityId", "realmId", "remainingMs"]),
			);
			const { deviceId, keyId, authorityId, realmId, remainingMs } = body;
			relayRequire(
				relayDevice(deviceId) &&
					relayHex(keyId) &&
					relayHex(authorityId) &&
					relayHex(realmId) &&
					relayInteger(remainingMs, 900_000) &&
					remainingMs > 0,
			);
			return { ...header, type, body: { deviceId, keyId, authorityId, realmId, remainingMs } };
		}
		case "OPEN":
			return { ...header, type, body: openBody(body, session) };
		case "CLOSE":
			relayRequire(relayExact(body, ["mode"]) && (body.mode === "end" || body.mode === "abort"));
			return { ...header, type, body: { mode: body.mode } };
		default:
			throw new Error("Invalid relay control");
	}
}
export function encodeRelayControl(value: RelayControl): string {
	const text = JSON.stringify(control(value));
	relayRequire(Buffer.byteLength(text) <= 4096);
	return text;
}
export function decodeRelayControl(bytes: Uint8Array): RelayControl {
	const result = control(relayJson(bytes, 4096));
	relayRequire(encodeRelayControl(result) === new TextDecoder().decode(bytes));
	return result;
}
