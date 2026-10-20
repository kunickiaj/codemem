import { expect, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import {
	ownerStartFixture,
	seedOwnerCallbackAuthority,
} from "./coordinator-owner-enrollment-historical-test-fixture.js";
import type { OwnerAttempt } from "./coordinator-owner-enrollment-proof.js";
import {
	ATTEMPTS,
	browserForm,
	config,
	ORIGIN,
	proof,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { registerOwnerPinTests } from "./owner-enrollment-owner-pin-test-harness.js";
import { ownerEnrollmentStartMessage } from "./owner-enrollment-start.js";

registerOwnerPinTests(async (use) => {
	const f = ownerStartFixture();
	const network = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("Live network forbidden"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	try {
		seedOwnerCallbackAuthority(f);
		const cfg = { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret };
		const start = {
			attemptId: "attempt-a",
			deviceId: "device-a",
			publicKey: f.key.publicKey,
			loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
			browserStartCode: proof(),
			signature: "",
		};
		start.signature = f.key.sign(ownerEnrollmentStartMessage(start, { ...cfg, origin: ORIGIN }));
		const form = await browserForm(start.attemptId, start.browserStartCode);
		await use({
			options: {
				purpose: "owner_enroll",
				mode: "local_test",
				config: cfg,
				backend: f.backend,
				csrfKey: form.csrfKey,
				limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
				oidcOptions: {},
				clock: () => NOW,
			},
			start,
			key: f.key,
			claimRequest: () => form.request(),
			attempt: async () => f.rows(ATTEMPTS)[0] as unknown as OwnerAttempt,
			exec: async (sql, ...values) => f.db.prepare(sql).run(...values),
			snapshot: async (options) => {
				const tables = f.db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
					)
					.all() as { name: string }[];
				return tables
					.filter(
						({ name }) =>
							!options?.authorityOnly ||
							![ATTEMPTS, "coordinator_auth_browser_transactions"].includes(name),
					)
					.map(({ name }) => [
						name,
						f.db
							.prepare(
								`SELECT * FROM ${name} ORDER BY ${name === "coordinator_auth_device_claims" ? "claim_id" : "rowid"}`,
							)
							.all(),
					]);
			},
		});
		expect(network).not.toHaveBeenCalled();
	} finally {
		f.close();
		vi.restoreAllMocks();
	}
});
