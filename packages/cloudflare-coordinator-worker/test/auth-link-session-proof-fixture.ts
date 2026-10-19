import type { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect } from "vitest";
import { startBrowserProof } from "../../core/src/coordinator-auth-browser-proof-test-fixtures.js";

type Config = Parameters<D1CoordinatorStore["createAuthLinkAttempt"]>[1];
type Fixture = { store: D1CoordinatorStore; cfg: Config };
const browserConfig = (cfg: Config) => ({
	redirectUri: "https://coordinator.example.test/auth/callback",
	...cfg,
});

export async function consumeLinkProof(
	f: Fixture,
	start: { browserStartHash: string },
	browser: { attemptId: string; browserTransactionHash: string; binderHash: string },
) {
	const cfg = browserConfig(f.cfg);
	const proof = await startBrowserProof(f, { ...browser, ...start }, cfg);
	expect(await f.store.consumeAuthBrowserTransaction(proof, cfg)).toMatchObject({
		kind: "consumed",
		purpose: "link",
		attemptId: browser.attemptId,
		browserTransactionHash: browser.browserTransactionHash,
	});
	browser.binderHash = proof.binderHash;
}

export function redeemBound(
	f: Fixture & { browser: { binderHash: string } },
	input: Parameters<D1CoordinatorStore["redeemAuthLinkSession"]>[0],
	cfg: Config,
) {
	return f.store.redeemAuthLinkSessionWithBrowserTransaction(
		{ ...input, binderHash: f.browser.binderHash },
		browserConfig(cfg),
	);
}
