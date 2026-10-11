import { expect, it, vi } from "vitest";
import { issueBrowserCookie } from "../../core/src/coordinator-browser-credential.js";
import { ownerEnrollmentFinalMessage } from "../../core/src/coordinator-owner-enrollment-proof.js";
import {
	attempt,
	backend,
	type Ceremony,
	ceremonyFixture,
	claimed,
	confirmed,
	exec,
	hash,
	NOW,
	pendingKey,
	proof,
	resetCeremony,
	rows,
	snapshot,
	verified,
} from "./owner-ceremony-test-fixtures.js";

const unavailable = { kind: "rejected", error: "owner_enrollment_unavailable" };
const unknown = { kind: "rejected", error: "owner_enrollment_unknown" };
const groups = ["group-a", "group-b"];
const test = it.extend<{ ceremony: Ceremony }>({
	ceremony: async ({ task: _task }, use) => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
		try {
			await resetCeremony();
			await use(await ceremonyFixture());
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			clock.mockRestore();
			await resetCeremony();
		}
	},
});

test("native D1 private ceremony pins SDK identity and commits only after browser and pending-key proof", async ({
	ceremony: f,
}) => {
	// Arrange: only existing account links and grants, never seeded owner transitions.
	const authority = await snapshot({ authorityOnly: true });
	// Act
	const c = await verified(f);
	// Assert: callback burns OIDC material but creates no session or ownership authority.
	expect(c.callback).not.toHaveProperty("completionSecret");
	expect(c.callback.confirmation).toMatchObject({
		subject: "fixture-subject",
		identityId: "identity-a",
		groups,
		publicKey: f.key.publicKey,
		deviceId: "device-a",
	});
	expect(await attempt()).toMatchObject({ state: "oidc_verified", completion_secret_hash: null });
	expect(await rows("coordinator_auth_browser_transactions")).toEqual([
		expect.objectContaining({ state: "consumed", nonce: null, pkce_verifier: null }),
	]);
	expect(await snapshot({ authorityOnly: true })).toEqual(authority);
	// Act
	const confirmation = await f.api.confirm(
		c.request(),
		"browser-a",
		c.callback.confirmation.confirmationHash,
	);
	// Assert: original browser releases the secret only to the signed loopback destination.
	expect(confirmation).toMatchObject({
		kind: "confirmed",
		loopbackRedirect: f.start.loopbackRedirect,
	});
	if (confirmation.kind !== "confirmed") throw new Error("Missing confirmation");
	expect(await attempt()).toMatchObject({
		state: "confirmed",
		confirmation_hash: c.callback.confirmation.confirmationHash,
		completion_secret_hash: hash(Buffer.from(confirmation.completionSecret, "base64url")),
	});
	expect(await snapshot({ authorityOnly: true })).toEqual(authority);
	const signature = await f.key.sign(
		ownerEnrollmentFinalMessage(await attempt(), confirmation.completionSecret),
	);
	// Act
	const result = await f.api.finalize({
		attemptId: f.start.attemptId,
		completionSecret: confirmation.completionSecret,
		signature,
	});
	// Assert: real D1 batch counts drive binding, both eligible enrollments, audit and receipt.
	const receipt = await attempt();
	expect(result).toEqual({ kind: "finalized", bindingId: receipt.binding_id, groups });
	expect(receipt).toMatchObject({
		state: "finalized",
		loopback_redirect: null,
		finalized_at_ms: NOW,
		final_key_proof_hash: hash(signature),
	});
	expect(JSON.parse(receipt.final_outcome_json as string)).toEqual(result);
	expect(await rows("coordinator_device_ownership_bindings")).toEqual([
		expect.objectContaining({
			device_id: "device-a",
			key_id: receipt.key_id,
			identity_id: "identity-a",
			binding_id: receipt.binding_id,
			source_ref: f.start.attemptId,
			provenance: "owner_enrollment",
		}),
	]);
	expect(await rows("enrolled_devices")).toEqual(
		groups.map((group_id) =>
			expect.objectContaining({
				group_id,
				device_id: "device-a",
				public_key: f.key.publicKey,
				enabled: 1,
			}),
		),
	);
	expect(await rows("coordinator_owner_enrollment_audit_log")).toEqual([
		expect.objectContaining({
			event_id: receipt.audit_event_id,
			attempt_id: f.start.attemptId,
			binding_id: receipt.binding_id,
			action: "owner_device_enrolled",
		}),
	]);
	expect(await rows("coordinator_auth_sessions")).toEqual([]);
	expect(await rows("coordinator_auth_account_links")).toEqual(
		authorityRows(authority, "coordinator_auth_account_links"),
	);
	expect(await rows("coordinator_identity_group_grants")).toEqual(
		authorityRows(authority, "coordinator_identity_group_grants"),
	);
	expect(JSON.stringify(await snapshot())).not.toContain(confirmation.completionSecret);
	expect(f.provider.requests.filter(({ url }) => url.endsWith("/jwks"))).toHaveLength(1);
});

function authorityRows(authority: Awaited<ReturnType<typeof snapshot>>, table: string) {
	return authority.find(([name]) => name === table)?.[1];
}

test.for(["signature", "start-code"])(
	"native D1 denies invalid %s before browser claim",
	async (fault, { ceremony: f }) => {
		// Arrange
		if (fault === "start-code") expect((await f.api.start(f.start)).kind).toBe("started");
		const before = await snapshot();
		// Act
		const result =
			fault === "signature"
				? await f.api.start({ ...f.start, signature: "A".repeat(86) })
				: await f.api.claimBrowser(
						f.claimRequest(Buffer.alloc(32, 10).toString("base64url")),
						"browser-a",
					);
		// Assert
		expect(result).toEqual(unavailable);
		expect(await snapshot()).toEqual(before);
	},
);

test.for(["browser", "csrf", "commitment", "callback-replay"])(
	"native D1 denies %s after SDK verification without releasing authority",
	async (fault, { ceremony: f }) => {
		// Arrange
		const c = await verified(f);
		const other = await issueBrowserCookie("transaction");
		const before = await snapshot();
		const requests = f.provider.requests.length;
		// Act
		let result;
		if (fault === "callback-replay") {
			result = await f.api.verifyCallback(c.callbackRequest());
		} else {
			let cookie = c.cookie;
			let fields = c.fields;
			let commitment = c.callback.confirmation.confirmationHash;
			if (fault === "browser") cookie = other.setCookie.split(";")[0] ?? "";
			if (fault === "csrf") fields = { ...c.fields, csrf: proof() };
			if (fault === "commitment") commitment = "f".repeat(64);
			result = await f.api.confirm(c.request({ cookie, fields }), "browser-a", commitment);
		}
		// Assert
		expect(result).toEqual(unavailable);
		expect(await snapshot()).toEqual(before);
		expect(f.provider.requests).toHaveLength(requests);
	},
);

test("native D1 rejects callback-only finalization and one-use confirmation replay", async ({
	ceremony: f,
}) => {
	// Arrange
	const c = await verified(f);
	const secret = proof();
	const before = await snapshot();
	// Act
	const early = await f.api.finalize({
		attemptId: f.start.attemptId,
		completionSecret: secret,
		signature: await f.key.sign(ownerEnrollmentFinalMessage(await attempt(), secret)),
	});
	// Assert
	expect(early).toEqual(unavailable);
	expect(await snapshot()).toEqual(before);
	// Act
	expect(
		(await f.api.confirm(c.request(), "browser-a", c.callback.confirmation.confirmationHash)).kind,
	).toBe("confirmed");
	const confirmedState = await snapshot();
	const replay = await f.api.confirm(
		c.request(),
		"browser-a",
		c.callback.confirmation.confirmationHash,
	);
	// Assert
	expect(replay).toEqual(unavailable);
	expect(await snapshot()).toEqual(confirmedState);
});

const drift = {
	link: "UPDATE coordinator_auth_account_links SET revoked_at_ms = 1",
	grant:
		"UPDATE coordinator_identity_group_grants SET revision = revision + 1 WHERE group_id = 'group-a'",
	group: "UPDATE groups SET archived_at = 'archived' WHERE group_id = 'group-a'",
};
test.for(
	Object.entries(drift).flatMap(([fault, sql]) =>
		["confirm", "finalize"].map((stage) => ({ fault, sql, stage })),
	),
)("native D1 rechecks $fault drift at $stage", async ({ sql, stage }, { ceremony: f }) => {
	// Arrange
	const c =
		stage === "finalize" ? await confirmed(f) : { ...(await verified(f)), input: undefined };
	await exec(sql);
	const before = await snapshot();
	// Act
	const result = c.input
		? await f.api.finalize(c.input)
		: await f.api.confirm(c.request(), "browser-a", c.callback.confirmation.confirmationHash);
	// Assert
	expect(result).toEqual(unavailable);
	expect(await snapshot()).toEqual(before);
});

test.for(["secret", "signature", "key", "account"])(
	"native D1 rejects final proof for wrong %s",
	async (fault, { ceremony: f }) => {
		// Arrange
		const c = await confirmed(f);
		const input = { ...c.input };
		const row = await attempt();
		if (fault === "secret") {
			input.completionSecret = Buffer.alloc(32, 10).toString("base64url");
			input.signature = await f.key.sign(ownerEnrollmentFinalMessage(row, input.completionSecret));
		}
		if (fault === "signature") input.signature = "A".repeat(86);
		if (fault === "key")
			input.signature = await (await pendingKey()).sign(
				ownerEnrollmentFinalMessage(row, input.completionSecret),
			);
		if (fault === "account")
			input.signature = await f.key.sign(
				ownerEnrollmentFinalMessage(
					{ ...row, account_subject: "other-subject" },
					input.completionSecret,
				),
			);
		const before = await snapshot();
		// Act
		const result = await f.api.finalize(input);
		// Assert
		expect(result).toEqual(unavailable);
		expect(await snapshot()).toEqual(before);
	},
);

test.for([
	"coordinator_device_ownership_bindings",
	"enrolled_devices",
	"coordinator_owner_enrollment_audit_log",
])(
	"native D1 ceremony rolls back failed %s write and permits exact retry",
	async (table, { ceremony: f }) => {
		// Arrange: actual native D1 trigger aborts a dependent write inside the batch.
		const c = await confirmed(f);
		await exec(
			`CREATE TRIGGER ceremony_reject_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'test write failure'); END`,
		);
		const before = await snapshot();
		// Act
		const failed = await f.api.finalize(c.input);
		// Assert: caller reports uncertainty; stored confirmed attempt and all authority stay unchanged.
		expect(failed).toEqual(unknown);
		expect(await snapshot()).toEqual(before);
		// Act
		await exec("DROP TRIGGER ceremony_reject_write");
		const retry = await f.api.finalize(c.input);
		// Assert
		expect(retry).toMatchObject({ kind: "finalized", groups });
		expect(await rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
	},
);

test.for(["retained", "removed", "disabled", "revoked", "wrong-secret", "wrong-signature"])(
	"native D1 %s history retry never restores enrollment",
	async (mode, { ceremony: f }) => {
		// Arrange
		const c = await confirmed(f);
		const first = await f.api.finalize(c.input);
		expect(first.kind).toBe("finalized");
		if (mode === "removed") await exec("DELETE FROM enrolled_devices");
		if (mode === "disabled") await exec("UPDATE enrolled_devices SET enabled = 0");
		if (mode === "revoked")
			await exec("UPDATE coordinator_auth_account_links SET revoked_at_ms = 1");
		f.setNow(NOW + 600000);
		const storage = { ...backend, run: vi.fn(backend.run), batch: vi.fn(backend.batch) };
		const api = await f.compose(storage);
		const input = { ...c.input };
		if (mode === "wrong-secret") input.completionSecret = proof();
		if (mode === "wrong-signature") input.signature = "A".repeat(86);
		const before = await snapshot();
		// Act
		const result = await api.finalize(input);
		// Assert: retained receipt is history, not a grant of current access.
		expect(result).toEqual(
			mode.startsWith("wrong-") ? unavailable : { ...first, kind: "prior_commit" },
		);
		expect(storage.run).not.toHaveBeenCalled();
		expect(storage.batch).not.toHaveBeenCalled();
		expect(await snapshot()).toEqual(before);
	},
);

test("native D1 reconciles a finalized receipt after verifier rotation without a new commit", async ({
	ceremony: f,
}) => {
	const c = await confirmed(f);
	const rotatedRevision = "9".repeat(64);
	const pending = await f.compose(backend, rotatedRevision);
	const beforeCommit = await snapshot();
	expect(await pending.finalize(c.input)).toEqual(unavailable);
	expect(await snapshot()).toEqual(beforeCommit);

	const first = await f.api.finalize(c.input);
	expect(first.kind).toBe("finalized");
	f.setNow(NOW + 600000);
	const storage = { ...backend, run: vi.fn(backend.run), batch: vi.fn(backend.batch) };
	const rotated = await f.compose(storage, rotatedRevision);
	const beforeRetry = await snapshot();
	expect(await rotated.finalize(c.input)).toEqual({ ...first, kind: "prior_commit" });
	expect(await rotated.finalize({ ...c.input, signature: "A".repeat(86) })).toEqual(unavailable);
	expect(await rotated.finalize({ ...c.input, completionSecret: proof() })).toEqual(unavailable);
	expect(await snapshot()).toEqual(beforeRetry);
	expect(storage.run).not.toHaveBeenCalled();
	expect(storage.batch).not.toHaveBeenCalled();
});

test("native D1 burns a callback with an invalid provider signature and denies replay", async ({
	ceremony: f,
}) => {
	// Arrange: the SDK must reject a token signed by an untrusted provider key.
	const c = await claimed(f);
	f.provider.settings.signature = "wrong-key";
	const authority = await snapshot({ authorityOnly: true });
	// Act
	const result = await f.api.verifyCallback(c.callbackRequest());
	// Assert: only the one-use transaction is consumed; no identity or secret is granted.
	expect(result).toEqual(unavailable);
	expect(await attempt()).toMatchObject({
		state: "browser_claimed",
		account_subject: null,
		completion_secret_hash: null,
	});
	expect(await rows("coordinator_auth_browser_transactions")).toEqual([
		expect.objectContaining({ state: "consumed", nonce: null, pkce_verifier: null }),
	]);
	expect(await snapshot({ authorityOnly: true })).toEqual(authority);
	const burned = await snapshot();
	const requests = f.provider.requests.length;
	// Act
	const replay = await f.api.verifyCallback(c.callbackRequest());
	// Assert
	expect(replay).toEqual(unavailable);
	expect(await snapshot()).toEqual(burned);
	expect(f.provider.requests).toHaveLength(requests);
});

test("native D1 reconciles a lost post-commit response read-only with the same pending-key proof", async ({
	ceremony: f,
}) => {
	// Arrange: commit the real D1 batch, then fail the response read, not the transaction.
	const c = await confirmed(f);
	let committed = false;
	const api = await f.compose({
		...backend,
		batch: async (statements) => {
			await backend.batch(statements);
			committed = true;
		},
		first: async <T>(statement: Parameters<typeof backend.first>[0]) => {
			if (committed) throw new Error("lost response");
			return backend.first<T>(statement);
		},
	});
	// Act
	const lost = await api.finalize(c.input);
	// Assert
	expect(lost).toEqual(unknown);
	expect(await attempt()).toMatchObject({ state: "finalized" });
	const before = await snapshot();
	const storage = { ...backend, run: vi.fn(backend.run), batch: vi.fn(backend.batch) };
	const retryApi = await f.compose(storage);
	// Act
	const retry = await retryApi.finalize(c.input);
	// Assert
	expect(retry).toEqual({ kind: "prior_commit", bindingId: (await attempt()).binding_id, groups });
	expect(await snapshot()).toEqual(before);
	expect(storage.run).not.toHaveBeenCalled();
	expect(storage.batch).not.toHaveBeenCalled();
});
