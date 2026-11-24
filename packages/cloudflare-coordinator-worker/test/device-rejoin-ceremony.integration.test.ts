import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "../../core/src/coordinator-auth-proof.js";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf.js";
import {
	type DeviceRejoinProof,
	deviceRejoinProofMessage,
} from "../../core/src/coordinator-device-rejoin-proof.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { createCloudflareCoordinatorWorker } from "../src/index.js";
import {
	config,
	confirmInBrowser,
	createRejoinOidc,
	deviceId,
	generateDeviceKey,
	groupId,
	now,
	origin,
	seedRemovedDevice,
} from "./device-rejoin-ceremony-fixture.js";

const root = "/v1/auth/rejoin-attempts";
const attemptId = "ceremony-attempt";
const loopbackRedirect = "http://127.0.0.1:1234/codemem/auth/complete";

afterEach(() => vi.restoreAllMocks());

async function coordinator() {
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
	const db = env.COORDINATOR_DB;
	await applyD1Migrations(db, env.TEST_MIGRATIONS);
	const key = generateDeviceKey();
	const keyId = await seedRemovedDevice(
		{
			first: <T>({ sql, values }: AuthLinkStatement) => db.prepare(sql).bind(...values).first<T>(),
			run: (sql, ...values) => db.prepare(sql).bind(...values).run(),
		},
		key,
	);
	const oidc = createRejoinOidc();
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(7));
	const worker = createCloudflareCoordinatorWorker({
		now: () => new Date(now).toISOString(),
		browserAuth: { config, csrfKey, oidcOptions: { fetch: oidc.fetch } },
	});
	const request = (path: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		headers.set("CF-Connecting-IP", "203.0.113.15");
		return worker.fetch(new Request(new URL(path, origin), { ...init, headers }), env);
	};
	const signature = (proof: DeviceRejoinProof) =>
		sign(null, Buffer.from(deviceRejoinProofMessage(proof)), key.privateKey).toString("base64url");
	return {
		db,
		clock,
		key,
		network,
		oidc,
		request,
		signature,
		subject: { origin, deviceId, keyId, attemptId },
	};
}

type Fixture = Awaited<ReturnType<typeof coordinator>>;

function post(f: Fixture, path: string, body: Record<string, string | number>) {
	return f.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function ordinaryCheck(f: Fixture) {
	const path = `/v1/peers/revocations?group_id=${groupId}`;
	const body = JSON.stringify({ peers: [] });
	const timestamp = String(Math.floor(now / 1000));
	const nonce = crypto.randomUUID();
	const canonical = buildCanonicalRequest("POST", path, timestamp, nonce, Buffer.from(body));
	const signature = sign(null, canonical, f.key.privateKey).toString("base64");
	return f.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-opencode-device": deviceId,
			"x-opencode-nonce": nonce,
			"x-opencode-signature": `${SIGNATURE_VERSION}:${signature}`,
			"x-opencode-timestamp": timestamp,
		},
		body,
	});
}

async function begin(f: Fixture) {
	const browserStart = new Uint8Array(32).fill(15);
	const browserStartHash = await hashCoordinatorAuthProofBytes32(browserStart);
	const response = await post(f, root, {
		device_id: deviceId,
		public_key: f.key.publicKey,
		attempt_id: attemptId,
		browser_start_hash: browserStartHash,
		loopback_redirect: loopbackRedirect,
		timestamp_ms: now,
		signature: f.signature({
			...f.subject,
			operation: "start",
			publicKey: f.key.publicKey,
			browserStartHash,
			loopbackRedirect,
			timestampMs: now,
		}),
	});
	expect(response.status).toBe(200);
	const pins = await response.json<{
		binding_id: string;
		identity_id: string;
		removal_digest: string;
		expires_at_ms: number;
	}>();
	const link = new URL("/auth/rejoin/start", origin);
	link.searchParams.set("attempt_id", attemptId);
	link.searchParams.set("start_code", encodeCoordinatorAuthProof32(browserStart));
	return { link, pins };
}

function poll(f: Fixture, timestampMs: number) {
	return post(f, `${root}/${attemptId}/status`, {
		device_id: deviceId,
		timestamp_ms: timestampMs,
		signature: f.signature({ ...f.subject, operation: "status", timestampMs }),
	});
}

async function finalizeBody(f: Fixture, ceremony: Awaited<ReturnType<typeof begin>>) {
	const { link, pins } = ceremony;
	const returned = await confirmInBrowser(f, link.href);
	expect(`${returned.origin}${returned.pathname}`).toBe(loopbackRedirect);
	const completion = returned.searchParams.get("completion") ?? "";
	return {
		device_id: deviceId,
		completion,
		signature: f.signature({
			...f.subject,
			operation: "finalize",
			coordinatorId: config.coordinatorId,
			authConfigRevision: config.revision,
			issuer: config.issuer,
			identityId: pins.identity_id,
			bindingId: pins.binding_id,
			removalDigest: pins.removal_digest,
			publicKey: f.key.publicKey,
			fingerprint: f.key.fingerprint,
			confirmation: returned.searchParams.get("confirmation") ?? "",
			completion,
		}),
	};
}

async function effects(f: Fixture) {
	const statements = [
		"coordinator_device_rejoin_attempts",
		"coordinator_device_rejoin_audit_log",
		"coordinator_device_removals",
		"enrolled_devices",
		"request_nonces",
	].map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`));
	return (await f.db.batch(statements)).map(({ results }) => results);
}

it("rejoins through the registered Worker routes on native D1 and restores signed sync admission", async () => {
	const f = await coordinator();
	const denied = await ordinaryCheck(f);
	expect(denied.status).toBe(403);
	expect(await denied.json()).toEqual({ error: "device_removed" });

	const ceremony = await begin(f);
	const deadline = ceremony.pins.expires_at_ms;
	expect(deadline).toBe(now + 600_000);
	const pending = await poll(f, now);
	expect(pending.status).toBe(200);
	expect(await pending.json()).toEqual({ state: "pending", expires_at_ms: deadline });
	const finalize = await finalizeBody(f, ceremony);
	const confirmed = await poll(f, now);
	expect(confirmed.status).toBe(200);
	expect(await confirmed.json()).toMatchObject({
		state: "confirmed",
		confirmation_view: { destinations: [[groupId, null]], non_destinations: [] },
	});
	const finalizePath = `${root}/${attemptId}/finalize`;
	const result = await post(f, finalizePath, finalize);
	expect(result.status).toBe(200);
	const committed = await result.json<{ state: string; receipt: object }>();
	expect(committed).toMatchObject({
		state: "finalized",
		receipt: { attempt_id: attemptId, device_id: deviceId, group_ids: [groupId] },
	});
	const before = await effects(f);
	const live = await poll(f, now);
	expect(live.status).toBe(200);
	expect(await live.json()).toMatchObject({ state: "finalized", receipt: committed.receipt });
	const admitted = await ordinaryCheck(f);
	expect(admitted.status).toBe(200);
	expect(await admitted.json()).toMatchObject({ version: 1, removed: [] });
	await expectLateRecovery(f, deadline, finalizePath, finalize, committed.receipt);
	expect((await effects(f)).slice(0, -1)).toEqual(before.slice(0, -1));
	expect(
		await f.db.prepare("SELECT count(*) AS count FROM coordinator_device_rejoin_audit_log").first(),
	).toEqual({ count: 1 });
	expect(f.network).not.toHaveBeenCalled();
});

async function expectLateRecovery(
	f: Fixture,
	deadline: number,
	finalizePath: string,
	finalize: Record<string, string | number>,
	receipt: object,
) {
	const before = await effects(f);
	f.clock.mockReturnValue(deadline);
	const late = await poll(f, deadline);
	expect(late.status).toBe(403);
	expect(await late.json()).toEqual({ error: "device_rejoin_unavailable" });
	const retry = await post(f, finalizePath, finalize);
	expect(retry.status).toBe(200);
	expect(await retry.json()).toEqual({ state: "prior_commit", receipt });
	expect(await effects(f)).toEqual(before);
}
