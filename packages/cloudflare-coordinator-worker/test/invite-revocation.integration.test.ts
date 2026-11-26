import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	INVITE_REVOCATION_CLOCK_MS,
	inviteRevocationHarness,
	registerInviteRevocationContract,
} from "../../core/src/coordinator-invite-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 invitation revocation", () => {
	const test = inviteRevocationHarness(async (use) => {
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, {
			authClock: () => INVITE_REVOCATION_CLOCK_MS,
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({ store, prefix: `invite-revoke-native-${++sequence}` });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	registerInviteRevocationContract(test);
});
