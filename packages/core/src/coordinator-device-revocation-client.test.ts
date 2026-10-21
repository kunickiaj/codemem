import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type CoordinatorRevokeDeviceActionOptions,
	coordinatorRevokeDeviceAction as revoke,
	COORDINATOR_DEVICE_REVOCATION_SCOPE as scope,
} from "./coordinator-device-revocation-client.js";

// Real HTTP client; synthetic responses do not activate routes or prove server authority.
const key = "a".repeat(64),
	digest = "b".repeat(64),
	secret = "fixture-admin-secret";
const subjects = {
	version: 1,
	coordinator_id: "coordinator-a",
	group_id: "group-a",
	device_id: "device-a",
	key_id: key,
	scope,
};
const preview = { ...subjects, state: "ready", expected_digest: digest };
const committed = {
	...subjects,
	state: "revoked",
	revocations: [
		{
			subject_kind: "device_id",
			subject_value: "device-a",
			revocation_id: "first-device",
			created_at: "retained device timestamp",
		},
		{
			subject_kind: "ed25519_key",
			subject_value: key,
			revocation_id: "first-key",
			created_at: "2001-01-01T00:00:00+07:00",
		},
	],
};
function options(commit = false): CoordinatorRevokeDeviceActionOptions {
	const opts = {
		remoteUrl: "https://coordinator.example.test",
		adminSecret: secret,
		groupId: "group-a",
		deviceId: "device-a",
	};
	return commit
		? {
				...opts,
				expectedDigest: digest,
				expectedContext: { coordinatorId: "coordinator-a", keyId: key },
			}
		: opts;
}
function reply(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), { status });
}
it("preserves non-NUL ledger receipt text exactly, including terminal control characters", async () => {
	// Arrange: receipt validity is not terminal-display safety or timestamp parsing.
	const text = "ledger\n\u001b\u0085\u202e\u2028\u2029\ud800";
	const payload = {
		...committed,
		revocations: committed.revocations.map((row) => ({
			...row,
			revocation_id: `${text}:${row.subject_kind}`,
			created_at: `${row.subject_kind}:${text}`,
		})),
	};
	vi.mocked(fetch).mockResolvedValueOnce(reply(payload));
	// Act
	const result = await revoke(options(true));
	// Assert
	expect(result).toEqual(payload);
	expect(fetch).toHaveBeenCalledOnce();
});
beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected request")));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it.each([
	"https://coordinator.example.test",
	"https://coordinator.example.test/",
	"http://127.0.0.1:7337",
	"http://[::1]:7337",
])("previews once at approved origin %s without redirect", async (remoteUrl) => {
	// Arrange
	vi.mocked(fetch).mockResolvedValueOnce(reply(preview));
	const onDispatch = vi.fn();
	// Act
	const result = await revoke({ ...options(), remoteUrl, onDispatch });
	// Assert
	expect(result).toEqual(preview);
	expect(onDispatch).not.toHaveBeenCalled();
	expect(fetch).toHaveBeenCalledExactlyOnceWith(
		`${remoteUrl.replace(/\/$/, "")}/v1/admin/devices/revoke-preview`,
		expect.objectContaining({
			method: "POST",
			redirect: "error",
			headers: expect.objectContaining({ "X-Codemem-Coordinator-Admin": secret }),
		}),
	);
	const init = vi.mocked(fetch).mock.calls[0]?.[1];
	expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
		group_id: "group-a",
		device_id: "device-a",
	});
});
it.each([
	"http://localhost",
	"http://127.1",
	"http://2130706433",
	"http://0x7f000001",
	"http://127.0.0.2",
	"http://[::ffff:127.0.0.1]",
	"http://remote.example.test",
	"https://u:p@coordinator.example.test",
	"https://coordinator.example.test/path",
	"https://coordinator.example.test?",
	"https://coordinator.example.test#",
	" https://coordinator.example.test",
	"https://coordinator.example.test\\",
	"HTTPS://coordinator.example.test",
])("rejects origin %s before credentials or dispatch", async (remoteUrl) => {
	// Arrange
	const onDispatch = vi.fn();
	// Act
	const result = revoke({ ...options(true), remoteUrl, onDispatch });
	// Assert
	await expect(result).rejects.toThrow("revocation_invalid_input");
	expect(fetch).not.toHaveBeenCalled();
	expect(onDispatch).not.toHaveBeenCalled();
});
it.each([
	{ groupId: "" },
	{ deviceId: " device-a" },
	{ groupId: "a".repeat(257) },
	{ deviceId: "a\u200b" },
	{ expectedDigest: "A".repeat(64) },
	{ expectedDigest: "short" },
	{ expectedContext: { coordinatorId: "", keyId: key } },
	{ expectedContext: { coordinatorId: "coordinator-a", keyId: "bad" } },
	{ timeoutS: 0 },
	{ timeoutS: 3601 },
	{ timeoutS: Number.NaN },
	{ timeoutS: Number.POSITIVE_INFINITY },
	{ adminSecret: "" },
	{ adminSecret: " " },
	{ adminSecret: "secret\r\nheader" },
	{ adminSecret: "secret\0" },
	{ adminSecret: "🔒" },
])("rejects invalid options %j without dispatch", async (patch) => {
	// Arrange
	const onDispatch = vi.fn();
	// Act
	const result = revoke({ ...options(true), ...patch, onDispatch });
	// Assert
	await expect(result).rejects.toThrow(/^revocation_(invalid_input|admin_required)$/);
	expect(fetch).not.toHaveBeenCalled();
	expect(onDispatch).not.toHaveBeenCalled();
});
it("rejects expected context on a preview", async () => {
	// Arrange
	const opts = { ...options(), expectedContext: { coordinatorId: "coordinator-a", keyId: key } };
	// Act
	const result = revoke(opts);
	// Assert
	await expect(result).rejects.toThrow("revocation_invalid_input");
	expect(fetch).not.toHaveBeenCalled();
});
it("pins mutable request and expected context before awaiting, preserving distinct first references", async () => {
	// Arrange
	const pending = Promise.withResolvers<Response>();
	const onDispatch = vi.fn(() => expect(fetch).not.toHaveBeenCalled());
	vi.mocked(fetch).mockReturnValueOnce(pending.promise);
	const opts = { ...options(true), onDispatch };
	// Act
	const result = revoke(opts);
	opts.deviceId = "changed";
	opts.groupId = "changed";
	opts.adminSecret = "changed";
	opts.remoteUrl = "https://changed.example.test";
	opts.expectedDigest = "c".repeat(64);
	if (opts.expectedContext) {
		opts.expectedContext.coordinatorId = "changed";
		opts.expectedContext.keyId = "c".repeat(64);
	}
	pending.resolve(reply(committed));
	// Assert
	await expect(result).resolves.toEqual(committed);
	expect(onDispatch).toHaveBeenCalledOnce();
	expect(fetch).toHaveBeenCalledOnce();
	const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
	expect(url).toBe("https://coordinator.example.test/v1/admin/devices/revoke");
	expect(init?.headers).toMatchObject({ "X-Codemem-Coordinator-Admin": secret });
	expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
		group_id: "group-a",
		device_id: "device-a",
		expected_digest: digest,
	});
});
const invalidValues: Record<string, unknown[]> = {
	state: [null, "wrong"],
	version: [null, 2, "1"],
	coordinator_id: [null, "", " coor"],
	group_id: [null, "group-b"],
	device_id: [null, "device-b"],
	key_id: [null, "A".repeat(64), "short"],
	scope: [null, "group_only"],
	expected_digest: [null, "B".repeat(64), "short"],
	revocations: [
		null,
		{},
		[],
		[committed.revocations[0]],
		[...committed.revocations, committed.revocations[0]],
		[...committed.revocations].reverse(),
	],
};
for (const commit of [false, true]) {
	const valid = commit ? committed : preview;
	const fallback = commit ? "revocation_outcome_unknown" : "revocation_unavailable";
	for (const field of Object.keys(valid)) {
		it.each([undefined, ...(invalidValues[field] ?? [])].map((value) => ({ value })))(
			`rejects ${commit ? "commit" : "preview"} missing/bad ${field}: %j`,
			async ({ value }) => {
				// Arrange: JSON omits undefined, testing every required field.
				vi.mocked(fetch).mockResolvedValueOnce(reply({ ...valid, [field]: value }));
				// Act
				const result = revoke(options(commit));
				// Assert
				await expect(result).rejects.toThrow(fallback);
				expect(fetch).toHaveBeenCalledOnce();
			},
		);
	}
	it.each(
		[null, [], "raw diagnostic", { ...valid, error: "secret-body" }].map((payload) => ({
			payload,
		})),
	)(`rejects ${commit ? "commit" : "preview"} invalid envelope %j`, async ({ payload }) => {
		// Arrange
		vi.mocked(fetch).mockResolvedValueOnce(reply(payload));
		// Act
		const result = revoke(options(commit));
		// Assert
		await expect(result).rejects.toThrow(fallback);
	});
	it(`strips extra envelope and reference fields in ${commit ? "commit" : "preview"}`, async () => {
		// Arrange
		const payload = {
			...valid,
			raw_key: "private diagnostic",
			actor: "not authority",
			...(commit
				? { revocations: committed.revocations.map((row) => ({ ...row, evidence: "private" })) }
				: {}),
		};
		vi.mocked(fetch).mockResolvedValueOnce(reply(payload));
		// Act
		const result = await revoke(options(commit));
		// Assert
		expect(result).toEqual(valid);
	});
	it.each(["non-json secret-body", "x".repeat(16385), ""])(
		`rejects ${commit ? "commit" : "preview"} unreadable response without leaks`,
		async (body) => {
			// Arrange
			vi.mocked(fetch).mockResolvedValueOnce(new Response(body));
			// Act
			const error = await revoke(options(commit)).catch((error: Error) => error);
			// Assert
			expect(error).toEqual(new Error(fallback));
			expect(error).not.toHaveProperty("cause");
			expect(fetch).toHaveBeenCalledOnce();
		},
	);
	it(`redacts transport failures in ${commit ? "commit" : "preview"} without retry`, async () => {
		// Arrange
		vi.mocked(fetch).mockRejectedValueOnce(
			new Error(`${secret} transport`, { cause: new Error("private cause") }),
		);
		// Act
		const error = await revoke(options(commit)).catch((error: Error) => error);
		// Assert
		expect(error).toEqual(new Error(fallback));
		expect(error).not.toHaveProperty("cause");
		expect(fetch).toHaveBeenCalledOnce();
	});
}
for (const index of [0, 1]) {
	for (const field of ["subject_kind", "subject_value", "revocation_id", "created_at"]) {
		it.each([undefined, null, "", "bad\0value"])(
			`rejects reference ${index} missing/bad ${field}: %j`,
			async (value) => {
				// Arrange
				const rows = committed.revocations.map((row, i) =>
					i === index ? { ...row, [field]: value } : row,
				);
				vi.mocked(fetch).mockResolvedValueOnce(reply({ ...committed, revocations: rows }));
				// Act
				const result = revoke(options(true));
				// Assert
				await expect(result).rejects.toThrow("revocation_outcome_unknown");
			},
		);
	}
}
it.each([
	{ revocations: [committed.revocations[0], committed.revocations[0]] },
	{ revocations: [committed.revocations[1], committed.revocations[1]] },
	{ revocations: [null, committed.revocations[1]] },
	{ revocations: [committed.revocations[0], []] },
])("rejects duplicate or non-object retained references %j", async ({ revocations }) => {
	// Arrange
	vi.mocked(fetch).mockResolvedValueOnce(reply({ ...committed, revocations }));
	// Act
	const result = revoke(options(true));
	// Assert
	await expect(result).rejects.toThrow("revocation_outcome_unknown");
	expect(fetch).toHaveBeenCalledOnce();
});
it.each([{ coordinator_id: "coordinator-b" }, { key_id: "c".repeat(64) }])(
	"rejects reviewed commit context drift %j",
	async (patch) => {
		// Arrange
		vi.mocked(fetch).mockResolvedValueOnce(reply({ ...committed, ...patch }));
		// Act
		const result = revoke(options(true));
		// Assert
		await expect(result).rejects.toThrow("revocation_outcome_unknown");
	},
);
it.each([409, 400, 401, 403, 500, 302])(
	"recognizes definitive denial only at 409, not %i",
	async (status) => {
		// Arrange
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "revocation_preview_stale", diagnostic: secret }), {
				status,
				statusText: "private status text",
			}),
		);
		// Act
		const error = await revoke(options(true)).catch((error: Error) => error);
		// Assert
		expect(error).toMatchObject({
			code: status === 409 ? "revocation_preview_stale" : "revocation_outcome_unknown",
			status,
		});
		expect(String(error)).not.toMatch(/fixture-admin-secret|private status|diagnostic/);
		expect(error).not.toHaveProperty("cause");
		expect(fetch).toHaveBeenCalledOnce();
	},
);
it.each([
	"revocation_target_unavailable",
	"revocation_preview_stale",
	"device_revocation_incomplete",
	"secret-error",
])("maps 409 error %s without exposing arbitrary codes", async (code) => {
	// Arrange
	vi.mocked(fetch).mockResolvedValueOnce(reply({ error: code }, 409));
	// Act
	const result = revoke(options(true));
	// Assert
	await expect(result).rejects.toMatchObject({
		code:
			code === "revocation_target_unavailable" || code === "revocation_preview_stale"
				? code
				: "revocation_outcome_unknown",
	});
});
