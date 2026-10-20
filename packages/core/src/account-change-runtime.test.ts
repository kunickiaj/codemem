import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import * as accountReceiver from "./coordinator-account-link-receiver.js";
import {
	type ChangeCoordinatorAccountOptions,
	CoordinatorAccountLinkError,
	changeCoordinatorAccount,
} from "./coordinator-account-link-runtime.js";
import { verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

// Signed client tests with a fake coordinator, not tests of the HTTP/store implementation.
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));
afterEach(() => vi.restoreAllMocks());
const origin = "https://coordinator.example.test";
const hash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
function localGet(url: string, headers: Record<string, string> = {}) {
	if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(url)) throw new Error("nonlocal test URL");
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const request = httpRequest(url, { headers }, (response) => {
			let body = "";
			response.on("data", (chunk) => {
				body += chunk.toString();
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request.setTimeout(3000, () => request.destroy(new Error("local timeout")));
		request.on("error", reject);
		request.end();
	});
}
function deviceKeys(keysDir: string) {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(4 + kind.length + 4 + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const fingerprint = fingerprintPublicKey(publicKey);
	writeFileSync(
		join(keysDir, "device.key"),
		keys.privateKey.export({ type: "pkcs8", format: "pem" }),
		{ mode: 0o600 },
	);
	writeFileSync(join(keysDir, "device.key.pub"), publicKey);
	return { publicKey, fingerprint };
}
function fixture(intent: "refresh" | "disconnect" = "refresh") {
	const dir = mkdtempSync(join(tmpdir(), "codemem-change-"));
	const keysDir = join(dir, "keys");
	mkdirSync(keysDir);
	const dbPath = join(dir, "local.sqlite");
	const db = new Database(dbPath);
	initTestSchema(db);
	const { publicKey, fingerprint } = deviceKeys(keysDir);
	db.prepare(
		"INSERT INTO sync_device (device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run("device-a", publicKey, fingerprint, new Date().toISOString());
	const calls: Request[] = [];
	const create: Record<string, string> = {};
	const status = {
		attemptId: "",
		intent,
		identityId: "identity-a",
		state: "pending",
		expiresAtMs: Date.now() + 600000,
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		expect(url.origin).toBe(origin);
		expect(init?.redirect).toBe("manual");
		const bodyBytes = Buffer.from(await req.clone().arrayBuffer());
		expect(
			verifySignature({
				method: req.method,
				pathWithQuery: url.pathname + url.search,
				bodyBytes,
				deviceId: "device-a",
				publicKey,
				timestamp: req.headers.get("x-opencode-timestamp") ?? "",
				nonce: req.headers.get("x-opencode-nonce") ?? "",
				signature: req.headers.get("x-opencode-signature") ?? "",
			}),
		).toBe(true);
		calls.push(req.clone());
		if (url.pathname === "/v1/auth/account-unlinks") {
			const body = await req.json();
			return Response.json({
				state: "completed",
				coordinatorId: "coordinator-a",
				identityId: body.identity_id,
				targetLinkId: body.target_link_id,
				attemptId: body.attempt_id,
			});
		}
		if (url.pathname === "/v1/auth/account-changes") {
			Object.assign(create, await req.json());
			status.attemptId = create.attempt_id ?? "";
			return Response.json({ coordinator_id: "coordinator-a", identity_id: "identity-a", status });
		}
		if (url.pathname.endsWith("/cancel")) status.state = "cancelled";
		if (url.pathname.endsWith("/finalize")) status.state = "completed";
		return Response.json({ status });
	});
	let browserDone: Promise<unknown> = Promise.resolve();
	let page = "";
	let receiptUrl = "";
	let receiptHeaders: Record<string, string> = {};
	const completion = randomBytes(32).toString("base64url");
	const onBrowserStart = vi.fn((privateUrl: string) => {
		const url = new URL(privateUrl);
		expect(url.origin + url.pathname).toBe(`${origin}/auth/account/change/start`);
		expect(url.searchParams.get("attempt_id")).toBe(status.attemptId);
		expect(hash(url.searchParams.get("start_code") ?? "")).toBe(create.browser_start_hash);
		status.state = "confirmed";
		browserDone = localGet(
			`${create.loopback_redirect}?attempt_id=${status.attemptId}&completion=${completion}`,
		).then((reply) => {
			expect(reply.status).toBe(200);
			page = reply.body;
			receiptUrl = new URL("/codemem/auth/result", create.loopback_redirect).href;
			receiptHeaders = {
				"X-Codemem-Receipt": page.match(/data-receipt="([^"]+)"/)?.[1] ?? "",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			};
		});
		void browserDone.catch(() => {});
	});
	const options: ChangeCoordinatorAccountOptions = {
		dbPath,
		keysDir,
		coordinatorUrl: origin,
		groupId: "group-a",
		intent,
		expectedIdentityId: "identity-a",
		expectedCoordinatorId: "coordinator-a",
		fetch,
		onBrowserStart,
	};
	return {
		options,
		calls,
		create,
		status,
		completion,
		fetch,
		onBrowserStart,
		browserDone: () => browserDone,
		page: () => page,
		receipt: () => localGet(receiptUrl, receiptHeaders),
		snapshot: () => ({
			device: db.prepare("SELECT * FROM sync_device").all(),
			key: readFileSync(join(keysDir, "device.key"), "utf8"),
		}),
		close() {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
const test = it.extend<{ f: ReturnType<typeof fixture> }>({
	f: async ({ task: _task }, use) => {
		const f = fixture();
		try {
			await use(f);
		} finally {
			f.close();
		}
	},
});

async function rewriteUnlinkReply(
	response: Response,
	mode: string,
	count: number,
): Promise<Response> {
	if (mode === "wrong pins")
		return Response.json({ ...(await response.json()), identityId: "wrong-identity" });
	if (mode === "rejected" || (mode === "retry rejected" && count === 2))
		return Response.json({ error: "account_change_unavailable" }, { status: 403 });
	return response;
}
test.for([
	"success",
	"lost reply",
	"malformed",
	"server error",
	"both lost",
	"rejected",
	"abort",
	"wrong pins",
	"retry rejected",
])("device unlink %s uses no browser and retries only the exact operation", async (mode, { f }) => {
	f.options.intent = "disconnect";
	f.options.expectedLinkId = "current-link";
	const before = f.snapshot();
	const forward = f.fetch.getMockImplementation();
	if (!forward) throw new Error("missing fixture fetch");
	const controller = new AbortController();
	const receiver = vi.spyOn(accountReceiver, "createCoordinatorAccountLinkReceiver");
	let count = 0;
	f.fetch.mockImplementation(async (url, init) => {
		const response = await rewriteUnlinkReply(await forward(url, init), mode, ++count);
		if (mode === "abort") {
			controller.abort();
			throw new Error("private lost reply");
		}
		if (mode === "both lost" || (["lost reply", "retry rejected"].includes(mode) && count === 1))
			throw new Error("private lost reply");
		if (mode === "malformed" && count === 1) return new Response('{"state":');
		if (mode === "server error" && count === 1) return new Response(null, { status: 500 });
		return response;
	});
	const result = await changeCoordinatorAccount({
		...f.options,
		signal: controller.signal,
	}).catch((error: unknown) => error);
	if (["both lost", "abort", "wrong pins", "retry rejected"].includes(mode))
		expect(result).toMatchObject({ code: "cancellation_unconfirmed" });
	else if (mode === "rejected") expect(result).toMatchObject({ code: "review_required" });
	else expect(result).toMatchObject({ intent: "disconnect", state: "completed" });
	expect(f.onBrowserStart).not.toHaveBeenCalled();
	expect(receiver).not.toHaveBeenCalled();
	expect(f.calls.every((req) => new URL(req.url).pathname === "/v1/auth/account-unlinks")).toBe(
		true,
	);
	expect(f.calls).toHaveLength(["success", "rejected", "abort"].includes(mode) ? 1 : 2);
	if (f.calls.length === 2) {
		expect(await f.calls[0]?.text()).toBe(await f.calls[1]?.text());
		expect(f.calls[0]?.headers.get("x-opencode-nonce")).not.toBe(
			f.calls[1]?.headers.get("x-opencode-nonce"),
		);
	}
	expect(f.snapshot()).toEqual(before);
});

test.for(
	(["refresh", "disconnect"] as const).flatMap((intent) =>
		(["request_failed", "cancellation_unconfirmed", "link_stopped"] as const).map((code) => ({
			intent,
			code,
		})),
	),
)(
	"$intent $code uses safe account-change wording without changing its error type",
	async ({ intent, code }, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		if (code === "request_failed")
			f.fetch.mockResolvedValue(
				Response.json({ error: "account_change_unavailable" }, { status: 403 }),
			);
		if (code === "cancellation_unconfirmed")
			f.fetch.mockRejectedValue(new Error("private transport details"));
		if (code === "link_stopped")
			f.options.onBrowserStart = () => {
				f.status.state = "failed";
			};
		const error = await changeCoordinatorAccount(f.options).catch((error: unknown) => error);
		const messages = {
			request_failed: "The account change could not finish. Try again.",
			cancellation_unconfirmed:
				"Could not confirm cancellation; the request will expire. The account change may already have finished if the final reply was lost.",
			link_stopped: "The account change stopped or expired. Try again.",
		};
		expect(error).toBeInstanceOf(CoordinatorAccountLinkError);
		expect(error).toMatchObject({ code, message: messages[code] });
		expect(String(error)).not.toContain("private transport details");
	},
);

test.for(
	(
		[
			[400, "account_change_invalid_input"],
			[401, "account_change_unavailable"],
			[403, "account_change_unavailable"],
			[404, "not_found"],
		] as const
	).flatMap(([status, label]) =>
		(["refresh", "disconnect"] as const).map((intent) => ({ status, label, intent })),
	),
)(
	"definitive $intent create rejection $status preserves the error without cancellation",
	async ({ intent, status, label }, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		f.fetch.mockImplementation(async () => Response.json({ error: label }, { status }));
		const error = await changeCoordinatorAccount(f.options).catch((error: unknown) => error);
		expect(error).toMatchObject({ code: "request_failed" });
		expect(f.fetch).toHaveBeenCalledOnce();
		expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(false);
		expect(f.onBrowserStart).not.toHaveBeenCalled();
	},
);

test.for(
	[
		{ status: 403, body: "not JSON" },
		{ status: 403, body: JSON.stringify({ error: "account_change_unavailable", extra: true }) },
		{ status: 403, body: JSON.stringify({ error: "unknown_proxy_error" }) },
		{
			status: 403,
			body: JSON.stringify({ error: "account_change_unavailable", padding: "x".repeat(16384) }),
		},
		{ status: 400, body: JSON.stringify({ error: "account_change_unavailable" }) },
		{ status: 200, body: JSON.stringify({ error: "account_change_unavailable" }) },
		{ status: 409, body: JSON.stringify({ error: "account_change_unavailable" }) },
		{ status: 429, body: JSON.stringify({ error: "rate_limited" }) },
		{ status: 500, body: JSON.stringify({ error: "account_change_unavailable" }) },
		{ status: 503, body: JSON.stringify({ error: "account_change_unavailable" }) },
	].flatMap((reply, variant) =>
		(["refresh", "disconnect"] as const).map((intent) => ({ ...reply, variant, intent })),
	),
)(
	"ambiguous $intent create reply $variant still cancels and preserves uncertainty",
	async ({ intent, status, body }, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		f.fetch.mockImplementation(async (url) =>
			String(url).endsWith("/cancel")
				? Response.json({ error: "account_change_unavailable" }, { status: 403 })
				: new Response(body, { status }),
		);
		expect(
			await changeCoordinatorAccount(f.options).catch((error: unknown) => error),
		).toMatchObject({ code: "cancellation_unconfirmed" });
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/cancel"))).toHaveLength(1);
		expect(f.onBrowserStart).not.toHaveBeenCalled();
	},
);

test.for(
	(["lost reply", "timeout", "abort"] as const).flatMap((mode) =>
		(["refresh", "disconnect"] as const).map((intent) => ({ mode, intent })),
	),
)(
	"$intent create $mode after dispatch still cancels the possibly created attempt",
	async ({ mode, intent }, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fixture fetch");
		const controller = new AbortController();
		f.fetch.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/cancel"))
				return Response.json({ error: "account_change_unavailable" }, { status: 403 });
			await forward(url, init);
			if (mode === "abort") controller.abort();
			throw new DOMException(
				"private lost create",
				mode === "timeout" ? "TimeoutError" : "AbortError",
			);
		});
		const error = await changeCoordinatorAccount({ ...f.options, signal: controller.signal }).catch(
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ code: "cancellation_unconfirmed" });
		expect(String(error)).not.toContain("private lost create");
		expect(f.status.state).toBe("pending");
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/cancel"))).toHaveLength(1);
		expect(f.onBrowserStart).not.toHaveBeenCalled();
	},
);

test.for(["refresh", "disconnect"] as const)(
	"%s rejection after successful create still attempts cancellation",
	async (intent, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		f.options.onBrowserStart = () => {};
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fixture fetch");
		f.fetch.mockImplementation(async (url, init) =>
			new URL(String(url)).pathname === "/v1/auth/account-changes"
				? forward(url, init)
				: Response.json({ error: "account_change_unavailable" }, { status: 403 }),
		);
		expect(
			await changeCoordinatorAccount(f.options).catch((error: unknown) => error),
		).toMatchObject({ code: "cancellation_unconfirmed" });
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/cancel"))).toHaveLength(1);
	},
);

test.for(["refresh", "disconnect"] as const)(
	"%s uses fixed contract and a held truthful completion receipt",
	async (intent, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		const before = f.snapshot();
		const running = changeCoordinatorAccount(f.options);
		// Wait for the actual proof-bearing POST before requesting the trusted receipt ACK.
		await vi.waitFor(() => expect(f.status.state).toBe("completed"), { timeout: 5000 });
		await f.browserDone();
		expect(await f.receipt()).toMatchObject({
			status: 200,
			body: JSON.stringify({ intent, completed: true }),
		});
		expect(await running).toEqual({
			intent,
			state: "completed",
			coordinatorId: "coordinator-a",
			identityId: "identity-a",
			attemptId: f.status.attemptId,
		});
		expect(Object.keys(f.create).sort()).toEqual(
			[
				"group_id",
				"identity_id",
				"intent",
				"attempt_id",
				"runtime_verifier_hash",
				"browser_start_hash",
				"loopback_redirect",
			].sort(),
		);
		const final = await f.calls.find((req) => req.url.endsWith("/finalize"))?.json();
		expect(final).toEqual({
			purpose: "coordinator-account-change-v1",
			coordinator_id: "coordinator-a",
			identity_id: "identity-a",
			attempt_id: f.status.attemptId,
			group_id: "group-a",
			device_id: "device-a",
			fingerprint: before.device[0] && (before.device[0] as { fingerprint: string }).fingerprint,
			runtime_verifier: final.runtime_verifier,
			completion: f.completion,
		});
		expect(hash(final.runtime_verifier)).toBe(f.create.runtime_verifier_hash);
		for (const req of f.calls.filter((req) => req.method === "GET")) {
			expect(Object.fromEntries(new URL(req.url).searchParams)).toEqual({
				group_id: "group-a",
				identity_id: "identity-a",
				runtime_verifier_hash: f.create.runtime_verifier_hash,
			});
			expect(req.url).not.toContain(final.runtime_verifier);
		}
		expect(f.page()).not.toContain("Google account linked");
		expect(f.page()).not.toContain("window.opener");
		expect(f.snapshot()).toEqual(before);
	},
);

test.for(["intent", "identityId", "attemptId", "expiresAtMs", "extra", "coordinator"])(
	"rejects create %s mismatch before URL release",
	async (field, { f }) => {
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fixture fetch");
		f.fetch.mockImplementation(async (input, init) => {
			const response = await forward(input, init);
			if (new URL(String(input)).pathname !== "/v1/auth/account-changes") return response;
			const data = await response.json();
			if (field === "coordinator") data.coordinator_id = "other-coordinator";
			else data.status[field] = field === "expiresAtMs" ? Date.now() + 9999999 : "wrong";
			return Response.json(data);
		});
		expect(
			await changeCoordinatorAccount(f.options).catch((error: unknown) => error),
		).toBeInstanceOf(Error);
		expect(f.onBrowserStart).not.toHaveBeenCalled();
		expect(f.calls.some((req) => req.url.endsWith("/finalize"))).toBe(false);
	},
);

test.for(["status", "finalize", "cancel"])(
	"validates %s intent and identity pins",
	async (stage, { f }) => {
		const controller = new AbortController();
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fixture fetch");
		f.fetch.mockImplementation(async (input, init) => {
			const response = await forward(input, init);
			const req = new Request(input, init);
			if ((stage === "status" && req.method === "GET") || req.url.endsWith(`/${stage}`)) {
				const data = await response.json();
				data.status.intent = "disconnect";
				data.status.identityId = "other-identity";
				return Response.json(data);
			}
			return response;
		});
		if (stage === "cancel") f.options.onBrowserStart = () => controller.abort();
		if (stage === "status") f.options.onBrowserStart = () => {};
		const before = f.snapshot();
		const error = await changeCoordinatorAccount({ ...f.options, signal: controller.signal }).catch(
			(error: unknown) => error,
		);
		await f.browserDone();
		expect(error).toMatchObject({
			code: stage === "cancel" ? "cancellation_unconfirmed" : "invalid_response",
		});
		expect(f.snapshot()).toEqual(before);
	},
);

test.for(["refresh", "disconnect"] as const)(
	"%s expiry rejection at the first finalization is not replaced by cancellation uncertainty",
	async (intent, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fetch");
		f.fetch.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/finalize")) {
				vi.spyOn(Date, "now").mockReturnValue(f.status.expiresAtMs + 1);
				return Response.json({ error: "account_change_unavailable" }, { status: 403 });
			}
			if (String(url).endsWith("/cancel"))
				return Response.json({ error: "account_change_unavailable" }, { status: 403 });
			return forward(url, init);
		});
		expect(
			await changeCoordinatorAccount(f.options).catch((error: unknown) => error),
		).toMatchObject({ code: "link_stopped" });
		await f.browserDone();
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/finalize"))).toHaveLength(1);
		expect(f.status.state).not.toBe("completed");
	},
);

test.for(
	(["lost reply", "server error", "malformed rejection"] as const).flatMap((mode) =>
		(["refresh", "disconnect"] as const).map((intent) => ({ mode, intent })),
	),
)(
	"$intent preserves uncertainty when $mode precedes a rejected exact finalize retry",
	async ({ mode, intent }, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fetch");
		let finalizes = 0;
		f.fetch.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/cancel"))
				return Response.json({ error: "account_change_unavailable" }, { status: 403 });
			if (!String(url).endsWith("/finalize")) return forward(url, init);
			if (++finalizes > 1)
				return Response.json({ error: "account_change_unavailable" }, { status: 403 });
			await forward(url, init); // A response failure can occur after effects commit.
			if (mode === "lost reply") throw new Error("lost finalize reply");
			if (mode === "server error")
				return Response.json({ error: "account_change_unavailable" }, { status: 500 });
			return Response.json({ error: "account_change_unavailable", extra: true }, { status: 403 });
		});
		expect(
			await changeCoordinatorAccount(f.options).catch((error: unknown) => error),
		).toMatchObject({ code: "cancellation_unconfirmed" });
		await f.browserDone();
		expect(finalizes).toBe(2);
		expect(f.status.state).toBe("completed");
	},
);

test.for(
	(["truncated JSON", "invalid schema", "wrong pins"] as const).flatMap((reply) =>
		(["refresh", "disconnect"] as const).map((intent) => ({ reply, intent })),
	),
)(
	"$intent retries one ambiguous 2xx $reply response with the exact proof and held ACK",
	async ({ reply, intent }, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fetch");
		let finalizes = 0;
		f.fetch.mockImplementation(async (url, init) => {
			const response = await forward(url, init);
			if (!String(url).endsWith("/finalize") || ++finalizes > 1) return response;
			if (reply === "truncated JSON") return new Response('{"status":', { status: 200 });
			if (reply === "invalid schema") return Response.json({ status: [] });
			const body = await response.json();
			body.status.identityId = "other-identity";
			return Response.json(body);
		});
		let settled = false;
		const running = changeCoordinatorAccount(f.options).then((result) => {
			settled = true;
			return result;
		});
		let rejected: unknown;
		void running.catch((error) => {
			rejected = error;
		});
		await vi.waitFor(() => expect(finalizes === 2 || rejected !== undefined).toBe(true), {
			timeout: 3000,
		});
		expect(finalizes).toBe(2);
		await f.browserDone();
		expect(settled).toBe(false);
		expect((await f.receipt()).body).toBe(JSON.stringify({ intent, completed: true }));
		expect(await running).toMatchObject({ intent, state: "completed", identityId: "identity-a" });
		const requests = f.calls.filter((req) => req.url.endsWith("/finalize"));
		expect(await requests[0]?.text()).toBe(await requests[1]?.text());
		expect(requests[0]?.headers.get("x-opencode-nonce")).not.toBe(
			requests[1]?.headers.get("x-opencode-nonce"),
		);
	},
);

test.for(["refresh", "disconnect"] as const)(
	"%s cannot report success when both exact finalize replies have wrong pins",
	async (intent, { f }) => {
		f.options.intent = intent;
		f.status.intent = intent;
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fetch");
		f.fetch.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/cancel"))
				return Response.json({ error: "account_change_unavailable" }, { status: 403 });
			const response = await forward(url, init);
			if (!String(url).endsWith("/finalize")) return response;
			const body = await response.json();
			body.status.identityId = "other-identity";
			return Response.json(body);
		});
		expect(
			await changeCoordinatorAccount(f.options).catch((error: unknown) => error),
		).toMatchObject({ code: "cancellation_unconfirmed" });
		await f.browserDone();
		expect(f.calls.filter((req) => req.url.endsWith("/finalize"))).toHaveLength(2);
	},
);

test.for([1, 2])(
	"lost finalize replies=%i retry exact proof with fresh nonce, never trust GET success",
	async (lost, { f }) => {
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fixture fetch");
		let finals = 0;
		f.fetch.mockImplementation(async (input, init) => {
			const response = await forward(input, init);
			const req = new Request(input, init);
			if (req.url.endsWith("/finalize") && ++finals <= lost) throw new Error("private lost proof");
			if (req.url.endsWith("/cancel"))
				return Response.json({ status: { ...f.status, state: "completed" } });
			return response;
		});
		const running = changeCoordinatorAccount(f.options).catch((error: unknown) => error);
		if (lost === 1) {
			await vi.waitFor(() => expect(finals).toBe(2), { timeout: 5000 });
			await f.browserDone();
			expect((await f.receipt()).body).toBe(JSON.stringify({ intent: "refresh", completed: true }));
		}
		const result = await running;
		if (lost === 1) expect(result).toMatchObject({ state: "completed" });
		else expect(result).toMatchObject({ code: "cancellation_unconfirmed" });
		const requests = f.calls.filter((req) => req.url.endsWith("/finalize"));
		expect(requests).toHaveLength(2);
		expect(await requests[0]?.text()).toBe(await requests[1]?.text());
		expect(requests[0]?.headers.get("x-opencode-nonce")).not.toBe(
			requests[1]?.headers.get("x-opencode-nonce"),
		);
		expect(String(result)).not.toContain("private lost proof");
	},
);

test("context change before finalization cancels without local overwrite", async ({ f }) => {
	const before = f.snapshot();
	let checks = 0;
	const error = await changeCoordinatorAccount({
		...f.options,
		assertCurrentContext: () => ++checks < 4,
	}).catch((error: unknown) => error);
	await f.browserDone();
	expect(error).toMatchObject({ code: "context_changed" });
	expect(f.calls.some((req) => req.url.endsWith("/finalize"))).toBe(false);
	const cancel = await f.calls.find((req) => req.url.endsWith("/cancel"))?.json();
	expect(cancel).toEqual({
		group_id: "group-a",
		identity_id: "identity-a",
		runtime_verifier_hash: f.create.runtime_verifier_hash,
	});
	expect(f.snapshot()).toEqual(before);
});

test("completed status without an own final POST cannot signal browser success", async ({ f }) => {
	const controller = new AbortController();
	const forward = f.fetch.getMockImplementation();
	if (!forward) throw new Error("missing fixture fetch");
	f.fetch.mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		if (req.method === "GET") {
			await f.browserDone();
			f.status.state = "completed";
			expect((await f.receipt()).body).toBe(
				JSON.stringify({ intent: "refresh", completed: false }),
			);
			controller.abort();
		}
		return forward(input, init);
	});
	expect(
		await changeCoordinatorAccount({ ...f.options, signal: controller.signal }).catch(
			(error: unknown) => error,
		),
	).toBeInstanceOf(Error);
	expect(f.calls.some((req) => req.url.endsWith("/finalize"))).toBe(false);
});

test("malformed completion never reaches final POST", async ({ f }) => {
	const controller = new AbortController();
	f.options.onBrowserStart = () => {
		void localGet(
			`${f.create.loopback_redirect}?attempt_id=${f.status.attemptId}&completion=bad`,
		).then((reply) => {
			expect(reply.status).toBe(400);
			controller.abort();
		});
	};
	expect(
		await changeCoordinatorAccount({ ...f.options, signal: controller.signal }).catch(
			(error: unknown) => error,
		),
	).toBeInstanceOf(Error);
	expect(f.calls.some((req) => req.url.endsWith("/finalize"))).toBe(false);
});

test.for([
	{ stage: "finalize", field: "state", value: "committing" },
	{ stage: "finalize", field: "expiresAtMs", value: 1 },
	{ stage: "finalize", field: "attemptId", value: "other-attempt" },
	{ stage: "cancel", field: "expiresAtMs", value: 1 },
	{ stage: "cancel", field: "state", value: "completed" },
])(
	"rejects $stage $field mismatch without claiming completion",
	async ({ stage, field, value }, { f }) => {
		const controller = new AbortController();
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fixture fetch");
		f.fetch.mockImplementation(async (input, init) => {
			const response = await forward(input, init);
			if (!String(input).endsWith(`/${stage}`)) return response;
			const data = await response.json();
			data.status[field] = value;
			return Response.json(data);
		});
		if (stage === "cancel") f.options.onBrowserStart = () => controller.abort();
		const error = await changeCoordinatorAccount({ ...f.options, signal: controller.signal }).catch(
			(error: unknown) => error,
		);
		await f.browserDone();
		expect(error).toMatchObject({
			code: stage === "cancel" ? "cancellation_unconfirmed" : "invalid_response",
		});
	},
);

test("change options never read a caller authority hint", async ({ f }) => {
	const controller = new AbortController();
	const options = {
		...f.options,
		signal: controller.signal,
		onBrowserStart: () => controller.abort(),
	};
	const authority = vi.fn(() => {
		throw new Error("authority must not be read");
	});
	Object.defineProperty(options, "expectedAuthority", { get: authority });
	expect(await changeCoordinatorAccount(options).catch((error: unknown) => error)).toMatchObject({
		code: "link_stopped",
	});
	expect(authority).not.toHaveBeenCalled();
});

test.for(["failed", "expired", "cancelled"])(
	"validated browser terminal %s stays stopped without another cancel POST",
	async (state, { f }) => {
		f.options.onBrowserStart = () => {
			f.status.state = state;
		};
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fixture fetch");
		f.fetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/cancel")) return new Response(null, { status: 403 });
			return forward(input, init);
		});
		expect(
			await changeCoordinatorAccount(f.options).catch((error: unknown) => error),
		).toMatchObject({ code: "link_stopped" });
		expect(f.fetch.mock.calls.some(([input]) => String(input).endsWith("/cancel"))).toBe(false);
		expect(f.calls.some((req) => req.url.endsWith("/finalize"))).toBe(false);
	},
);

test.for(["transport", "local deadline"])(
	"unknown outcome after %s still attempts cancellation and reports uncertainty",
	async (stop, { f }) => {
		f.options.onBrowserStart = () => {};
		const forward = f.fetch.getMockImplementation();
		if (!forward) throw new Error("missing fixture fetch");
		f.fetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/cancel")) return new Response(null, { status: 403 });
			if (init?.method === "GET" && stop === "transport")
				throw new Error("private transport cause");
			const response = await forward(input, init);
			if (init?.method === "GET") vi.spyOn(Date, "now").mockReturnValue(f.status.expiresAtMs + 1);
			return response;
		});
		const error = await changeCoordinatorAccount(f.options).catch((error: unknown) => error);
		expect(error).toMatchObject({ code: "cancellation_unconfirmed" });
		expect(String(error)).not.toContain("private transport cause");
		expect(f.fetch.mock.calls.filter(([input]) => String(input).endsWith("/cancel"))).toHaveLength(
			1,
		);
	},
);
