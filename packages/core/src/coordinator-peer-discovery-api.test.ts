import { expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";

it.each(["healthy", "candidate revoked", "unavailable", "invalid signature", "requester revoked"])(
	"peer API privacy and admission: %s",
	async (mode) => {
		// Arrange: all HTTP requests stay in-process; signed admission uses the existing verifier seam.
		const store = new BetterSqliteCoordinatorStore(":memory:");
		const close = vi.spyOn(store, "close").mockResolvedValue();
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		await store.createGroup("fixture-group");
		await store.enrollDevice("fixture-group", {
			deviceId: "requester",
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: "fixture-fp",
		});
		await store.enrollDevice("fixture-group", {
			deviceId: "target",
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: "fixture-fp",
		});
		if (mode === "candidate revoked" || mode === "requester revoked") {
			const requester = mode === "requester revoked";
			await store.createDeviceRevocation({
				groupId: "fixture-group",
				deviceId: requester ? "requester" : "target",
				publicKey: requester ? UNRELATED_PUBLIC_KEY : CANONICAL_PUBLIC_KEY,
				fingerprint: "fixture-fp",
			});
		}
		const getter = vi.spyOn(store, "listGroupPeers");
		if (mode === "unavailable") getter.mockRejectedValue(new Error("private backend diagnostic"));
		const verifier = vi.fn(async () => mode !== "invalid signature");
		const app = createCoordinatorApp({
			storeFactory: () => store,
			requestVerifier: verifier,
			runtime: { adminSecret: () => null, now: () => "2026-10-07T00:00:00Z" },
		});
		try {
			// Act
			const response = await app.request("/v1/peers?group_id=fixture-group", {
				headers: {
					"X-Opencode-Device": "requester",
					"X-Opencode-Signature": "fixture-signature",
					"X-Opencode-Timestamp": "2026-10-07T00:00:00Z",
					"X-Opencode-Nonce": "fixture-nonce",
				},
			});
			const body = await response.json();
			// Assert: no discovery getter runs before signature and revocation admission.
			const statuses = {
				healthy: 200,
				"candidate revoked": 200,
				unavailable: 503,
				"invalid signature": 401,
				"requester revoked": 403,
			};
			expect(response.status).toBe(statuses[mode]);
			if (mode === "unavailable") expect(body).toEqual({ error: "peer_discovery_unavailable" });
			if (mode === "candidate revoked") expect(body).toMatchObject({ items: [] });
			if (mode === "healthy")
				expect(body).toMatchObject({ items: [expect.objectContaining({ device_id: "target" })] });
			if (mode === "invalid signature" || mode === "requester revoked")
				expect(getter).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			close.mockRestore();
			fetch.mockRestore();
			await store.close();
		}
	},
);
