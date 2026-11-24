import { afterEach, expect, it, vi } from "vitest";
import {
	config,
	createRejoinOidc,
	generateDeviceKey,
	now,
	origin,
} from "../../cloudflare-coordinator-worker/test/device-rejoin-ceremony-fixture.js";
import { exercisePlainClaimRejoin } from "../../cloudflare-coordinator-worker/test/device-rejoin-plain-claim-fixture.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { verifySignature } from "./sync-auth.js";

afterEach(() => vi.restoreAllMocks());

it("C2.1 rejoins both groups through registered SQLite Google routes for a plain device claim", async () => {
	vi.spyOn(Date, "now").mockReturnValue(now);
	const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
	const { db, store } = setupStore("SQLite", { authClock: () => now });
	const close = store.close.bind(store);
	vi.spyOn(store, "close").mockResolvedValue(undefined);
	try {
		const oidc = createRejoinOidc();
		const browser = await createCoordinatorBrowserAuth(
			captureCoordinatorBrowserAuthOptions({
				config,
				csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
				oidcOptions: { fetch: oidc.fetch },
			}),
			store,
			createInMemoryRequestRateLimiter({ now: () => now }),
		);
		if (!browser.ok) throw new Error(browser.error);
		const storeFactory = () => store;
		const app = createCoordinatorApp({
			storeFactory,
			runtime: { adminSecret: () => null, now: () => new Date(now).toISOString() },
			deviceRevocation: { coordinatorId: config.coordinatorId },
			requestVerifier: (input) =>
				verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
			browserAuth: {
				kind: "ready",
				auth: browser.auth,
				storeFactory,
				clientKey: () => "synthetic-client",
				clientAddress: () => "synthetic-client",
			},
		});
		await exercisePlainClaimRejoin({
			key: generateDeviceKey(),
			oidc,
			request: (url, init) => {
				expect(new URL(url).origin).toBe(origin);
				return app.request(url, init);
			},
			run: async (sql, ...values) => db.prepare(sql).run(...values),
			rows: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
		});
		expect(network).not.toHaveBeenCalled();
	} finally {
		await close();
	}
});
