import { createPrivateKey, sign } from "node:crypto";
import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { snapshot } from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { deterministicReviewTests } from "./coordinator-owner-resolution-review-test-fixtures.js";
import {
	expectDisplayOnly,
	expectNoDisclosure,
	safeProfile,
	selectedOwnerId,
	setupResolved,
	signer,
	sourceController,
} from "./coordinator-resolved-account-owner-status-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { buildCanonicalRequest, SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";

deterministicReviewTests();
const test = backendTest("SQLite");
const ORIGIN = "https://app.example.test";
const ROOT = "/v1/auth/resolved-account-owner-receipt-status";
// Public RFC 8032 test vector matches the genuine projection requester's key.
const key = createPrivateKey({
	key: Buffer.from(
		"302e020100300506032b6570042204204ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
		"hex",
	),
	format: "der",
	type: "pkcs8",
});
async function setup(f: LinkFixture) {
	const h = await setupResolved(f, "SQLite");
	if (!h.fact) throw new Error("fixture fact missing");
	const r = h.fact.resolution;
	const expectedReceipt = {
		attestationId: r.source_attestation_id,
		reviewReceiptId: r.source_review_receipt_id,
		reviewEvidenceDigest: r.source_evidence_digest,
		resolutionId: r.resolution_id,
		resolutionEvidenceDigest: r.resolution_evidence_digest,
	};
	const params = new URLSearchParams({
		group_id: signer.groupId,
		owner_identity_id: selectedOwnerId,
		coordinator_origin: ORIGIN,
		attestation_id: expectedReceipt.attestationId,
		review_receipt_id: expectedReceipt.reviewReceiptId,
		review_evidence_digest: expectedReceipt.reviewEvidenceDigest,
		resolution_id: expectedReceipt.resolutionId,
		resolution_evidence_digest: expectedReceipt.resolutionEvidenceDigest,
	});
	const oidc = oidcFixture({ issuer: f.cfg.issuer });
	const captured = captureCoordinatorBrowserAuthOptions({
		config: { ...PROVIDER, ...f.cfg, redirectUri: `${ORIGIN}/auth/callback` },
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
		oidcOptions: { fetch: oidc.fetch },
	});
	const auth = await createCoordinatorBrowserAuth(
		captured,
		f.store,
		createInMemoryRequestRateLimiter({ now: () => NOW }),
	);
	if (!auth.ok) throw new Error("fixture auth unavailable");
	vi.spyOn(f.store, "close").mockResolvedValue(undefined);
	const app = createCoordinatorApp({
		storeFactory: () => f.store,
		runtime: { adminSecret: () => "fixture-admin-secret", now: () => new Date(NOW).toISOString() },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: {
			kind: "ready",
			auth: auth.auth,
			storeFactory: () => f.store,
			clientKey: () => "synthetic-client",
		},
	});
	let nonce = 0;
	function headers(path: string, timestamp = String(NOW / 1000)) {
		const n = String(++nonce).padStart(32, "0");
		return {
			"X-Opencode-Device": signer.deviceId,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": n,
			"X-Opencode-Signature": `${SIGNATURE_VERSION}:${sign(null, buildCanonicalRequest("GET", path, timestamp, n, Buffer.alloc(0)), key).toString("base64")}`,
		};
	}
	async function get(path = `${ROOT}?${params}`, signed = headers(path), body = false) {
		const before = snapshot(f, ["request_nonces"]);
		const providerCalls = oidc.requests.length;
		const request = new Request(`${ORIGIN}${path}`, { headers: signed });
		if (body)
			Object.defineProperty(request, "body", {
				value: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
			});
		const response = await app.fetch(request);
		expect(snapshot(f, ["request_nonces"])).toEqual(before);
		expect(oidc.requests).toHaveLength(providerCalls);
		return response;
	}
	return { h, expectedReceipt, params, headers, get };
}
test("control: accepted three-selector route and real request signature still confirm A", async ({
	fixture: f,
}) => {
	// Arrange: provider discovery is setup-only; the GET must make no additional calls.
	const h = await setup(f);
	const params = new URLSearchParams({
		group_id: signer.groupId,
		owner_identity_id: selectedOwnerId,
		coordinator_origin: ORIGIN,
	});
	// Act
	const response = await h.get(`/v1/auth/resolved-account-owner-status?${params}`);
	// Assert
	expect(response.status).toBe(200);
	const dto = await response.json();
	expect(dto).toMatchObject({ state: "owner_confirmed", profile: safeProfile });
	expectDisplayOnly(dto);
});
test("receipt route forwards all five persisted pins and returns only the accepted DTO", async ({
	fixture: f,
}) => {
	// Arrange
	const h = await setup(f);
	const read = vi.spyOn(f.store, "readResolvedAccountOwnerStatus");
	// Act
	const response = await h.get();
	// Assert
	expect(response.status).toBe(200);
	const dto = await response.json();
	expect(dto).toMatchObject({ state: "owner_confirmed", profile: safeProfile });
	expectDisplayOnly(dto);
	expect(read).toHaveBeenCalledWith(signer, expect.objectContaining(f.cfg), {
		ownerIdentityId: selectedOwnerId,
		expectedReceipt: h.expectedReceipt,
	});
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(f.db.prepare("SELECT * FROM request_nonces").all()).toHaveLength(1);
});
test.for(["missing", "duplicate", "extra", "uppercase-digest", "oversize-id"])(
	"receipt route rejects %s query before projection or nonce writes",
	async (mode, { fixture: f }) => {
		// Arrange
		const h = await setup(f);
		if (mode === "missing") h.params.delete("resolution_id");
		if (mode === "duplicate")
			h.params.append("review_receipt_id", h.expectedReceipt.reviewReceiptId);
		if (mode === "extra") h.params.append("authority", "controller_attestation");
		if (mode === "uppercase-digest")
			h.params.set("review_evidence_digest", h.expectedReceipt.reviewEvidenceDigest.toUpperCase());
		if (mode === "oversize-id") h.params.set("attestation_id", "a".repeat(257));
		const read = vi.spyOn(f.store, "readResolvedAccountOwnerStatus");
		// Act
		const response = await h.get(`${ROOT}?${h.params}`);
		// Assert
		expect(response.status).toBe(400);
		expect(read).not.toHaveBeenCalled();
		expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual([]);
	},
);
test.for(["unsigned", "stale", "tampered-receipt"])(
	"receipt route rejects %s request proof",
	async (mode, { fixture: f }) => {
		// Arrange
		const h = await setup(f);
		const path = `${ROOT}?${h.params}`;
		const signed =
			mode === "unsigned"
				? {}
				: h.headers(path, String(NOW / 1000 - (mode === "stale" ? 10000 : 0)));
		if (mode === "tampered-receipt") h.params.set("resolution_id", "other-receipt");
		// Act
		const response = await h.get(`${ROOT}?${h.params}`, signed);
		// Assert
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain(safeProfile.email);
		expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual([]);
	},
);
test.for(["wrong-receipt", "revoked-source"])(
	"receipt route returns no profile for %s despite valid signer",
	async (mode, { fixture: f }) => {
		// Arrange
		const h = await setup(f);
		if (mode === "wrong-receipt") h.params.set("resolution_id", "other-receipt");
		else sourceController(f, h.h, "revoked_at='2026-10-02T00:00:00.000Z'");
		// Act
		const response = await h.get(`${ROOT}?${h.params}`);
		// Assert
		expect(response.status).toBe(200);
		expectNoDisclosure(await response.json());
	},
);
test("receipt route rejects replay after one authenticated nonce write", async ({ fixture: f }) => {
	// Arrange
	const h = await setup(f);
	const path = `${ROOT}?${h.params}`;
	const signed = h.headers(path);
	// Act
	const first = await h.get(path, signed);
	const replay = await h.get(path, signed);
	// Assert
	expect(first.status).toBe(200);
	expect(replay.status).toBe(401);
	expect(f.db.prepare("SELECT * FROM request_nonces").all()).toHaveLength(1);
});
test("receipt route rejects a raw GET body before projection", async ({ fixture: f }) => {
	// Arrange
	const h = await setup(f);
	const path = `${ROOT}?${h.params}`;
	const read = vi.spyOn(f.store, "readResolvedAccountOwnerStatus");
	// Act
	const response = await h.get(path, h.headers(path), true);
	// Assert
	expect(response.status).toBe(400);
	expect(read).not.toHaveBeenCalled();
	expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual([]);
});
test("receipt route binds coordinator recipient before nonce admission", async ({ fixture: f }) => {
	// Arrange
	const h = await setup(f);
	h.params.set("coordinator_origin", "https://foreign.example.test");
	// Act
	const response = await h.get(`${ROOT}?${h.params}`);
	// Assert
	expect(response.status).toBe(403);
	expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual([]);
});
