import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, vi } from "vitest";
import { backendTest, type LinkFixture } from "./coordinator-auth-link-test-fixtures.js";
import { deterministicReviewTests } from "./coordinator-owner-resolution-review-test-fixtures.js";
import { readCoordinatorResolvedAccountOwnerReceiptStatus as read } from "./coordinator-resolved-account-owner-status-client.js";
import {
	safeProfile,
	setupResolved,
} from "./coordinator-resolved-account-owner-status-test-fixtures.js";
import { verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { generateKeypair, loadPublicKey } from "./sync-identity.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));
deterministicReviewTests();
const test = backendTest("SQLite");
const ORIGIN = "https://coordinator.example.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const close of cleanup.splice(0)) close();
});
async function setup(f: LinkFixture) {
	const h = await setupResolved(f, "SQLite");
	if (!h.fact) throw new Error("fixture fact missing");
	const r = h.fact.resolution;
	const receipt = {
		attestationId: r.source_attestation_id,
		reviewReceiptId: r.source_review_receipt_id,
		reviewEvidenceDigest: r.source_evidence_digest,
		resolutionId: r.resolution_id,
		resolutionEvidenceDigest: r.resolution_evidence_digest,
	};
	const dir = mkdtempSync(join(tmpdir(), "receipt-client-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const keysDir = join(dir, "keys");
	mkdirSync(keysDir);
	generateKeypair(join(keysDir, "device.key"), join(keysDir, "device.key.pub"));
	const publicKey = loadPublicKey(keysDir) ?? "";
	const fingerprint = fingerprintPublicKey(publicKey);
	const db = new Database(join(dir, "local.sqlite"));
	db.exec(
		"CREATE TABLE sync_device(device_id,public_key,fingerprint); CREATE TABLE metadata(key,value); INSERT INTO metadata VALUES ('memory_actor','identity-c')",
	);
	db.prepare("INSERT INTO sync_device VALUES (?,?,?)").run(
		"current-laptop",
		publicKey,
		fingerprint,
	);
	const dbPath = db.name;
	db.close();
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	const dto = {
		version: 1,
		coordinatorId: f.cfg.coordinatorId,
		groupId: "group-a",
		deviceId: "current-laptop",
		fingerprint,
		state: "owner_confirmed",
		ownerIdentity: "identity-a",
		profileState: "linked",
		profile: safeProfile,
	};
	const transport = vi.fn<typeof fetch>(async () => Response.json(dto));
	const options = {
		dbPath,
		keysDir,
		groupId: "group-a",
		coordinatorUrl: ORIGIN,
		ownerIdentityId: "identity-a",
		receipt,
		fetch: transport,
	};
	return { options, transport, dto, publicKey };
}
test("receipt client signs all eight selectors, actual persisted receipt IDs and empty GET", async ({
	fixture: f,
}) => {
	// Arrange
	const h = await setup(f);
	// Act
	const result = await read(h.options);
	// Assert
	expect(result).toEqual({ kind: "owner_status", status: h.dto });
	expect(h.transport).toHaveBeenCalledOnce();
	const [input, init] = h.transport.mock.calls[0];
	const request = new Request(input, init);
	const url = new URL(request.url);
	expect(url.origin).toBe(ORIGIN);
	expect(url.pathname).toBe("/v1/auth/resolved-account-owner-receipt-status");
	expect([...url.searchParams.entries()].sort()).toEqual(
		Object.entries({
			group_id: "group-a",
			owner_identity_id: "identity-a",
			coordinator_origin: ORIGIN,
			attestation_id: h.options.receipt.attestationId,
			review_receipt_id: h.options.receipt.reviewReceiptId,
			review_evidence_digest: h.options.receipt.reviewEvidenceDigest,
			resolution_id: h.options.receipt.resolutionId,
			resolution_evidence_digest: h.options.receipt.resolutionEvidenceDigest,
		}).sort(),
	);
	expect(request.method).toBe("GET");
	expect(await request.text()).toBe("");
	expect(init?.redirect).toBe("manual");
	const proof = {
		method: "GET",
		pathWithQuery: url.pathname + url.search,
		bodyBytes: Buffer.alloc(0),
		deviceId: "current-laptop",
		publicKey: h.publicKey,
		timestamp: request.headers.get("X-Opencode-Timestamp") ?? "",
		nonce: request.headers.get("X-Opencode-Nonce") ?? "",
		signature: request.headers.get("X-Opencode-Signature") ?? "",
	};
	expect(verifySignature(proof)).toBe(true);
	for (const field of [
		"attestation_id",
		"review_receipt_id",
		"review_evidence_digest",
		"resolution_id",
		"resolution_evidence_digest",
	]) {
		const changed = new URL(url);
		changed.searchParams.set(field, "tampered");
		expect(verifySignature({ ...proof, pathWithQuery: changed.pathname + changed.search })).toBe(
			false,
		);
	}
});
test.for(["missing", "null", "partial", "extra", "getter", "inherited", "uppercase-digest"])(
	"receipt client rejects %s reference before device IO or fetch",
	async (mode, { fixture: f }) => {
		// Arrange
		const h = await setup(f);
		const input = { ...h.options };
		const access = vi.fn(() => {
			throw new Error("untrusted getter must not run");
		});
		if (mode === "missing") Object.assign(input, { receipt: undefined });
		if (mode === "null") Object.assign(input, { receipt: null });
		if (mode === "partial") {
			const { resolutionId: _, ...partial } = input.receipt;
			Object.assign(input, { receipt: partial });
		}
		if (mode === "extra")
			Object.assign(input, { receipt: { ...input.receipt, authority: "controller_attestation" } });
		if (mode === "getter") Object.defineProperty(input.receipt, "attestationId", { get: access });
		if (mode === "inherited") input.receipt = Object.create(input.receipt);
		if (mode === "uppercase-digest")
			input.receipt.reviewEvidenceDigest = input.receipt.reviewEvidenceDigest.toUpperCase();
		Object.defineProperty(input, "dbPath", { get: access });
		// Act
		const result = await read(input);
		// Assert
		expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
		expect(access).not.toHaveBeenCalled();
		expect(h.transport).not.toHaveBeenCalled();
	},
);
test.for(["wrong-subject", "private-receipt", "oversize-body"])(
	"receipt client rejects %s response without returning profile or provenance",
	async (mode, { fixture: f }) => {
		// Arrange
		const h = await setup(f);
		let response = Response.json({ ...h.dto, deviceId: "other-device" });
		if (mode === "private-receipt")
			response = Response.json({ ...h.dto, resolutionId: h.options.receipt.resolutionId });
		if (mode === "oversize-body")
			response = new Response("x".repeat(16 * 1024 + 1), { headers: { "content-length": "1" } });
		h.transport.mockResolvedValue(response);
		// Act
		const result = await read(h.options);
		// Assert
		expect(result).toEqual({ kind: "unavailable", code: "invalid_response" });
	},
);
test("receipt client maps missing endpoint to unsupported without ordinary fallback", async ({
	fixture: f,
}) => {
	// Arrange
	const h = await setup(f);
	h.transport.mockResolvedValue(new Response("private server detail", { status: 404 }));
	// Act
	const result = await read(h.options);
	// Assert
	expect(result).toEqual({ kind: "unsupported" });
	expect(h.transport).toHaveBeenCalledOnce();
});
test("receipt client accepts a safe unconfirmed result without inventing authority", async ({
	fixture: f,
}) => {
	// Arrange
	const h = await setup(f);
	const dto = {
		...h.dto,
		state: "owner_unconfirmed",
		ownerIdentity: null,
		profileState: "unavailable",
		profile: null,
	};
	h.transport.mockResolvedValue(Response.json(dto));
	// Act
	const result = await read(h.options);
	// Assert
	expect(result).toEqual({ kind: "owner_status", status: dto });
});
test("receipt client bounds an unresponsive transport by the existing ten-second deadline", async ({
	fixture: f,
}) => {
	// Arrange
	const h = await setup(f);
	vi.useFakeTimers();
	h.transport.mockImplementation(() => new Promise(() => {}));
	// Act
	const pending = read(h.options);
	await vi.advanceTimersByTimeAsync(10000);
	const result = await pending;
	// Assert
	expect(result).toEqual({ kind: "unavailable", code: "coordinator_unreachable" });
	expect(h.transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
