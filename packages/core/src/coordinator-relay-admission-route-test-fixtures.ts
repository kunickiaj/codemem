import Database from "better-sqlite3";
import { Hono } from "hono";
import { type Mock, vi } from "vitest";
import { ALLOCATION } from "./admission-budget-allocation-schema-test-fixtures.js";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "./admission-budget-schema.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import {
	type CoordinatorRelayAdmissionRuntimeOptions,
	registerCoordinatorRelayAdmissionRoute,
} from "./coordinator-relay-admission-route.js";
import { createD1CoordinatorApp } from "./d1-coordinator-runtime.js";
import type { D1DatabaseLike } from "./d1-coordinator-store.js";
import { decisionFixture, decisionSeed } from "./relay-admission-decision-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import { PARTICIPANT_TEST_SCHEMA_SQL } from "./relay-admission-participant-nonce-test-fixtures.js";

type Bindings = readonly (string | number | null)[];
const bind = (values: Bindings) =>
	Object.fromEntries(values.map((value, index) => [index + 1, value]));
export const DENIAL = { v: 1, eligible: false };
type RouteDatabase = {
	query: Mock<(sql: string, values: Bindings) => Promise<unknown>>;
	insertReturning: Mock<(sql: string, values: Bindings) => Promise<unknown>>;
};
export interface RouteFixture {
	f: Awaited<ReturnType<typeof decisionFixture>>;
	db: Database.Database;
	app: Hono;
	options: CoordinatorRelayAdmissionRuntimeOptions & {
		open: Mock<() => { database: RouteDatabase; close: Mock<() => void> }>;
	};
	database: RouteDatabase;
	trace: string[];
	close: Mock<() => void>;
	storeFactory: Mock<() => never>;
	headers: () => Headers;
	request: (init?: RequestInit, path?: string) => Response | Promise<Response>;
	nonces: () => unknown[];
	buckets: () => unknown[];
	mount: (pathname: string, prefix?: string) => Hono;
}

export function d1App(h: Awaited<ReturnType<typeof routeFixture>>) {
	const db: D1DatabaseLike = {
		prepare(sql) {
			let values: Bindings = [];
			return {
				bind(...input) {
					values = input as Bindings;
					return this;
				},
				async all<T>() {
					return { results: (await h.database.query(sql, values)) as T[] };
				},
				async first<T>() {
					return (await h.database.insertReturning(sql, values)) as T | null;
				},
				async run() {
					throw new Error("unexpected run");
				},
				async raw<T>(): Promise<T[]> {
					throw new Error("unexpected raw");
				},
			};
		},
	};
	const app = createD1CoordinatorApp({
		db,
		relayAdmission: h.options,
		now: () => new Date(110_000).toISOString(),
		requestVerifier: async () => {
			throw new Error("ordinary verifier must not run");
		},
	});
	return new Hono().route("/trusted", app);
}

function createDatabase() {
	const db = new Database(":memory:");
	db.pragma("foreign_keys=ON");
	db.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	for (const sql of [
		...ADMISSION_BUDGET_SCHEMA_STATEMENTS,
		...RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS,
	])
		db.exec(sql);
	const now = 110_000;
	db.function("strftime", (format, when) => {
		if (when !== "now") throw new Error("unexpected clock input");
		if (format === "%s") return "110";
		if (format === "%f") return "50.000";
		if (format === "%Y-%m-%dT%H:%M:%fZ") return new Date(now).toISOString();
		throw new Error("unexpected clock format");
	});
	return db;
}

export function seedRouteDatabase(
	db: Database.Database,
	f: Awaited<ReturnType<typeof decisionFixture>>,
	options: { omitProfiles?: boolean },
) {
	// Explicit disposable readiness and capacities. No health controller is exercised here.
	for (const { sql, values } of decisionSeed(f, 110_000)) db.prepare(sql).run(bind(values));
	if (options.omitProfiles) return;
	const { authorityId, groupId, relayAudienceId } = f.request.namespace;
	const allocate = (pool: string, audience = "", group = "", rate = 1, burst = 16) =>
		db.prepare(ALLOCATION).run(bind([authorityId, pool, audience, group, rate, burst]));
	allocate("authority", "", "", 4, 64);
	for (const pool of ["relay-route", "relay-registration"]) {
		const burst = pool === "relay-registration" ? 2 : 16;
		allocate(pool, relayAudienceId, "", 1, burst);
		allocate(pool, relayAudienceId, groupId, 1, burst);
	}
	allocate("device");
	allocate("device-registration", "", "", 1, 2);
}

function createPorts(db: Database.Database, f: RouteFixture["f"]) {
	const trace: string[] = [];
	const database = {
		query: vi.fn(async (sql: string, values: Bindings): Promise<unknown> => {
			trace.push("query");
			return db.prepare(sql).all(bind(values));
		}),
		insertReturning: vi.fn(async (sql: string, values: Bindings): Promise<unknown> => {
			trace.push(sql.includes("INSERT INTO request_nonces") ? "nonce" : "budget");
			return db.prepare(sql).get(bind(values)) ?? null;
		}),
	};
	const close = vi.fn();
	const options = {
		namespace: { ...f.request.namespace },
		externalPathname: f.request.externalPathname,
		ingressKey: "trusted-ingress",
		open: vi.fn(() => ({ database, close })),
	};
	return { trace, database, close, options };
}

export async function routeFixture(
	role: Parameters<typeof decisionFixture>[0] = {},
	seed: { omitProfiles?: boolean } = {},
): Promise<RouteFixture> {
	const f = await decisionFixture(role);
	const db = createDatabase();
	seedRouteDatabase(db, f, seed);
	const { trace, database, close, options } = createPorts(db, f);
	const storeFactory = vi.fn(() => {
		throw new Error("ordinary store must not open");
	});
	const child = createCoordinatorApp({
		storeFactory,
		relayAdmission: options,
		runtime: { adminSecret: () => null, now: () => new Date(110_000).toISOString() },
		requestVerifier: async () => {
			throw new Error("ordinary verifier must not run");
		},
	});
	const app = new Hono().route("/trusted", child);
	const mount = (pathname: string, prefix = "/trusted") => {
		options.externalPathname = pathname;
		const inner = new Hono();
		registerCoordinatorRelayAdmissionRoute(inner, options);
		return new Hono().route(prefix, inner);
	};
	const headers = () => requestHeaders(f);
	const request = (init: RequestInit = {}, path = f.request.externalPathname) =>
		app.request(path, {
			method: "POST",
			headers: headers(),
			body: new Uint8Array(f.bodyBytes),
			...init,
		});
	const nonces = () => db.prepare("SELECT * FROM request_nonces").all();
	const buckets = () =>
		db
			.prepare(
				"SELECT pool,group_id,device_id,units,granted FROM admission_budget_buckets ORDER BY pool,group_id",
			)
			.all();
	return {
		f,
		db,
		app,
		options,
		database,
		trace,
		close,
		storeFactory,
		headers,
		request,
		nonces,
		buckets,
		mount,
	};
}

function requestHeaders(f: RouteFixture["f"]): Headers {
	return new Headers({
		"Content-Type": "application/json",
		"X-Opencode-Device": f.request.deviceHeader,
		"X-Opencode-Timestamp": f.request.packet.timestamp,
		"X-Opencode-Nonce": f.request.packet.nonce,
		"X-Opencode-Signature": f.request.packet.signature,
	});
}
