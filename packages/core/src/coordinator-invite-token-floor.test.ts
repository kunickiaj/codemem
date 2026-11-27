import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { InviteTokenSealError } from "./coordinator-invite-token-seal.js";
import { InviteTokenStorage } from "./coordinator-invite-token-storage.js";

// A build whose lookups still compare a presented token with the stored column.
vi.mock("./coordinator-invite-token-seal.js", async (original) => ({
	...(await original<typeof import("./coordinator-invite-token-seal.js")>()),
	INVITE_TOKEN_LOOKUP_VERSION: 0,
}));

it("never seals in a build below the digest-only lookup floor, even with the floor recorded", async () => {
	// Arrange: a valid key, sealed token columns, and the operator's recorded floor.
	const run = vi.fn(async () => 1);
	const recorded = { present: 1, lookup_version_seen: 1, min_serving_lookup_version: 1 };
	const storage = new InviteTokenStorage(
		{ first: async <T>() => recorded as T, all: async () => [], run },
		() => ({ current: randomBytes(32).toString("hex") }),
		(token) => token,
	);
	// Act
	const columns = await storage.seal("bearer-token", "invite");
	const backfill = await storage.sealStoredTokens(10).then(
		() => null,
		(error: unknown) => error,
	);
	// Assert: the row keeps its bearer token, and the backfill refuses before any write.
	expect(columns).toEqual({ stored: "bearer-token", ciphertext: null, keyId: null });
	expect(backfill).toBeInstanceOf(InviteTokenSealError);
	expect((backfill as InviteTokenSealError).code).toBe("invite_token_lookup_floor_unmet");
	expect(run).not.toHaveBeenCalled();
});
