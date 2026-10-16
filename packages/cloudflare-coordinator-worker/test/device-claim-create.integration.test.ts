import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";
import { config, input, NOW, seedEnrollmentSql, seedKeyRevocationSql } from "./device-claim-eligibility-fixture.js";

async function seed(sql: string) {
	await env.COORDINATOR_DB.batch(sql.split(";").map((part) => part.trim()).filter(Boolean).map((part) => env.COORDINATOR_DB.prepare(part)));
}

it("native D1 atomically creates pending attempts, handles exact duplicates and quotas, and rechecks revocation", async () => {
	await seed(seedEnrollmentSql);
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const second = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const request = { authority: { kind: "device_claim" as const, identityId: input.identityId }, signer: input.signer, attemptId: "attempt-a", runtimeVerifierHash: "b".repeat(64), browserStartHash: "e".repeat(64), loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete" };
	const duplicates = await Promise.all([store.createAuthLinkAttempt(request, config), second.createAuthLinkAttempt(request, config)]);
	expect(duplicates.map((row) => row.kind).sort()).toEqual(["created", "existing"]);
	const results = await Promise.all([2, 3, 4].map((n) => store.createAuthLinkAttempt({ ...request, attemptId: `attempt-${n}`, runtimeVerifierHash: String(n).repeat(64), browserStartHash: String(n + 4).repeat(64) }, config)));
	expect(results.filter((row) => row.kind === "created")).toHaveLength(1);
	expect(results.filter((row) => row.kind === "rejected")).toHaveLength(2);
	const rows = async () => (await env.COORDINATOR_DB.prepare("SELECT * FROM coordinator_auth_link_attempts ORDER BY attempt_id").all()).results;
	const before = await rows();
	expect(before).toHaveLength(2);
	for (const row of before) expect(row).toMatchObject({ authority_kind: "device_claim", identity_id: input.identityId, controller_attestation_id: null, controller_review_receipt_id: null, controller_revision: null, state: "pending" });
	expect(await store.createAuthLinkAttempt({ ...request, browserStartHash: "f".repeat(64) }, config)).toEqual({ kind: "rejected", error: "attempt_conflict" });
	await seed(seedKeyRevocationSql);
	expect(await second.createAuthLinkAttempt(request, config)).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(await rows()).toEqual(before);
	expect((await env.COORDINATOR_DB.prepare("SELECT * FROM coordinator_auth_device_claims").all()).results).toEqual([]);
	expect((await env.COORDINATOR_DB.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id='device-a'").all()).results).toEqual([{ identity_id: null }]);
});
