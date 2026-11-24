import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { afterEach, expect, it, vi } from "vitest";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf.js";
import { type CloudflareCoordinatorEnv, createCloudflareCoordinatorWorker } from "../src/index.js";
import {
	config,
	createRejoinOidc,
	generateDeviceKey,
	now,
} from "./device-rejoin-ceremony-fixture.js";
import { exercisePlainClaimRejoin } from "./device-rejoin-plain-claim-fixture.js";

afterEach(() => vi.restoreAllMocks());

it("C2.1 rejoins both groups through registered Worker Google routes for a plain device claim on native D1", async () => {
	vi.spyOn(Date, "now").mockReturnValue(now);
	const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
	const bindings = env as CloudflareCoordinatorEnv & {
		COORDINATOR_DB: D1Database;
		TEST_MIGRATIONS: D1Migration[];
	};
	const db = bindings.COORDINATOR_DB;
	await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
	const oidc = createRejoinOidc();
	const worker = createCloudflareCoordinatorWorker({
		now: () => new Date(now).toISOString(),
		browserAuth: {
			config,
			csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
			oidcOptions: { fetch: oidc.fetch },
		},
	});
	await exercisePlainClaimRejoin({
		key: generateDeviceKey(),
		oidc,
		request: (url, init) => {
			const headers = new Headers(init?.headers);
			headers.set("CF-Connecting-IP", "203.0.113.15");
			return worker.fetch(new Request(url, { ...init, headers }), bindings);
		},
		run: (sql, ...values) =>
			db
				.prepare(sql)
				.bind(...values)
				.run(),
		rows: async (sql) => {
			const { results } = await db.prepare(sql).all<Record<string, unknown>>();
			if (!results) throw new Error("Missing native D1 query results");
			return results;
		},
	});
	expect(network).not.toHaveBeenCalled();
});
