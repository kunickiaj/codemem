import { beforeEach, describe, expect, it } from "vitest";
import { state } from "../../../lib/state";
import { pairingView } from "./helpers";

describe("pairingView", () => {
	beforeEach(() => {
		state.pairingCommandRaw = "";
	});

	it("builds a base64 copy command when the payload is present", () => {
		const view = pairingView({
			device_id: "dev-a",
			fingerprint: "fp",
			public_key: "pk",
			addresses: ["http://10.10.10.10:7337"],
		});
		expect(view.payloadText).toMatch(/^echo '[A-Za-z0-9+/=]+' \| base64 -d \| codemem sync pair/);
		expect(state.pairingCommandRaw).toBe(view.payloadText);
	});

	it("falls back to a not-available message when the payload is not an object", () => {
		const view = pairingView(null);
		expect(view.payloadText).toBe("Pairing not available");
		expect(state.pairingCommandRaw).toBe("");
	});
});
