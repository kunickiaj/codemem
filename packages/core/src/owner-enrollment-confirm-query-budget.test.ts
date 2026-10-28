import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyAccountConnectionSchema } from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { withCoordinatorAuthSchema } from "./coordinator-auth-schema.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import {
	ownerStartFixture,
	seedOwnerCallbackAuthority,
} from "./coordinator-owner-enrollment-historical-test-fixture.js";
import {
	ATTEMPTS,
	browserForm,
	config,
	nativeBackend,
	ORIGIN,
	proof,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";

let f: ReturnType<typeof ownerStartFixture>;
let executions: string[];
let backend: AuthLinkBackend;
beforeEach(() => {
	f = ownerStartFixture();
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
	executions = [];
	const record = (sql: string) => executions.push(sql);
	const d1 = sqliteD1(f.db, { beforeRead: record, beforeWrite: record });
	if (!d1.batch) throw new Error("fixture requires native D1 batch support");
	const batch = d1.batch.bind(d1);
	const statement = (s: AuthLinkStatement) => d1.prepare(s.sql).bind(...s.values);
	backend = withCoordinatorAuthSchema({
		first: (s) => statement(s).first(),
		run: async (s) => {
			const receipt = (await statement(s).run()) as { meta?: { changes?: number } };
			return receipt.meta?.changes ?? 0;
		},
		batch: (statements) => batch(statements.map(statement)),
	});
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		f.close();
		vi.restoreAllMocks();
	}
});

async function verified() {
	const cfg = { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret };
	const input = {
		attemptId: "attempt-a",
		deviceId: "device-a",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	input.signature = f.key.sign(ownerEnrollmentStartMessage(input, { ...cfg, origin: ORIGIN }));
	const form = await browserForm(input.attemptId, input.browserStartCode);
	const provider = oidcFixture({ issuer: cfg.issuer });
	const composed = await createCoordinatorOwnerEnrollment({
		purpose: "owner_enroll",
		mode: "local_test",
		config: cfg,
		backend,
		csrfKey: form.csrfKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: provider.fetch },
		clock: () => NOW,
	});
	if (!composed.ok) throw new Error("fixture composition failed");
	const api = composed.enrollment;
	expect((await api.start(input, "transport-a")).kind).toBe("started");
	const claim = await api.claimBrowser(form.request(), "browser-a");
	if (claim.kind !== "browser_claimed") throw new Error("fixture claim failed");
	const cookie = claim.setCookies[0]?.split(";")[0];
	if (!cookie) throw new Error("missing transaction cookie");
	seedOwnerCallbackAuthority(f);
	const callback = await api.verifyCallback(
		new Request(provider.authorize(claim.authorizationUrl), { headers: { cookie } }),
	);
	if (callback.kind !== "verified") throw new Error("fixture callback failed");
	return {
		confirm: () =>
			api.confirm(
				new Request(`${ORIGIN}/auth/owner/confirm`, {
					method: "POST",
					headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ csrf: callback.csrf, attempt_id: input.attemptId }),
				}),
				"browser-a",
				callback.confirmation.confirmationHash,
			),
	};
}

it.each(["v2-null-pin", "ready-null-pin", "legacy-absent-pin"])(
	"confirms %s without optional qualification probes",
	async (schema) => {
		// Arrange: actual D1 execution hooks count first/all/run invocations, never prepare calls.
		if (schema === "ready-null-pin") await applyAccountConnectionSchema(nativeBackend(f.db));
		if (schema === "legacy-absent-pin") {
			f.db.exec(`DROP TABLE ${ATTEMPTS}`);
			for (const name of [
				"0030_add_owner_enrollment_attempts.sql",
				"0034_add_owner_admission_pin.sql",
			])
				f.db.exec(
					readFileSync(
						new URL(`../../cloudflare-coordinator-worker/migrations/${name}`, import.meta.url),
						"utf8",
					),
				);
		}
		const c = await verified();
		const attempt = f.rows(ATTEMPTS)[0];
		if (!attempt) throw new Error("missing verified attempt");
		expect(Object.hasOwn(attempt, "owner_qualification_id")).toBe(schema !== "legacy-absent-pin");
		if (schema !== "legacy-absent-pin") expect(attempt.owner_qualification_id).toBeNull();
		executions.length = 0;
		// Act
		const result = await c.confirm();
		// Assert: core confirm has three operations with fresh schema checks. HTTP routing adds its own call.
		expect(result.kind).toBe("confirmed");
		expect(executions).toHaveLength(schema === "ready-null-pin" ? 9 : 6);
		// Legacy SQL verifies column absence in the authority statement itself, without another call.
		expect(
			executions.some((sql) =>
				sql.startsWith(
					"SELECT EXISTS (SELECT 1 FROM pragma_table_info('coordinator_owner_enrollment_attempts')",
				),
			),
		).toBe(false);
		expect(executions.some((sql) => sql.includes("owner_enrollment_qualification_immutable"))).toBe(
			false,
		);
		expect(f.rows(ATTEMPTS)[0]?.state).toBe("confirmed");
	},
);

it.each([
	["revocation", `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW}`],
	["link birth", "UPDATE coordinator_auth_account_links SET subject='different-subject'"],
	["grant revision", "UPDATE coordinator_identity_group_grants SET revision=revision+1"],
	[
		"grant revocation",
		"UPDATE coordinator_identity_group_grants SET status='revoked',revoked_at='2026-10-01'",
	],
])("rejects %s after preflight and before the conditional winning UPDATE", async (_name, sql) => {
	// Arrange: real SQL mutation between the two checks, not a mocked authority result.
	const c = await verified();
	const before = f.rows(ATTEMPTS);
	const run = backend.run.bind(backend);
	let entered = false;
	vi.spyOn(backend, "run").mockImplementation(async (s) => {
		if (s.sql.includes("SET state = 'confirmed'")) {
			entered = true;
			f.db.exec(sql);
		}
		return run(s);
	});
	// Act
	const result = await c.confirm();
	// Assert: no completion secret, ownership, or confirmation commitment escapes the stale preflight.
	expect(entered).toBe(true);
	expect(result).toEqual({ kind: "rejected", error: "owner_enrollment_unavailable" });
	expect(f.rows(ATTEMPTS)).toEqual(before);
	expect(f.rows("coordinator_device_ownership_bindings")).toEqual([]);
});

it.each([
	["undefined pin", { owner_qualification_id: undefined }],
	["empty pin", { owner_qualification_id: "" }],
	["malformed pin", { owner_qualification_id: 1 }],
	["mixed pin", { owner_qualification_id: "qualification-a" }],
	["whitespace pin", { owner_qualification_id: " qualification-a" }],
	["malformed controller", { link_controller_attestation_id: " controller-a" }],
])("does not choose the controller shortcut for a stored %s", async (_name, patch) => {
	// Arrange: malformed runtime snapshots cannot be stored by canonical SQL constraints.
	const c = await verified();
	const before = f.rows(ATTEMPTS);
	const first = backend.first.bind(backend);
	vi.spyOn(backend, "first").mockImplementation(async <T>(s: AuthLinkStatement) => {
		const row = await first<T>(s);
		if (s.sql.startsWith("SELECT * FROM coordinator_owner_enrollment_attempts"))
			return { ...row, ...patch } as T;
		return row;
	});
	executions.length = 0;
	// Act
	const result = await c.confirm();
	// Assert: malformed pins must never be treated as legacy absence or explicit NULL.
	expect(result.kind).toBe("rejected");
	expect(f.rows(ATTEMPTS)).toEqual(before);
	expect(executions.filter((sql) => sql.includes("SET state = 'confirmed'"))).toEqual([]);
});

it("rejects an omitted snapshot pin when the database actually has the qualification column", async () => {
	// Arrange: only released legacy storage may omit the qualification pin.
	const c = await verified();
	const before = f.rows(ATTEMPTS);
	const first = backend.first.bind(backend);
	vi.spyOn(backend, "first").mockImplementation(async <T>(s: AuthLinkStatement) => {
		const row = await first<T>(s);
		if (!s.sql.startsWith("SELECT * FROM coordinator_owner_enrollment_attempts")) return row;
		const { owner_qualification_id: _pin, ...withoutPin } = row as Record<string, unknown>;
		return withoutPin as T;
	});
	// Act
	const result = await c.confirm();
	// Assert: the inline legacy absence check must reject a truncated current-schema snapshot.
	expect(result).toEqual({ kind: "rejected", error: "owner_enrollment_unavailable" });
	expect(f.rows(ATTEMPTS)).toEqual(before);
});
