import type { KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, vi } from "vitest";
import {
	type HeadlessLinkApproval,
	type HeadlessLinkCode,
	linkCoordinatorAccountHeadless,
} from "./coordinator-account-link-headless-runtime.js";
import { CoordinatorAccountLinkError } from "./coordinator-account-link-runtime.js";
import { NOW } from "./coordinator-device-headless-link-test-fixtures.js";
import { initTestSchema } from "./test-utils.js";

/** A local database and keys directory holding one device key, as `codemem sync` leaves them. */
export function createLocalDevice(key: {
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	privateKey: KeyObject;
}) {
	const dir = mkdtempSync(join(tmpdir(), "codemem-headless-link-test-"));
	const dbPath = join(dir, "local.sqlite");
	const keysDir = join(dir, "keys");
	mkdirSync(keysDir);
	const db = new Database(dbPath);
	try {
		initTestSchema(db);
		db.prepare(
			"INSERT INTO sync_device (device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		).run(key.deviceId, key.publicKey, key.fingerprint, new Date(0).toISOString());
	} finally {
		db.close();
	}
	writeFileSync(
		join(keysDir, "device.key"),
		key.privateKey.export({ type: "pkcs8", format: "pem" }),
		{ mode: 0o600 },
	);
	writeFileSync(join(keysDir, "device.key.pub"), key.publicKey);
	return { dbPath, keysDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const ORIGIN = "https://coordinator.example.test";
export const EXPIRES = NOW + 600_000;
export const APPROVAL = {
	issuer: "https://accounts.google.com",
	subject: "subject-from-status",
	email: "ada@example.test",
	email_verified: true,
	display_name: "Ada Example",
};

export type Route = "create" | "status" | "finalize" | "cancel";
export type Reply = (
	body: Record<string, unknown>,
	attemptId: string,
) => Response | Promise<Response>;

export const json = (
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
export const statusOf = (attemptId: string, state: string) => ({
	attemptId,
	state,
	expiresAtMs: EXPIRES,
});
export const created: Reply = (body) =>
	json(
		{
			status: statusOf(String(body.attempt_id), "pending"),
			identity_id: "identity-a",
			authority: "controller_attestation",
			coordinator_id: "coordinator-a",
			verification_uri: `${ORIGIN}/auth/link/device`,
			poll_interval_s: 5,
		},
		201,
	);
export const polled =
	(state: string, approval: unknown = null): Reply =>
	(_body, attemptId) =>
		json({ status: statusOf(attemptId, state), poll_interval_s: 5, approval });
export const finalized: Reply = (_body, attemptId) =>
	json({ status: statusOf(attemptId, "finalized") });
export const cancelled: Reply = (_body, attemptId) =>
	json({ status: statusOf(attemptId, "failed") });

/** A scripted coordinator: each route replays its queue and repeats the last reply. */
export function fakeCoordinator(script: Partial<Record<Route, Reply[]>>) {
	const calls: { route: Route; body: Record<string, unknown>; attemptId: string }[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		expect(init?.redirect).toBe("manual");
		const request = new Request(input, init);
		const url = new URL(request.url);
		const match = url.pathname.match(
			/^\/v1\/auth\/(?:headless-link-attempts|link-attempts)(?:\/([^/]+))?(?:\/(finalize|cancel))?$/,
		);
		if (!match) throw new Error(`unexpected ${url.pathname}`);
		let route: Route = request.method === "GET" ? "status" : "create";
		if (match[2]) route = match[2] as Route;
		const text = await request.text();
		const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		const attemptId = match[1] ?? String(body.attempt_id);
		calls.push({ route, body, attemptId });
		const queue = script[route] ?? [];
		const reply = queue.length > 1 ? queue.shift() : queue[0];
		if (!reply) throw new Error(`no ${route} reply`);
		return reply(body, attemptId);
	});
	return { fetch, calls, routes: () => calls.map((call) => call.route) };
}

export function runHeadless(
	local: { dbPath: string; keysDir: string },
	coordinator: ReturnType<typeof fakeCoordinator>,
	overrides: {
		approve?: (approval: HeadlessLinkApproval) => Promise<boolean>;
		signal?: AbortSignal;
		onState?: (state: string) => void;
		coordinatorUrl?: string;
	} = {},
) {
	const codes: HeadlessLinkCode[] = [];
	const states: string[] = [];
	const approvals: HeadlessLinkApproval[] = [];
	const result = linkCoordinatorAccountHeadless({
		dbPath: local.dbPath,
		keysDir: local.keysDir,
		groupId: "group-a",
		coordinatorUrl: overrides.coordinatorUrl ?? ORIGIN,
		expectedIdentityId: "identity-a",
		expectedAuthority: "controller_attestation",
		expectedCoordinatorId: "coordinator-a",
		fetch: coordinator.fetch,
		signal: overrides.signal,
		onCode: (code) => codes.push(code),
		onState: (state) => {
			states.push(state);
			overrides.onState?.(state);
		},
		approve: async (approval) => {
			approvals.push(approval);
			return (overrides.approve ?? (async () => true))(approval);
		},
	});
	return { result, codes, states, approvals };
}
export const errorCode = (promise: Promise<unknown>) =>
	promise.then(
		() => "resolved",
		(error) => (error instanceof CoordinatorAccountLinkError ? error.code : String(error)),
	);
