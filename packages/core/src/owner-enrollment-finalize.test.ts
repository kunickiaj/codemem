import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { issueBrowserCookie, readBrowserCookie } from "./coordinator-browser-credential.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	type OwnerAttempt,
	ownerEnrollmentFinalMessage,
} from "./coordinator-owner-enrollment-proof.js";
import {
	ATTEMPTS,
	browserForm,
	config,
	hash,
	nativeBackend,
	ORIGIN,
	type OwnerStartFixture,
	ownerCallbackAuthority,
	ownerStartFixture,
	proof,
	seedOwnerCallbackAuthority,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";

const cfg = { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret };
const unavailable = { kind: "rejected", error: "owner_enrollment_unavailable" };
const unknown = { kind: "rejected", error: "owner_enrollment_unknown" };
const groups = ["group-a", "group-b"];
let f: OwnerStartFixture;
beforeEach(() => {
	f = ownerStartFixture();
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		f.close();
		vi.restoreAllMocks();
	}
});
const row = () => f.rows(ATTEMPTS)[0] as unknown as OwnerAttempt;

function excludeGroup(groupId: string) {
	f.db
		.prepare(
			"INSERT INTO coordinator_legacy_team_completions VALUES (?, 'candidate-a', 1, ?, ?, ?)",
		)
		.run(
			groupId,
			JSON.stringify({
				coordinator_id: cfg.coordinatorId,
				device_decisions: [{ decision: "excluded", device_id: "device-a" }],
			}),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
		);
}
async function verified(setup: { excludeGroup?: string } = {}) {
	const input = {
		attemptId: "attempt-a",
		deviceId: "device-a",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	input.signature = f.key.sign(
		ownerEnrollmentStartMessage(input, {
			coordinatorId: cfg.coordinatorId,
			origin: ORIGIN,
			issuer: cfg.issuer,
			revision: cfg.revision,
		}),
	);
	const form = await browserForm(input.attemptId, input.browserStartCode);
	const provider = oidcFixture({ issuer: cfg.issuer });
	let now = NOW;
	const options = {
		purpose: "owner_enroll" as const,
		mode: "local_test" as const,
		config: cfg,
		backend: f.backend,
		csrfKey: form.csrfKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: provider.fetch },
		clock: () => now,
	};
	const factory = await createCoordinatorOwnerEnrollment(options);
	if (!factory.ok) throw new Error("fixture composition failed");
	const api = factory.enrollment;
	if ((await api.start(input)).kind !== "started") throw new Error("fixture start failed");
	const claim = await api.claimBrowser(form.request(), "browser-a");
	if (claim.kind !== "browser_claimed") throw new Error("fixture claim failed");
	const cookie = claim.setCookies[0]?.split(";")[0];
	if (!cookie) throw new Error("original transaction cookie missing");
	seedOwnerCallbackAuthority(f);
	if (setup.excludeGroup) excludeGroup(setup.excludeGroup);
	const result = await api.verifyCallback(
		new Request(provider.authorize(claim.authorizationUrl), {
			headers: { cookie },
		}),
	);
	if (result.kind !== "verified") throw new Error("SDK callback failed");
	const fields = { csrf: result.csrf, attempt_id: input.attemptId };
	const request = (
		patch: { cookie?: string; origin?: string; fields?: Record<string, string> } = {},
	) =>
		new Request(`${ORIGIN}/auth/owner/confirm`, {
			method: "POST",
			headers: {
				cookie: patch.cookie ?? cookie,
				origin: patch.origin ?? ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(patch.fields ?? fields),
		});
	return {
		...api,
		options,
		provider,
		cookie,
		form,
		fields,
		request,
		callback: result,
		view: result.confirmation,
		setNow: (value: number) => {
			now = value;
		},
	};
}
type Ceremony = Awaited<ReturnType<typeof verified>>;
async function confirmed() {
	const c = await verified();
	const result = await c.confirm(c.request(), "browser-a", c.view.confirmationHash);
	if (result.kind !== "confirmed") throw new Error("fixture confirmation failed");
	const input = {
		attemptId: "attempt-a",
		completionSecret: result.completionSecret,
		// B signs only its known start values and the commitment delivered by the browser.
		signature: f.key.sign(
			JSON.stringify([
				"codemem-owner-enrollment-finalize-v2",
				"owner_enroll",
				cfg.coordinatorId,
				ORIGIN,
				cfg.revision,
				"attempt-a",
				"device-a",
				f.key.publicKey,
				await ed25519KeyId(f.key.publicKey),
				hash(f.key.publicKey),
				cfg.issuer,
				c.view.confirmationHash,
				result.completionSecret,
			]),
		),
	};
	return { ...c, result, input };
}
async function prepared(stage: string) {
	if (stage === "finalize") return confirmed();
	return { ...(await verified()), input: undefined };
}
async function recompose(c: Ceremony, backend: AuthLinkBackend, revision = cfg.revision) {
	const factory = await createCoordinatorOwnerEnrollment({
		...c.options,
		config: { ...cfg, revision },
		backend,
	});
	if (!factory.ok) throw new Error("fixture recomposition failed");
	return factory.enrollment;
}
function displayedCommitment(a: OwnerAttempt) {
	const fields = `coordinator_id attempt_id origin device_id public_key key_id fingerprint
 issuer account_subject identity_id link_id link_attempt_id link_controller_attestation_id
 link_auth_config_revision auth_config_revision browser_start_hash browser_transaction_hash
 browser_binder_hash grant_revisions_json created_at_ms expires_at_ms`.split(/\s+/);
	return hash(
		JSON.stringify(["owner_enroll", ...fields.map((key) => a[key as keyof OwnerAttempt])]),
	);
}

it("confirms exactly the SDK account, displayed commitment and eligible group list", async () => {
	// Arrange: callback alone returns no completion secret and creates no grants or enrollment.
	const c = await verified();
	const before = ownerCallbackAuthority(f);
	expect(row()).toMatchObject({
		state: "oidc_verified",
		confirmation_hash: null,
		completion_secret_hash: null,
	});
	expect(c.view.confirmationHash).toBe(displayedCommitment(row()));
	expect(c.view.groups).toEqual(groups);
	// Act
	const result = await c.confirm(c.request(), "browser-a", c.view.confirmationHash);
	const replay = await c.confirm(c.request(), "browser-a", c.view.confirmationHash);
	// Assert: only a hash of the new secret is stored; destination is persisted signed-start metadata.
	expect(c.callback).not.toHaveProperty("completionSecret");
	expect(replay).toEqual(unavailable);
	expect(result).toMatchObject({
		kind: "confirmed",
		confirmation: c.view,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
	});
	if (result.kind !== "confirmed") throw new Error("confirmation missing");
	expect(result.completionSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(row()).toMatchObject({
		state: "confirmed",
		confirmation_hash: c.view.confirmationHash,
		completion_secret_hash: hash(Buffer.from(result.completionSecret, "base64url")),
	});
	expect(JSON.stringify(f.snapshot())).not.toContain(result.completionSecret);
	expect(ownerCallbackAuthority(f)).toEqual(before);
	expect(c.provider.requests.filter(({ url }) => url.endsWith("/jwks"))).toHaveLength(1);
});

it("confirms the eligible Team while leaving a previously excluded Team out", async () => {
	const c = await verified({ excludeGroup: "group-a" });
	const before = ownerCallbackAuthority(f);
	expect(c.view.groups).toEqual(["group-b"]);
	const result = await c.confirm(c.request(), "browser-a", c.view.confirmationHash);
	expect(result).toMatchObject({ kind: "confirmed", confirmation: { groups: ["group-b"] } });
	expect(JSON.parse(row().grant_revisions_json as string)).toEqual([
		{ groupId: "group-b", revision: 3 },
	]);
	expect(ownerCallbackAuthority(f)).toEqual(before);
});

it("denies confirmation when an exclusion changes the pinned eligible set", async () => {
	const c = await verified();
	excludeGroup("group-b");
	const before = f.snapshot();
	expect(await c.confirm(c.request(), "browser-a", c.view.confirmationHash)).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it.each([
	"browser",
	"start-cookie",
	"origin",
	"csrf",
	"start-csrf",
	"commitment",
	"attempt",
	"destination",
])("rejects confirmation with wrong %s without releasing a secret", async (fault) => {
	// Arrange
	const c = await verified();
	const patch: Parameters<typeof c.request>[0] = {};
	let commitment = c.view.confirmationHash;
	if (fault === "browser")
		patch.cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
	if (fault === "start-cookie") patch.cookie = c.form.cookie.setCookie.split(";")[0];
	if (fault === "origin") patch.origin = "https://evil.example.test";
	if (fault === "csrf") patch.fields = { ...c.fields, csrf: proof() };
	if (fault === "start-csrf") patch.fields = { ...c.fields, csrf: c.form.fields.csrf as string };
	if (fault === "commitment") commitment = "f".repeat(64);
	if (fault === "attempt") patch.fields = { ...c.fields, attempt_id: "other-attempt" };
	if (fault === "destination")
		patch.fields = { ...c.fields, loopback_redirect: "https://evil.example.test" };
	const before = f.snapshot();
	// Act
	const result = await c.confirm(c.request(patch), "browser-a", commitment);
	// Assert: unexpected form fields cannot supply a completion destination.
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

const authorityDrift = {
	link: `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW}`,
	account: "UPDATE coordinator_auth_account_links SET subject='other-subject'",
	grant:
		"UPDATE coordinator_identity_group_grants SET status='revoked',revoked_at='2026-10-01' WHERE group_id='group-a'",
	revision:
		"UPDATE coordinator_identity_group_grants SET revision=revision+1 WHERE group_id='group-a'",
	group: "UPDATE groups SET archived_at='2026-10-01' WHERE group_id='group-a'",
};
function revokeKey() {
	f.db
		.prepare(`INSERT INTO coordinator_device_revocations
	(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
	VALUES ('ed25519_key',?,'revocation-a','group-a','device-a','evidence-key','evidence-fingerprint','2026-10-01')`)
		.run(row().key_id);
}
it.each(["confirm", "finalize"] as const)(
	"denies expired %s at the exact deadline",
	async (stage) => {
		// Arrange
		const c = await prepared(stage);
		c.setNow(NOW + 600000);
		const before = f.snapshot();
		// Act
		const result = c.input
			? await c.finalize(c.input)
			: await c.confirm(c.request(), "browser-a", c.view.confirmationHash);
		// Assert
		expect(result).toEqual(unavailable);
		expect(f.snapshot()).toEqual(before);
	},
);
it.each(
	Object.entries(authorityDrift).flatMap(([fault, sql]) =>
		["confirm", "finalize"].map((stage) => ({ fault, sql, stage })),
	),
)("rechecks live $fault after verified at $stage", async ({ sql, stage }) => {
	// Arrange
	const c = await prepared(stage);
	f.db.exec(sql);
	const before = f.snapshot();
	// Act
	const result = c.input
		? await c.finalize(c.input)
		: await c.confirm(c.request(), "browser-a", c.view.confirmationHash);
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});
it.each(["confirm", "finalize"] as const)(
	"rechecks canonical key revocation at %s",
	async (stage) => {
		// Arrange
		const c = await prepared(stage);
		revokeKey();
		const before = f.snapshot();
		// Act
		const result = c.input
			? await c.finalize(c.input)
			: await c.confirm(c.request(), "browser-a", c.view.confirmationHash);
		// Assert
		expect(result).toEqual(unavailable);
		expect(f.snapshot()).toEqual(before);
	},
);

it("commits only existing permitted groups, one binding, audit and immutable receipt atomically", async () => {
	// Arrange
	const c = await confirmed();
	const grants = f.rows("coordinator_identity_group_grants");
	const account = f.rows("coordinator_auth_account_links");
	// Act
	const result = await c.finalize(c.input);
	// Assert
	expect(result).toMatchObject({ kind: "finalized", bindingId: expect.any(String), groups });
	expect(f.rows("coordinator_device_ownership_bindings")).toHaveLength(1);
	expect(f.rows("coordinator_device_ownership_bindings")[0]).toMatchObject({
		device_id: "device-a",
		key_id: row().key_id,
		identity_id: "identity-a",
	});
	expect(
		f.rows("enrolled_devices").map((e) => [e.group_id, e.device_id, e.enabled, e.public_key]),
	).toEqual(groups.map((g) => [g, "device-a", 1, f.key.publicKey]));
	expect(f.rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
	expect(f.rows("coordinator_owner_enrollment_audit_log")[0]).toMatchObject({
		attempt_id: "attempt-a",
		action: "owner_device_enrolled",
		binding_id: row().binding_id,
	});
	expect(row()).toMatchObject({
		state: "finalized",
		loopback_redirect: null,
		finalized_at_ms: NOW,
		final_key_proof_hash: hash(c.input.signature),
	});
	expect(JSON.parse(row().final_outcome_json as string)).toEqual(result);
	expect(f.rows("coordinator_identity_group_grants")).toEqual(grants);
	expect(f.rows("coordinator_auth_account_links")).toEqual(account);
	expect(f.rows("coordinator_auth_sessions")).toEqual([]);
});

it.each(["secret", "signature", "key", "account", "link", "group", "confirmation"])(
	"rejects final proof with wrong %s",
	async (fault) => {
		// Arrange: signatures for different commitments are genuine, but not this pending ceremony.
		const c = await confirmed();
		const input = { ...c.input };
		if (fault === "secret") {
			input.completionSecret = proof();
			input.signature = f.key.sign(ownerEnrollmentFinalMessage(row(), input.completionSecret));
		}
		if (fault === "signature") input.signature = "A".repeat(86);
		const claimed = { ...row() };
		if (fault === "account") claimed.account_subject = "other-subject";
		if (fault === "link") claimed.link_id = "other-link";
		if (["account", "link"].includes(fault))
			claimed.confirmation_hash = displayedCommitment(claimed);
		if (fault === "confirmation") claimed.confirmation_hash = "a".repeat(64);
		if (fault === "group") {
			claimed.grant_revisions_json = '[{"groupId":"group-other","revision":1}]';
			claimed.confirmation_hash = displayedCommitment(claimed);
		}
		if (["key", "account", "link", "group", "confirmation"].includes(fault)) {
			const signer = fault === "key" ? commitPendingKey() : f.key;
			input.signature = signer.sign(ownerEnrollmentFinalMessage(claimed, input.completionSecret));
		}
		const before = f.snapshot();
		// Act
		const result = await c.finalize(input);
		// Assert
		expect(result).toEqual(unavailable);
		expect(f.snapshot()).toEqual(before);
	},
);

it.each(["account_subject", "link_id", "grant_revisions_json", "confirmation_hash"] as const)(
	"denies changed stored %s despite a valid browser-approved v2 proof",
	async (field) => {
		// Arrange: freeze B's real proof before server metadata changes.
		const c = await confirmed();
		let value = "other-value";
		if (field === "grant_revisions_json") value = '[{"groupId":"group-a","revision":99}]';
		if (field === "confirmation_hash") value = "a".repeat(64);
		const api = await recompose(c, {
			...f.backend,
			first: async <T>(statement: Parameters<AuthLinkBackend["first"]>[0]) => {
				const captured = await f.backend.first<T>(statement);
				if (statement.sql.startsWith(`SELECT * FROM ${ATTEMPTS}`))
					return { ...captured, [field]: value } as T;
				return captured;
			},
		});
		const before = f.snapshot();
		// Act
		const result = await api.finalize(c.input);
		// Assert
		expect(result).toEqual(unavailable);
		expect(f.snapshot()).toEqual(before);
	},
);

it.each(["unchanged", "removed", "disabled", "revoked", "wrong-secret", "wrong-signature"])(
	"exact retry is read-only prior_commit with enrollment %s",
	async (state) => {
		// Arrange
		const c = await confirmed();
		const first = await c.finalize(c.input);
		expect(first.kind).toBe("finalized");
		if (state === "removed") f.db.exec("DELETE FROM enrolled_devices");
		if (state === "disabled") f.db.exec("UPDATE enrolled_devices SET enabled=0");
		if (state === "revoked") revokeKey();
		c.setNow(NOW + 600000);
		const before = f.snapshot();
		const backend = { ...f.backend, run: vi.fn(f.backend.run), batch: vi.fn(f.backend.batch) };
		const api = await recompose(c, backend);
		const input = { ...c.input };
		if (state === "wrong-secret") input.completionSecret = proof();
		if (state === "wrong-signature") input.signature = "A".repeat(86);
		// Act
		const result = await api.finalize(input);
		// Assert: receipt reports history, never current permission or restoration.
		expect(result).toEqual(
			state.startsWith("wrong-") ? unavailable : { ...first, kind: "prior_commit" },
		);
		expect(f.snapshot()).toEqual(before);
		expect(backend.run).not.toHaveBeenCalled();
		expect(backend.batch).not.toHaveBeenCalled();
	},
);

it("reconciles a finalized receipt after verifier rotation without accepting an uncommitted attempt", async () => {
	const c = await confirmed();
	const revised = "9".repeat(64);
	const rotated = await recompose(c, f.backend, revised);
	const beforeCommit = f.snapshot();
	expect(await rotated.finalize(c.input)).toEqual(unavailable);
	expect(f.snapshot()).toEqual(beforeCommit);

	const first = await c.finalize(c.input);
	expect(first.kind).toBe("finalized");
	c.setNow(NOW + 600000);
	const backend = { ...f.backend, run: vi.fn(f.backend.run), batch: vi.fn(f.backend.batch) };
	const retry = await recompose(c, backend, revised);
	const beforeRetry = f.snapshot();
	expect(await retry.finalize(c.input)).toEqual({ ...first, kind: "prior_commit" });
	expect(await retry.finalize({ ...c.input, signature: "A".repeat(86) })).toEqual(unavailable);
	expect(await retry.finalize({ ...c.input, completionSecret: proof() })).toEqual(unavailable);
	expect(f.snapshot()).toEqual(beforeRetry);
	expect(backend.run).not.toHaveBeenCalled();
	expect(backend.batch).not.toHaveBeenCalled();
});

it("callback-only proof cannot finalize or create authority", async () => {
	// Arrange
	const c = await verified();
	const secret = proof();
	const before = f.snapshot();
	// Act
	const result = await c.finalize({
		attemptId: "attempt-a",
		completionSecret: secret,
		signature: f.key.sign(ownerEnrollmentFinalMessage(row(), secret)),
	});
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it("a live account session cannot replace the original transaction browser proof", async () => {
	// Arrange
	const c = await verified();
	const session = await issueBrowserCookie("session");
	const cookie = session.setCookie.split(";")[0] ?? "";
	const parsed = await readBrowserCookie(cookie, "session");
	if (parsed.kind !== "present") throw new Error("session fixture failed");
	f.db
		.prepare(`INSERT INTO coordinator_auth_sessions
	(coordinator_id,session_id,credential_hash,browser_transaction_hash,link_id,identity_id,issuer,subject,auth_config_revision,created_at_ms,expires_at_ms)
	VALUES (?,'session-a',?,?,'link-a','identity-a',?,'fixture-subject',?,?,?)`)
		.run(
			cfg.coordinatorId,
			parsed.cookieHash,
			"f".repeat(64),
			cfg.issuer,
			cfg.revision,
			NOW,
			NOW + 28800000,
		);
	const before = f.snapshot();
	// Act
	const result = await c.confirm(c.request({ cookie }), "browser-a", c.view.confirmationHash);
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it.each(["binding", "enrollment", "audit"])(
	"SQL %s fault rolls back receipt and all dependent writes",
	async (fault) => {
		// Arrange
		const c = await confirmed();
		const table = {
			binding: "coordinator_device_ownership_bindings",
			enrollment: "enrolled_devices",
			audit: "coordinator_owner_enrollment_audit_log",
		}[fault];
		f.db.exec(
			`CREATE TRIGGER reject_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test write failure'); END`,
		);
		const before = f.snapshot();
		// Act
		const result = await c.finalize(c.input);
		// Assert: error is unknown, not an unsupported claim of no possible commit.
		expect(result).toEqual(unknown);
		expect(f.snapshot()).toEqual(before);
	},
);

it("lost post-commit response reports unknown then reconciles the same proof read-only", async () => {
	// Arrange
	const c = await confirmed();
	let committed = false;
	const api = await recompose(c, {
		...f.backend,
		batch: async (statements) => {
			await f.backend.batch(statements);
			committed = true;
		},
		first: async <T>(statement: Parameters<AuthLinkBackend["first"]>[0]) => {
			if (committed) throw new Error("lost response");
			return f.backend.first<T>(statement);
		},
	});
	// Act
	const lost = await api.finalize(c.input);
	const before = f.snapshot();
	const retry = await c.finalize(c.input);
	// Assert
	expect(lost).toEqual(unknown);
	expect(retry).toMatchObject({ kind: "prior_commit", bindingId: row().binding_id, groups });
	expect(f.snapshot()).toEqual(before);
	expect(f.rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
});

it("two concurrent finalizers return one commit and its prior receipt", async () => {
	// Arrange: both connections capture confirmed before either actual atomic writer proceeds.
	const c = await confirmed();
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reads = 0;
	const apis = await Promise.all(
		[f.backend, nativeBackend(f.second)].map((backend) =>
			recompose(c, {
				...backend,
				first: async <T>(statement: Parameters<AuthLinkBackend["first"]>[0]) => {
					const captured = await backend.first<T>(statement);
					if (statement.sql.startsWith(`SELECT * FROM ${ATTEMPTS}`) && reads < 2) {
						if (++reads === 2) release();
						await ready;
					}
					return captured;
				},
			}),
		),
	);
	// Act
	const results = await Promise.all(apis.map((api) => api.finalize(c.input)));
	// Assert
	expect(reads).toBe(2);
	expect(results.map((r) => r.kind).sort()).toEqual(["finalized", "prior_commit"]);
	expect(results).toEqual(
		expect.arrayContaining([
			{ kind: "finalized", bindingId: row().binding_id, groups },
			{ kind: "prior_commit", bindingId: row().binding_id, groups },
		]),
	);
	expect(f.rows("coordinator_device_ownership_bindings")).toHaveLength(1);
	expect(f.rows("enrolled_devices")).toHaveLength(2);
	expect(f.rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
});

it.each(
	["confirm", "finalize"].flatMap((stage) =>
		["database", "metadata"].map((fault) => ({ stage, fault })),
	),
)("untrusted $fault during $stage reports honest unknown", async ({ stage, fault }) => {
	// Arrange
	const c = await prepared(stage);
	const api = await recompose(c, {
		...f.backend,
		first: async <T>(statement: Parameters<AuthLinkBackend["first"]>[0]) => {
			if (fault === "database") throw new Error("database unavailable");
			const captured = await f.backend.first<T>(statement);
			if (statement.sql.startsWith(`SELECT * FROM ${ATTEMPTS}`))
				return { ...captured, grant_revisions_json: "invalid JSON" } as T;
			return captured;
		},
	});
	const before = f.snapshot();
	// Act
	const result = c.input
		? await api.finalize(c.input)
		: await api.confirm(c.request(), "browser-a", c.view.confirmationHash);
	// Assert
	expect(result).toEqual(unknown);
	expect(f.snapshot()).toEqual(before);
});
