import {
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
	type RelayAdmissionRole,
} from "./relay-admission-codec.js";
import {
	type MetadataSeedOptions,
	metadataSeed,
} from "./relay-admission-metadata-test-fixtures.js";
import {
	PARTICIPANT_CREATED_AT,
	PARTICIPANT_DEVICE_INSERT,
	PARTICIPANT_GROUP_INSERT,
} from "./relay-admission-participant-nonce-test-fixtures.js";
import type { RelayProofExpectation } from "./relay-admission-proof.js";

async function hexDigest(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function disposableSigner() {
	const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("publicKey" in keys)) throw new Error("Ed25519 did not generate a key pair");
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
	// Strict SSH wire encoding: length-prefixed algorithm followed by a 32-byte key.
	const wire = new Uint8Array(51);
	new DataView(wire.buffer).setUint32(0, 11);
	wire.set(new TextEncoder().encode("ssh-ed25519"), 4);
	new DataView(wire.buffer).setUint32(15, 32);
	wire.set(raw, 19);
	return {
		privateKey: keys.privateKey,
		publicKey: `ssh-ed25519 ${btoa(String.fromCharCode(...wire))} disposable`,
		keyId: await hexDigest(wire),
	};
}

async function signedPacket(
	bodyBytes: Uint8Array,
	privateKey: Awaited<ReturnType<typeof disposableSigner>>["privateKey"],
	createdAt: number,
) {
	const nonce = "b".repeat(32);
	const externalPathname = "/trusted/v1/relay/admission-check";
	const canonical = [
		"POST",
		externalPathname,
		String(createdAt),
		nonce,
		await hexDigest(bodyBytes),
	].join("\n");
	const signatureBytes = new Uint8Array(
		await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(canonical)),
	);
	const packet = encodeRelayCheckPacket({
		bodyBytes,
		timestamp: String(createdAt),
		nonce,
		signatureBytes,
	});
	return { packet, nonce, signatureBytes, externalPathname };
}

/** Portable disposable keys: no Node imports, files, network, or production credentials. */
export async function decisionFixture(
	options: {
		role?: RelayAdmissionRole | "registration";
		createdAt?: number;
		authorityId?: string;
		groupId?: string;
	} = {},
) {
	const role = options.role ?? "source";
	const createdAt = options.createdAt ?? 100;
	const namespace = {
		authorityId: options.authorityId ?? "a".repeat(64),
		groupId: options.groupId ?? "group-A",
		relayAudienceId: "f".repeat(64),
	};
	const [source, target] = await Promise.all([disposableSigner(), disposableSigner()]);
	const rows = [source, target].map((key, index) => ({
		group_id: namespace.groupId,
		device_id: index === 0 ? "source" : "target",
		public_key: key.publicKey,
		fingerprint: String(index).repeat(64),
		identity_id: null,
		enabled: 1,
	}));
	const common = { ...namespace, createdAt, admitBefore: createdAt + 30 };
	let bodyBytes: Uint8Array;
	let expected: RelayProofExpectation;
	if (role === "registration") {
		expected = { kind: "registration" };
		bodyBytes = encodeRelayRegistrationBody({
			...common,
			deviceId: "source",
			keyId: source.keyId,
			socketChallengeId: "e".repeat(32),
		});
	} else {
		expected = { kind: "admission", role };
		bodyBytes = encodeRelayAdmissionBody({
			...common,
			role,
			sourceDeviceId: "source",
			sourceKeyId: source.keyId,
			targetDeviceId: "target",
			targetKeyId: target.keyId,
			routeSessionId: "e".repeat(32),
			messageADigest: "d".repeat(64),
			routeNotAfter: createdAt + 55,
		});
	}
	const { packet, nonce, signatureBytes, externalPathname } = await signedPacket(
		bodyBytes,
		source.privateKey,
		createdAt,
	);
	const request = {
		packet,
		expected,
		deviceHeader: "source",
		externalPathname,
		namespace,
		ingressKey: "trusted-ingress",
	};
	return { request, rows, sourceKeyId: source.keyId, bodyBytes, signatureBytes, nonce, createdAt };
}

export type DecisionFixture = Awaited<ReturnType<typeof decisionFixture>>;

export function decisionSeed(f: DecisionFixture, now: number, metadata: MetadataSeedOptions = {}) {
	return [
		{
			sql: PARTICIPANT_GROUP_INSERT,
			values: [f.request.namespace.groupId, PARTICIPANT_CREATED_AT],
		},
		...f.rows.map((row) => ({
			sql: PARTICIPANT_DEVICE_INSERT,
			values: [...Object.values(row), PARTICIPANT_CREATED_AT],
		})),
		...metadataSeed({
			authority: f.request.namespace.authorityId,
			group: f.request.namespace.groupId,
			authorityObserved: now,
			realmObserved: now,
			...metadata,
		}),
	];
}
