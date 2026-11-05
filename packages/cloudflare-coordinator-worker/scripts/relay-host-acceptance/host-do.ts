// The Durable Object relay host: the coordinator Worker bundle, as `wrangler deploy`
// would build it, running in Miniflare with D1 and both relay Durable Objects.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { D1CoordinatorStore } from "../../../core/src/d1-coordinator-store.js";
import { relayRealmId } from "../../../core/src/relay-service-proof.js";
import {
	type Fixture,
	GROUPS,
	type GroupId,
	PROBE_SCOPES,
	type ReadinessRow,
	type RelayCounters,
	type RelayHostUnderTest,
	seedDirectory,
} from "./common.js";
import { core } from "./device.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, "../..");
const workerRequire = createRequire(join(workerDir, "package.json"));
const runtimeRequire = createRequire(workerRequire.resolve("wrangler/package.json"));

/** Builds the deployed entry, plus one read-only counters RPC, with `wrangler deploy --dry-run`. */
function bundle(outdir: string): string {
	execFileSync(
		"pnpm",
		["exec", "wrangler", "deploy", "--dry-run", "--config", "wrangler.jsonc", join(here, "do-entry.mjs"), "--outdir", outdir],
		{ cwd: workerDir, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
	);
	const entry = readdirSync(outdir).find((name) => name.endsWith(".js"));
	if (!entry) throw new Error("Worker bundle missing");
	return join(outdir, entry);
}

function workerOptions(fixture: Fixture, scriptPath: string) {
	const { ids } = fixture;
	return {
		modules: true,
		scriptPath,
		compatibilityDate: "2026-03-28",
		compatibilityFlags: ["nodejs_compat"],
		d1Databases: { COORDINATOR_DB: "relay-host-acceptance" },
		durableObjects: {
			RELAY_REALM: { className: "RelayRealm", useSQLite: true },
			RELAY_HEALTH: { className: "RelayHealth", useSQLite: true },
		},
		bindings: {
			CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: fixture.adminSecret,
			CODEMEM_RELAY_ENABLED: "true",
			CODEMEM_RELAY_AUTHORITY_URL: fixture.origin,
			CODEMEM_RELAY_GROUPS: JSON.stringify(GROUPS),
			CODEMEM_RELAY_SERVICE_KEY: ids.service.pkcs8,
			CODEMEM_RELAY_HEALTH_PROBE_DEVICE: ids.probe.deviceId,
			CODEMEM_RELAY_HEALTH_SCOPES: JSON.stringify(PROBE_SCOPES),
			CODEMEM_RELAY_HEALTH_PROBE_KEY: ids.probe.pkcs8,
		},
		cf: false,
		host: "127.0.0.1",
		port: 0,
		outboundService: () => {
			throw new Error("External network forbidden");
		},
	};
}

/** The deployment guide's admin steps, through the public origin. */
async function admin(fixture: Fixture, path: string, body: unknown): Promise<Record<string, unknown>> {
	const response = await fetch(`${fixture.origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-codemem-coordinator-admin": fixture.adminSecret },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10000),
	});
	const reply = (await response.json()) as Record<string, unknown>;
	if (response.status !== 200) throw new Error(`${path} ${response.status}: ${JSON.stringify(reply)}`);
	return reply;
}

export async function startDurableObjectHost(fixture: Fixture): Promise<RelayHostUnderTest & { provision(): Promise<void> }> {
	const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
	const mf = new Miniflare(convertV4MiniflareOptions(workerOptions(fixture, bundle(join(fixture.runDir, "bundle")))));
	const port = Number(new URL(await mf.ready).port);
	const db = await mf.getD1Database("COORDINATOR_DB");
	const { readD1Migrations } = await import("@cloudflare/vitest-pool-workers");
	for (const migration of await readD1Migrations(join(workerDir, "migrations")))
		await db.batch(migration.queries.map((sql: string) => db.prepare(sql)));
	await seedDirectory(new D1CoordinatorStore(db as never) as never, fixture, core.fingerprintPublicKey);
	const realms = Object.fromEntries(GROUPS.map((groupId) => [groupId, relayRealmId(fixture.authorityId, groupId)]));
	const namespace = await mf.getDurableObjectNamespace("RELAY_REALM");
	const realm = (groupId: GroupId) => namespace.get(namespace.idFromName(realms[groupId]));
	return {
		name: "durable-object",
		httpPort: port,
		relayUpstream: () => `ws://127.0.0.1:${port}`,
		// The admin routes need the TLS front, so the run calls this once the front is up.
		async provision() {
			const setup = await admin(fixture, "/v1/admin/relay/admission", {});
			if (setup.health !== "scheduled") throw new Error(`admission setup: ${JSON.stringify(setup)}`);
			for (const realmId of Object.values(realms)) await admin(fixture, "/v1/admin/relay/quota", { realm_id: realmId, enabled: true });
		},
		readiness: async () =>
			(await db.prepare("SELECT scope, group_id, state FROM relay_admission_readiness ORDER BY scope, group_id").all())
				.results as ReadinessRow[],
		counters: async (groupId) => (await realm(groupId).harnessCounters()) as RelayCounters | null,
		disableRealm: async (groupId) => {
			await admin(fixture, "/v1/admin/relay/quota", { realm_id: realms[groupId], enabled: false });
		},
		dispose: () => mf.dispose(),
	};
}
