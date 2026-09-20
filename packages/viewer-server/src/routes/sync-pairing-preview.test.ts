import { generateKeyPairSync } from "node:crypto";
import { fingerprintPublicKey } from "@codemem/core";
import { expect, it, vi } from "vitest";
import { syncRoutes } from "./sync.js";

it("previews pairing formats and rejects malformed payloads without store or network access", async () => {
	const public_key = generateKeyPairSync("ed25519")
		.publicKey.export({ type: "spki", format: "pem" })
		.toString()
		.trim();
	const payload = {
		device_id: "peer-device",
		fingerprint: fingerprintPublicKey(public_key),
		public_key,
		addresses: ["http://peer.example.test:7337"],
	};
	const getStore = vi.fn(() => {
		throw new Error("Inspection must not open the store");
	});
	const app = syncRoutes(getStore);
	const fetchSpy = vi.spyOn(globalThis, "fetch");
	const inspect = (invite: string) =>
		app.request("/api/sync/invites/inspect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ invite }),
		});
	try {
		const json = JSON.stringify(payload);
		const encoded = Buffer.from(json).toString("base64");
		for (const invite of [
			json,
			encoded,
			`echo '${encoded}' | base64 -d | codemem sync pair --accept-file -`,
		]) {
			const response = await inspect(invite);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				kind: "pair",
				device_id: payload.device_id,
				fingerprint: payload.fingerprint,
				addresses: payload.addresses,
			});
		}
		for (const invite of [
			"{",
			"not-a-payload",
			JSON.stringify({ ...payload, addresses: [] }),
			JSON.stringify({ ...payload, fingerprint: "wrong" }),
		]) {
			expect((await inspect(invite)).status).toBe(400);
		}
		expect(getStore).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	} finally {
		fetchSpy.mockRestore();
	}
});
