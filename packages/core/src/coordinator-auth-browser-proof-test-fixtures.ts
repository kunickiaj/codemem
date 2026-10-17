import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import type { LinkFixture } from "./coordinator-auth-link-test-fixtures.js";

type BrowserProofFixture = Pick<LinkFixture, "cfg"> & {
	store: Pick<
		LinkFixture["store"],
		"startAuthBrowserTransaction" | "consumeAuthBrowserTransaction"
	>;
};

function fixtureHash(key: string) {
	return createHash("sha256").update(`codemem-test-browser:${key}`).digest("hex");
}

/** Synthetic persistence proof, not a provider token or an OIDC signature fixture. */
export async function startBrowserProof(
	f: BrowserProofFixture,
	input: { browserTransactionHash: string; attemptId?: string; browserStartHash?: string },
	config: CoordinatorAuthBrowserConfig = browserProofConfig(f),
) {
	const key = `${config.coordinatorId}:${input.attemptId ?? "signin"}:${input.browserTransactionHash}`;
	const materials = {
		stateHash: fixtureHash(`state:${key}`),
		binderHash: fixtureHash(`binder:${key}`),
		nonce: fixtureHash(`nonce:${key}`),
		pkceVerifier: fixtureHash(`pkce:${key}`),
	};
	let startInput: Parameters<typeof f.store.startAuthBrowserTransaction>[0];
	if (input.attemptId === undefined) {
		startInput = { ...materials, purpose: "signin" };
	} else {
		startInput = { ...materials, purpose: "link", attemptId: input.attemptId };
		if (input.browserStartHash !== undefined) {
			startInput.browserStartHash = input.browserStartHash;
		}
	}
	// V2 draws its hash before its first await. Fake only that synchronous draw.
	const entropy = vi
		.spyOn(globalThis.crypto, "getRandomValues")
		.mockReturnValueOnce(Uint8Array.from(Buffer.from(input.browserTransactionHash, "hex")));
	let started: ReturnType<typeof f.store.startAuthBrowserTransaction>;
	try {
		started = f.store.startAuthBrowserTransaction(startInput, config);
	} finally {
		entropy.mockRestore();
	}
	expect(await started).toMatchObject({ kind: "started" });
	return materials;
}

export function browserProofConfig(f: Pick<LinkFixture, "cfg">): CoordinatorAuthBrowserConfig {
	return { ...f.cfg, redirectUri: "https://coordinator.example.test/auth/callback" };
}

export async function consumeSigninProof(
	f: BrowserProofFixture,
	hash: string,
	config = browserProofConfig(f),
) {
	const materials = await startBrowserProof(f, { browserTransactionHash: hash }, config);
	expect(await f.store.consumeAuthBrowserTransaction(materials, config)).toEqual({
		kind: "consumed",
		purpose: "signin",
		browserTransactionHash: hash,
		nonce: materials.nonce,
		pkceVerifier: materials.pkceVerifier,
	});
	return materials;
}
