import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import {
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
	coordinatorImportInviteAction,
} from "./coordinator-actions.js";
import { decodeInvitePayload, encodeInvitePayload } from "./coordinator-invites.js";
import { connect } from "./db.js";
import { coordinatorReviewInviteAction } from "./index.js";
import { initDatabase } from "./maintenance.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";
import { requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity } from "./sync-identity.js";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return origin(server);
}
function origin(server: Server): string {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing loopback address");
	return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

// Disposable SQLite coordinator + owned loopback origins replace all external services.
let directory: string;
let servers: Server[];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-invite-wire-"));
	servers = [];
	for (const [name, value] of Object.entries({
		HOME: directory,
		XDG_CONFIG_HOME: directory,
		CODEMEM_DB: join(directory, "profile.sqlite"),
		CODEMEM_CONFIG: join(directory, "config.json"),
		CODEMEM_KEYS_DIR: join(directory, "keys"),
	}))
		vi.stubEnv(name, value);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(servers.map(close));
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
	const dbPath = join(directory, "profile.sqlite");
	const coordinatorDb = join(directory, "coordinator.sqlite");
	const keysDir = join(directory, "keys");
	initDatabase(dbPath);
	const db = connect(dbPath);
	try {
		ensureDeviceIdentity(db, { keysDir });
	} finally {
		db.close();
	}
	const mounted = createBetterSqliteCoordinatorApp({
		dbPath: coordinatorDb,
		runtime: { adminSecret: () => null, now: () => "2026-10-21T00:00:00Z" },
	});
	const received: string[] = [];
	const sinks: string[] = [];
	const sink = createServer((req, res) => {
		sinks.push(req.url ?? "");
		req.resume();
		res.setHeader("Content-Type", "application/json");
		res.end('{"ok":true}');
	});
	servers.push(sink);
	const sinkUrl = await listen(sink);
	let redirectPath = "";
	let redirectStatus = 307;
	let destination = `${sinkUrl}/sink`;
	let fallback = false;
	const handler = async (request: Request) => {
		const path = new URL(request.url).pathname;
		if (path === "/sink") {
			sinks.push(path);
			return Response.json({ ok: true });
		}
		received.push(path);
		if (path === redirectPath) {
			if (fallback) {
				fallback = false;
				return Response.json({ error: "unexpected_recipient_invite_fields" }, { status: 400 });
			}
			return new Response(null, { status: redirectStatus, headers: { Location: destination } });
		}
		return mounted.fetch(request);
	};
	const source = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const request = new Request(`${origin(source)}${req.url}`, {
				method: req.method,
				headers: req.headers as Record<string, string>,
				body: chunks.length ? Buffer.concat(chunks) : undefined,
			});
			const response = await handler(request);
			res.writeHead(response.status, Object.fromEntries(response.headers));
			res.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			res.writeHead(500);
			res.end();
		}
	});
	servers.push(source);
	const url = await listen(source);
	await coordinatorCreateGroupAction({ groupId: "group-a", dbPath: coordinatorDb });
	const reviewedIntent = {
		version: 1 as const,
		journey: "add_device" as const,
		targetIdentity: { identityId: "identity-existing", displayName: "Existing Person" },
		projects: [],
		excludedProjects: [],
	};
	const created = await coordinatorCreateInviteAction({
		groupId: "group-a",
		coordinatorUrl: url,
		policy: "auto_admit",
		ttlHours: 24,
		dbPath: coordinatorDb,
		inviteKind: "add_device",
		targetIdentityId: "identity-existing",
		reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
		reviewedIntent,
	});
	const options = {
		inviteValue: String(created.encoded),
		dbPath,
		keysDir,
		configPath: join(directory, "config.json"),
		deviceDisplayName: "New laptop",
	};
	return {
		options,
		received,
		sinks,
		url,
		redirect(path: string, status: number, sameOrigin: boolean, legacyFallback = false) {
			redirectPath = path;
			redirectStatus = status;
			destination = sameOrigin ? "/sink" : `${sinkUrl}/sink`;
			fallback = legacyFallback;
		},
	};
}

it.each(
	[307, 308].flatMap((status) =>
		[false, true].flatMap((sameOrigin) =>
			["inspect", "join", "fallback"].map((stage) => ({ status, sameOrigin, stage })),
		),
	),
)(
	"rejects $status redirects at $stage (same origin=$sameOrigin)",
	async ({ status, sameOrigin, stage }) => {
		// Arrange: obtain a valid digest from the actual SQLite inspection first.
		const f = await fixture();
		const review = await coordinatorReviewInviteAction(f.options);
		f.received.length = 0;
		f.redirect(
			stage === "inspect" ? "/v1/invites/inspect" : "/v1/join",
			status,
			sameOrigin,
			stage === "fallback",
		);
		// Act: real fetch must reject before replaying the token-bearing body.
		const failure = await coordinatorImportInviteAction({
			...f.options,
			reviewedOnboardingDigest: review.reviewed_onboarding_digest,
		}).catch((error: unknown) => error);
		// Assert
		expect(failure).toBeInstanceOf(Error);
		expect(f.sinks).toEqual([]);
		expect(f.received).toEqual(
			stage === "inspect"
				? ["/v1/invites/inspect"]
				: ["/v1/invites/inspect", "/v1/join", ...(stage === "fallback" ? ["/v1/join"] : [])],
		);
	},
);

it.each([307, 308])("review also rejects a %s inspection redirect", async (status) => {
	// Arrange
	const f = await fixture();
	f.redirect("/v1/invites/inspect", status, false);
	// Act
	const failure = await coordinatorReviewInviteAction(f.options).catch((error: unknown) => error);
	// Assert
	expect(failure).toBeInstanceOf(Error);
	expect(f.sinks).toEqual([]);
	expect(f.received).toEqual(["/v1/invites/inspect"]);
});

it("accepts normal inspection and join responses through real HTTP", async () => {
	// Arrange
	const f = await fixture();
	const review = await coordinatorReviewInviteAction(f.options);
	// Act
	const accepted = await coordinatorImportInviteAction({
		...f.options,
		reviewedOnboardingDigest: review.reviewed_onboarding_digest,
	});
	// Assert
	expect(accepted).toMatchObject({ status: "accepted", identity_id: "identity-existing" });
	expect(f.received).toEqual(["/v1/invites/inspect", "/v1/invites/inspect", "/v1/join"]);
	expect(f.sinks).toEqual([]);
});

it("keeps ordinary peer redirects following by default", async () => {
	// Arrange
	const f = await fixture();
	f.redirect("/peer", 307, false);
	// Act
	const result = await requestJson("POST", `${f.url}/peer`, {
		body: { message: "synthetic peer data" },
	});
	// Assert
	expect(result).toEqual([200, { ok: true }]);
	expect(f.sinks).toEqual(["/sink"]);
});

it.each(
	["review", "import"].flatMap((action) =>
		[
			{
				name: "TimeoutError",
				message:
					"Invite import timed out contacting the coordinator. Check network access and try again.",
			},
			{
				name: "TypeError",
				message:
					"Invite import could not reach the coordinator. Check network access and use the original coordinator URL; redirects are not accepted.",
			},
		].map((failure) => ({ action, ...failure })),
	),
)("$action sanitizes inspection $name without joining or changing config", async (testCase) => {
	// Arrange: SDK import must pass digest validation before exercising failed inspection.
	const f = await fixture();
	const config = '{"custom_setting":"preserve"}\n';
	writeFileSync(f.options.configPath, config);
	const review = await coordinatorReviewInviteAction(f.options);
	f.received.length = 0;
	const secret = "synthetic-private-token";
	const transportError = new Error(`https://private.invalid/${secret}`, {
		cause: new Error(`private cause ${secret}`),
	});
	transportError.name = testCase.name;
	const fetch = vi.fn().mockRejectedValue(transportError);
	vi.stubGlobal("fetch", fetch);
	// Act
	const action =
		testCase.action === "review" ? coordinatorReviewInviteAction : coordinatorImportInviteAction;
	const failure = await action({
		...f.options,
		reviewedOnboardingDigest: review.reviewed_onboarding_digest,
	}).catch((error: unknown) => error);
	// Assert: report an actionable category, never the original URL, token, or cause.
	expect(failure).toBeInstanceOf(Error);
	expect(failure).toMatchObject({ message: testCase.message });
	expect((failure as Error).cause).toBeUndefined();
	expect(String(failure)).not.toContain(secret);
	expect(String(failure)).not.toContain("private.invalid");
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0]?.[0]).toBe(`${f.url}/v1/invites/inspect`);
	expect(f.received).toEqual([]);
	expect(readFileSync(f.options.configPath, "utf8")).toBe(config);
});

it.each([
	{ label: "no trailing slash", suffix: "", trailing: "" },
	{ label: "long trailing run", suffix: "", trailing: "/".repeat(10_000) },
	{ label: "long interior run ending in x", suffix: `${"/".repeat(10_000)}x`, trailing: "///" },
])("review removes only trailing slashes: $label", async ({ suffix, trailing }) => {
	// Arrange: reuse valid inspection data but mock transport for arbitrary URL path shapes.
	const f = await fixture();
	const payload = decodeInvitePayload(f.options.inviteValue);
	const [, inspection] = await requestJson("POST", `${f.url}/v1/invites/inspect`, {
		body: { token: payload.token },
	});
	const normalized = `${f.url}${suffix}`;
	writeFileSync(
		f.options.configPath,
		JSON.stringify({ sync_coordinator_url: `${normalized}////` }),
	);
	const fetch = vi.fn().mockResolvedValue(Response.json(inspection));
	vi.stubGlobal("fetch", fetch);
	// Act
	const review = await coordinatorReviewInviteAction({
		...f.options,
		inviteValue: encodeInvitePayload({ ...payload, coordinator_url: `${normalized}${trailing}` }),
	});
	// Assert: matching config is accepted and interior slashes survive the request unchanged.
	expect(review.status).toBe("review");
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0]?.[0]).toBe(`${normalized}/v1/invites/inspect`);
});

it("review rejects coordinator differences before inspection despite matching slash runs", async () => {
	// Arrange
	const f = await fixture();
	const payload = decodeInvitePayload(f.options.inviteValue);
	const interior = "/".repeat(10_000);
	writeFileSync(
		f.options.configPath,
		JSON.stringify({ sync_coordinator_url: `${f.url}${interior}x///` }),
	);
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	// Act
	const result = coordinatorReviewInviteAction({
		...f.options,
		inviteValue: encodeInvitePayload({ ...payload, coordinator_url: `${f.url}${interior}y///` }),
	});
	// Assert
	await expect(result).rejects.toThrow("invite_coordinator_conflict");
	expect(fetch).not.toHaveBeenCalled();
});
