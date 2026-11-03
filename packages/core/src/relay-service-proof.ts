import { createHash } from "node:crypto";
import {
	encodeRelayControl,
	type RelayServiceProofBody,
	relayHex,
	relayRequire,
} from "./relay-control-codec.js";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";

export function relayBodyDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
export function relayAuthorityId(baseUrl: string): string {
	const url = new URL(baseUrl);
	relayRequire(
		url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.href.includes("?") &&
			!url.href.includes("#"),
	);
	return relayBodyDigest(
		new TextEncoder().encode(`${url.origin}${url.pathname}`.replace(/\/+$/, "")),
	);
}
export function relayRealmId(authorityId: string, groupId: string): string {
	relayRequire(relayHex(authorityId));
	return relayBodyDigest(
		new TextEncoder().encode(JSON.stringify(["codemem-relay-realm-v1", authorityId, groupId])),
	);
}
export function relayAudienceId(origin: string, keyId: string): string {
	relayRequire(relayHex(keyId));
	const url = new URL(origin);
	relayRequire((url.protocol === "https:" || url.protocol === "wss:") && url.origin === origin);
	return relayBodyDigest(
		new TextEncoder().encode(`codemem-relay-audience-v1\0${origin}\0${keyId}`),
	);
}
export function relayServiceProofBytes(
	audienceId: string,
	challengeId: string,
	issuedAt: number,
	expiresAt: number,
): Uint8Array {
	relayRequire(relayHex(audienceId) && relayHex(challengeId, 32));
	return new TextEncoder().encode(
		JSON.stringify(["codemem-relay-service-v1", audienceId, challengeId, issuedAt, expiresAt]),
	);
}
export interface RelayServiceSigner {
	readonly keyId: string;
	sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export async function createRelayServiceProof(options: {
	readonly audienceId: string;
	readonly challengeId: string;
	readonly utcMs: number;
	readonly signer: RelayServiceSigner;
}): Promise<RelayServiceProofBody> {
	const { audienceId, challengeId, signer } = options;
	const issuedAt = Math.floor(options.utcMs / 1000);
	const expiresAt = issuedAt + 30;
	const signature = await signer.sign(
		relayServiceProofBytes(audienceId, challengeId, issuedAt, expiresAt),
	);
	relayRequire(signature instanceof Uint8Array && signature.length === 64);
	const body = {
		keyId: signer.keyId,
		issuedAt,
		expiresAt,
		signature: Buffer.from(signature).toString("base64"),
	};
	encodeRelayControl({ v: 1, type: "SERVICE_PROOF", session: challengeId, body });
	return body;
}
/** The caller owns and consumes the pending challenge. No service proof grants route authority. */
export async function verifyRelayServiceProof(options: {
	readonly audienceId: string;
	readonly challengeId: string;
	readonly publicKey: string;
	readonly body: RelayServiceProofBody;
	readonly startedAtMs: number;
	readonly nowMs: number;
	readonly deadlineMs: number;
}): Promise<boolean> {
	try {
		const { audienceId, challengeId, body, startedAtMs, nowMs, deadlineMs } = options;
		relayRequire(
			Number.isFinite(startedAtMs) &&
				startedAtMs >= 0 &&
				Number.isFinite(nowMs) &&
				nowMs >= startedAtMs &&
				nowMs < Math.min(startedAtMs + 5000, deadlineMs),
		);
		encodeRelayControl({ v: 1, type: "SERVICE_PROOF", session: challengeId, body });
		const key = parseRelayEd25519PublicKey(options.publicKey);
		relayRequire(relayBodyDigest(key.wireKey) === body.keyId);
		const verificationKey = await crypto.subtle.importKey(
			"raw",
			new Uint8Array(key.rawKey),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			"Ed25519",
			verificationKey,
			new Uint8Array(Buffer.from(body.signature, "base64")),
			new Uint8Array(
				relayServiceProofBytes(audienceId, challengeId, body.issuedAt, body.expiresAt),
			),
		);
	} catch {
		return false;
	}
}
