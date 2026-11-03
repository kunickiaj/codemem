import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "./admission-budget-schema.js";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { registerCoordinatorRelayAdmissionRoute } from "./coordinator-relay-admission-route.js";
import {
	DENIAL,
	d1App,
	routeFixture,
	seedRouteDatabase,
} from "./coordinator-relay-admission-route-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import { readRelayAdmissionReply } from "./relay-admission-reply.js";

type Fixture = Awaited<ReturnType<typeof routeFixture>>;
const fixtures: Fixture[] = [];
const directories: string[] = [];
// Every scenario uses actual eligibility SQL and committed budget writes.
async function setup(
	options: Parameters<typeof routeFixture>[0] = {},
	seed: Parameters<typeof routeFixture>[1] = {},
) {
	const h = await routeFixture(options, seed);
	fixtures.push(h);
	return h;
}
afterEach(() => {
	vi.useRealTimers();
	for (const h of fixtures.splice(0)) h.db.close();
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("relay endpoint fail-closed backend boundaries", () => {
	it.each(["enabled", "disabled"])(
		"runs the concrete D1 wrapper with %s SQLite policy",
		async (state) => {
			// Arrange
			const h = await setup();
			if (state === "disabled")
				h.db.exec(
					"UPDATE relay_admission_authority_policy SET operator_state='disabled',policy_revision=2",
				);
			const app = d1App(h);
			// Act
			const response = await app.request(h.f.request.externalPathname, {
				method: "POST",
				headers: h.headers(),
				body: new Uint8Array(h.f.bodyBytes),
			});
			const wire = new Uint8Array(await response.arrayBuffer());
			// Assert
			expect(response.status).toBe(200);
			if (state === "enabled")
				expect(readRelayAdmissionReply(wire, h.f.request.packet)).not.toBeNull();
			else expect(JSON.parse(new TextDecoder().decode(wire))).toEqual(DENIAL);
			expect(h.nonces()).toHaveLength(state === "enabled" ? 1 : 0);
		},
	);
	it.each([
		["stale readiness", "UPDATE relay_admission_readiness SET observed_at_ms=0,revision=2"],
		[
			"disabled policy",
			"UPDATE relay_admission_authority_policy SET operator_state='disabled',policy_revision=2",
		],
		["missing metadata schema", "DROP TABLE relay_admission_readiness"],
		["missing budget schema", "DROP TABLE admission_budget_buckets"],
		["missing profiles", ""],
		[
			"exhausted ingress",
			"UPDATE admission_budget_allocations SET rate_per_min=0,burst=0 WHERE pool='relay-route' AND group_id<>''",
		],
		[
			"exhausted device",
			"UPDATE admission_budget_allocations SET rate_per_min=0,burst=0 WHERE pool='device'",
		],
	])("denies %s without consuming a protocol nonce", async (_name, sql) => {
		// Arrange
		const h = await setup({}, { omitProfiles: _name === "missing profiles" });
		if (sql) h.db.exec(sql);
		// Act
		const response = await h.request();
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(DENIAL);
		expect(h.nonces()).toEqual([]);
		expect(h.trace).not.toContain("nonce");
		expect(h.close).toHaveBeenCalledOnce();
	});

	it.each(["absent-options", "open", "query", "writer", "close"])(
		"denies missing or throwing %s dependency without leaking details",
		async (fault) => {
			// Arrange
			const h = await setup();
			if (fault === "open")
				h.options.open.mockImplementation(() => {
					throw new Error("private dependency detail");
				});
			if (fault === "query") Reflect.deleteProperty(h.database, "query");
			if (fault === "writer") Reflect.deleteProperty(h.database, "insertReturning");
			if (fault === "close")
				h.close.mockImplementation(() => {
					throw new Error("private close detail");
				});
			const child = new Hono();
			registerCoordinatorRelayAdmissionRoute(
				child,
				fault === "absent-options" ? undefined : h.options,
			);
			const app = new Hono().route("/trusted", child);
			// Act
			const response = await app.request(h.f.request.externalPathname, {
				method: "POST",
				headers: h.headers(),
				body: new Uint8Array(h.f.bodyBytes),
			});
			// Assert: even an error after commit never produces an eligible reply.
			if (fault === "absent-options") {
				expect(response.status).toBe(404);
				expect(h.options.open).not.toHaveBeenCalled();
			} else {
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual(DENIAL);
			}
			expect(h.nonces()).toHaveLength(fault === "close" ? 1 : 0);
		},
	);
});

function betterSqliteApp(h: Fixture, options: { enabled: boolean }) {
	const directory = mkdtempSync(join(tmpdir(), "relay-coordinator-route-"));
	directories.push(directory);
	const dbPath = join(directory, "coordinator.sqlite");
	const store = new BetterSqliteCoordinatorStore(dbPath);
	try {
		for (const sql of [
			...ADMISSION_BUDGET_SCHEMA_STATEMENTS,
			...RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS,
		])
			store.db.exec(sql);
		seedRouteDatabase(store.db, h.f, {});
	} finally {
		store.close();
	}
	// The real factory opens fresh native connections. Freeze only their SQL clock.
	const prepare = Database.prototype.prepare;
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql: string,
	) {
		if (this.name === dbPath)
			sql = sql
				.replaceAll(RELAY_ADMISSION_CLOCK_SQL, "110000")
				.replaceAll("strftime('%Y-%m-%dT%H:%M:%fZ','now')", "'1970-01-01T00:01:50.000Z'");
		return prepare.call(this, sql);
	});
	const child = createBetterSqliteCoordinatorApp({
		dbPath,
		relayAdmission: options.enabled ? h.options : undefined,
	});
	return { app: new Hono().route("/trusted", child), dbPath };
}

describe("concrete Better SQLite coordinator factory", () => {
	it.each([true, false])("keeps relay capability opt-in: enabled=%s", async (enabled) => {
		// Arrange: initialize the real coordinator schema before admission-only fixture data.
		const h = await setup();
		const { app, dbPath } = betterSqliteApp(h, { enabled });
		const request = () =>
			app.request(h.f.request.externalPathname, {
				method: "POST",
				headers: h.headers(),
				body: new Uint8Array(h.f.bodyBytes),
			});
		// Act
		const response = await request();
		const replay = await request();
		// Assert
		expect(response.status).toBe(enabled ? 200 : 404);
		expect(replay.status).toBe(enabled ? 200 : 404);
		if (enabled) {
			expect(
				readRelayAdmissionReply(new Uint8Array(await response.arrayBuffer()), h.f.request.packet),
			).toMatchObject({ decidedAtMs: 110_000, remainingMs: 45_000 });
			expect(await replay.json()).toEqual(DENIAL);
		}
		const persisted = new Database(dbPath, { readonly: true });
		try {
			expect(persisted.prepare("SELECT * FROM request_nonces").all()).toHaveLength(enabled ? 1 : 0);
		} finally {
			persisted.close();
		}
	});
});

describe("relay endpoint uncertain writes", () => {
	it.each(["relay-route", "device"])(
		"denies an exhausted durable %s bucket before nonce insertion",
		async (pool) => {
			// Arrange
			const h = await setup();
			h.db
				.prepare(
					"INSERT INTO admission_budget_buckets(authority_id,pool,audience_id,group_id,device_id,units,refilled_at_ms,last_rate,last_capacity,exec_id,granted) VALUES (?,?,?,?,?,0,110000,0,0,?,0)",
				)
				.run(
					h.f.request.namespace.authorityId,
					pool,
					pool === "relay-route" ? h.f.request.namespace.relayAudienceId : "",
					h.f.request.namespace.groupId,
					pool === "device" ? "source" : "",
					"0".repeat(32),
				);
			// Act
			const response = await h.request();
			// Assert: the fixed SQL clock cannot refill the exhausted bucket.
			expect(await response.json()).toEqual(DENIAL);
			expect(h.trace).toEqual(
				pool === "relay-route"
					? ["budget"]
					: ["budget", "budget", "budget", "query", "query", "budget"],
			);
			expect(h.nonces()).toHaveLength(0);
		},
	);
	it.each(["ingress", "nonce"] as const)(
		"denies uncertain %s commits without retries or readback",
		async (stage) => {
			// Arrange
			const h = await setup();
			const write = h.database.insertReturning.getMockImplementation();
			if (!write) throw new Error("missing fixture writer");
			h.database.insertReturning.mockImplementation(async (sql, values) => {
				const row = await write(sql, values);
				if ((stage === "nonce") === sql.includes("INSERT INTO request_nonces"))
					throw new Error("private acknowledgement lost after commit");
				return row;
			});
			// Act
			const response = await h.request();
			// Assert
			expect(await response.json()).toEqual(DENIAL);
			expect(h.trace).toEqual(
				stage === "ingress"
					? ["budget"]
					: ["budget", "budget", "budget", "query", "query", "budget", "nonce"],
			);
			expect(h.buckets()).toHaveLength(stage === "ingress" ? 1 : 4);
			expect(h.nonces()).toHaveLength(stage === "nonce" ? 1 : 0);
			expect(h.close).toHaveBeenCalledOnce();
		},
	);

	it.each(["envelope", "array", "null"])(
		"denies an unknown %s budget receipt without recovery lookup",
		async (shape) => {
			// Arrange
			const h = await setup();
			const write = h.database.insertReturning.getMockImplementation();
			if (!write) throw new Error("missing fixture writer");
			h.database.insertReturning.mockImplementationOnce(async (sql, values) => {
				const row = await write(sql, values);
				if (shape === "envelope") return { results: [row] };
				if (shape === "array") return [row];
				return null;
			});
			// Act
			const response = await h.request();
			// Assert
			expect(await response.json()).toEqual(DENIAL);
			expect(h.trace).toEqual(["budget"]);
			expect(h.buckets()).toHaveLength(1);
			expect(h.nonces()).toEqual([]);
		},
	);
});

describe("mounted coordinator relay admission HTTP endpoint", () => {
	it.each(["registration", "source", "relay", "responder"] as const)(
		"admits a signed %s once using durable ingress, device and nonce writes",
		async (role) => {
			// Arrange
			const h = await setup({ role });
			// Act
			const response = await h.request();
			const reply = readRelayAdmissionReply(
				new Uint8Array(await response.arrayBuffer()),
				h.f.request.packet,
			);
			const replay = await h.request();
			// Assert: one ingress reservation per HTTP request, with no second reservation inside the decision.
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/json");
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(reply).toMatchObject({
				decidedAtMs: 110_000,
				remainingMs: role === "registration" ? 900_000 : 45_000,
			});
			expect(await replay.json()).toEqual(DENIAL);
			expect(h.nonces()).toHaveLength(1);
			const deviceStages = role === "registration" ? ["budget", "budget"] : ["budget"];
			expect(h.trace).toEqual(
				Array.from({ length: 2 }, () => [
					"budget",
					"budget",
					"budget",
					"query",
					"query",
					...deviceStages,
					"nonce",
				]).flat(),
			);
			expect(h.buckets()).toHaveLength(role === "registration" ? 5 : 4);
			expect(h.close).toHaveBeenCalledTimes(2);
			expect(h.storeFactory).not.toHaveBeenCalled();
		},
	);

	it.each([
		"raw-body",
		"device",
		"timestamp",
		"nonce",
		"signature",
		"query",
		"wrong-path-signature",
	])("denies changed %s after ingress but before device or nonce writes", async (change) => {
		// Arrange
		const h = await setup();
		const headers = h.headers();
		const names: Record<string, string> = {
			device: "Device",
			timestamp: "Timestamp",
			nonce: "Nonce",
			signature: "Signature",
		};
		if (names[change]) headers.set(`X-Opencode-${names[change]}`, "invalid");
		const body =
			change === "raw-body"
				? `${new TextDecoder().decode(h.f.bodyBytes)} `
				: new Uint8Array(h.f.bodyBytes);
		// Act
		const response =
			change === "wrong-path-signature"
				? await h
						.mount("/other/v1/relay/admission-check", "/other")
						.request("/other/v1/relay/admission-check", {
							method: "POST",
							headers,
							body,
						})
				: await h.request(
						{ headers, body },
						`${h.f.request.externalPathname}${change === "query" ? "?ignored=1" : ""}`,
					);
		// Assert
		expect(await response.json()).toEqual(DENIAL);
		expect(h.nonces()).toEqual([]);
		expect(h.buckets()).toHaveLength(3);
		expect(h.trace).not.toContain("nonce");
		expect(h.close).toHaveBeenCalledOnce();
	});

	it("denies when the configured signed pathname omits the mount prefix", async () => {
		// Arrange
		const h = await setup();
		const app = h.mount("/v1/relay/admission-check");
		// Act
		const response = await app.request(h.f.request.externalPathname, {
			method: "POST",
			headers: h.headers(),
			body: new Uint8Array(h.f.bodyBytes),
		});
		// Assert
		expect(await response.json()).toEqual(DENIAL);
		expect(h.trace).toEqual(["budget", "budget", "budget"]);
		expect(h.nonces()).toEqual([]);
	});
});

describe("relay endpoint body limits and malformed input", () => {
	it.each(["deadline", "abort", "oversize"])(
		"finishes %s denial even when stream cancellation never settles",
		async (stop) => {
			// Arrange
			const h = await setup();
			vi.useFakeTimers();
			const controller = new AbortController();
			const cancel = vi.fn(() => new Promise<void>(() => {}));
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					if (stop === "oversize") c.enqueue(new Uint8Array(1025));
				},
				cancel,
			});
			const request = new Request(`http://localhost${h.f.request.externalPathname}`, {
				method: "POST",
				body: stream,
				signal: controller.signal,
				duplex: "half",
			} as RequestInit);
			// Act
			const pending = h.app.request(request);
			if (stop === "abort") controller.abort();
			if (stop === "deadline") await vi.advanceTimersByTimeAsync(3000);
			const response = await pending;
			// Assert: timeouts and aborts use the uniform denial and ingress charge.
			expect(response.status).toBe(stop === "oversize" ? 413 : 200);
			expect(await response.json()).toEqual(DENIAL);
			expect(cancel).toHaveBeenCalledOnce();
			expect(h.trace).toEqual(["budget", "budget", "budget"]);
			expect(h.nonces()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it.each(["empty", "json", "utf8", "missing-header"])(
		"charges malformed %s ingress before eligibility lookup",
		async (fault) => {
			// Arrange
			const h = await setup();
			const headers = h.headers();
			if (fault === "missing-header") headers.delete("X-Opencode-Signature");
			const bodies: Record<string, BodyInit> = {
				empty: "",
				json: "{}",
				utf8: new Uint8Array([255]),
			};
			// Act
			const response = await h.request({
				headers,
				body: bodies[fault] ?? new Uint8Array(h.f.bodyBytes),
			});
			// Assert
			expect(await response.json()).toEqual(DENIAL);
			expect(h.trace).toEqual(["budget", "budget", "budget"]);
			expect(h.buckets()).toHaveLength(3);
			expect(h.nonces()).toEqual([]);
		},
	);

	it.each(["declared", "streamed"])(
		"cancels a %s oversized body and charges ingress only",
		async (size) => {
			// Arrange
			const h = await setup();
			const cancel = vi.fn();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(1025));
				},
				cancel,
			});
			const headers = h.headers();
			if (size === "declared") headers.set("Content-Length", "1025");
			const request = new Request(`http://localhost${h.f.request.externalPathname}`, {
				method: "POST",
				body: stream,
				headers,
				duplex: "half",
			} as RequestInit);
			// Act
			const response = await h.app.request(request);
			// Assert
			expect(response.status).toBe(413);
			expect(await response.json()).toEqual(DENIAL);
			expect(cancel).toHaveBeenCalledOnce();
			expect(h.trace).toEqual(["budget", "budget", "budget"]);
			expect(h.nonces()).toEqual([]);
		},
	);

	it("reads exactly 1024 bytes without treating the limit as oversize", async () => {
		// Arrange
		const h = await setup();
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(512));
				c.enqueue(new Uint8Array(512));
				c.close();
			},
			cancel,
		});
		// Act
		const response = await h.app.request(
			new Request(`http://localhost${h.f.request.externalPathname}`, {
				method: "POST",
				body: stream,
				duplex: "half",
			} as RequestInit),
		);
		// Assert: the body is invalid, but within the transport limit.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(DENIAL);
		expect(cancel).not.toHaveBeenCalled();
		expect(h.trace).toEqual(["budget", "budget", "budget"]);
	});
});
