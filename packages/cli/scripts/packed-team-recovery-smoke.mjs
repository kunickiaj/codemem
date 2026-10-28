import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NOW = "2026-10-01T00:00:00.000Z";
const GROUP = "packed-team";
const SPACE = "packed-space";
const SECRET = "synthetic-packed-admin-secret";
const actors = ["person-a", "person-b"];
const devices = ["device-a", "device-b"];
const publicKeys = [
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
];

function runNode(args, { cwd, env }) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => { stdout += data; });
		child.stderr.on("data", (data) => { stderr += data; });
		const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 90_000);
		child.once("error", reject);
		child.once("close", (status) => {
			clearTimeout(timeout);
			if (status !== 0) reject(new Error(`Installed recovery child failed (${status})\n${stdout}\n${stderr}`));
			else resolvePromise(stdout);
		});
	});
}

/** Run in children so installed code never sees the caller's profiles or credentials. */
export async function smokeTeamRecovery(installDir, isolatedRoot, { runtimeEnv }) {
	for (const scenario of ["recover", "disabled", "rekeyed"]) {
		const home = join(isolatedRoot, `team-recovery-${scenario}`);
		const env = {
			...runtimeEnv(home),
			CODEMEM_ACTOR_ID: actors[1],
			CODEMEM_DEVICE_ID: devices[1],
			CODEMEM_ACTOR_DISPLAY_NAME: "Person B",
			CODEMEM_EMBEDDING_DISABLED: "1",
			CODEMEM_SYNC_KEY_STORE: "file",
		};
		try {
			await runNode([fileURLToPath(import.meta.url), "--installed-fixture", installDir, scenario], {
				cwd: installDir, env,
			});
		} catch (error) {
			throw new Error(`Packed Team recovery scenario failed: ${scenario}`, { cause: error });
		}
	}
	process.stdout.write("Packed Team recovery: diagnosis, cold recovery, idempotence, Space membership, disabled/rekeyed rejection passed\n");
}

// Adapt installed Hono exports to an actual loopback HTTP listener without workspace imports.
async function listen(app) {
	const server = createServer(async (incoming, outgoing) => {
		try {
			const chunks = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const body = Buffer.concat(chunks);
			const request = new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {
				method: incoming.method, headers: incoming.headers,
				...(body.length ? { body } : {}),
			});
			const response = await app.fetch(request);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch (error) {
			outgoing.writeHead(500, { "content-type": "application/json" });
			outgoing.end(JSON.stringify({ error: String(error) }));
		}
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((resolvePromise, reject) => {
			server.close((error) => error ? reject(error) : resolvePromise());
			server.closeAllConnections();
		}),
	};
}

function seedActor(db, index, local) {
	db.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		VALUES (?, ?, ?, 'active', ?, ?)`).run(actors[index], `Person ${index ? "B" : "A"}`, local ? 1 : 0, NOW, NOW);
}

function seedDevice(db, index, fingerprint) {
	db.prepare("INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)")
		.run(devices[index], publicKeys[index], fingerprint, NOW);
}

function snapshot(db) {
	return ["actors", "identity_devices", "policy_teams", "policy_team_memberships", "legacy_team_setup_drafts", "legacy_team_setup_draft_devices", "legacy_team_setup_completions", "project_recipients"]
		.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
}

async function installedFixture(installDir, scenario) {
	// Forbid any accidental external fetch, including from the installed modules.
	const realFetch = globalThis.fetch;
	globalThis.fetch = (input, options) => {
		const url = new URL(input instanceof Request ? input.url : input);
		assert.equal(url.hostname, "127.0.0.1", `Non-loopback request forbidden: ${url.origin}`);
		assert.equal(url.protocol, "http:");
		return realFetch(input, options);
	};
	const core = await import(pathToFileURL(join(installDir, "node_modules/@codemem/core/dist/index.js")).href);
	const viewer = await import(pathToFileURL(join(installDir, "node_modules/@codemem/server/dist/index.js")).href);
	const cli = join(installDir, "node_modules/codemem/dist/index.js");
	const home = process.env.HOME;
	const fingerprints = publicKeys.map(core.fingerprintPublicKey);
	const coordinatorPath = join(home, "coordinator.sqlite");
	const coordinatorStore = new core.BetterSqliteCoordinatorStore(coordinatorPath);
	const coordinator = await listen(core.createBetterSqliteCoordinatorApp({
		dbPath: coordinatorPath,
		runtime: { adminSecret: () => SECRET, now: () => NOW },
	}));
	const source = new core.MemoryStore(":memory:");
	let target;
	let server;
	try {
		// Arrange: machine A publishes the two-person canonical completion.
		await coordinatorStore.createGroup(GROUP, "Packed Team");
		for (const [index, deviceId] of devices.entries()) {
			await coordinatorStore.enrollDevice(GROUP, {
				deviceId, publicKey: publicKeys[index], fingerprint: fingerprints[index],
				displayName: index ? "Laptop B" : "Laptop A",
			});
			seedActor(source.db, index, index === 0);
		}
		seedDevice(source.db, 0, fingerprints[0]);
		const candidateRef = core.legacyTeamCandidateId(coordinator.url, GROUP);
		let draft = core.refreshLegacyTeamSetupDraft(source.db, {
			candidateId: candidateRef, coordinatorId: coordinator.url, groupId: GROUP,
			displayName: "Packed Team", projects: [], now: NOW,
			devices: devices.map((deviceId, index) => ({
				deviceId, fingerprint: fingerprints[index], displayName: `Laptop ${index}`, enabled: true,
			})),
		});
		for (const [index, device] of draft.devices.entries()) {
			const deviceId = source.db.prepare("SELECT device_id FROM legacy_team_setup_draft_devices WHERE attempt_id = ? AND device_ref = ?")
				.pluck().get(draft.attemptId, device.deviceRef);
			draft = core.setLegacyTeamSetupDeviceAssignment(source.db, {
				attemptId: draft.attemptId, deviceRef: device.deviceRef,
				targetIdentityId: actors[devices.indexOf(deviceId)], expectation: device.expectation, now: NOW,
			});
			draft = core.setLegacyTeamSetupDeviceDecision(source.db, {
				attemptId: draft.attemptId, deviceRef: draft.devices[index].deviceRef, decision: "included", now: NOW,
			});
		}
		const manifest = core.deriveLegacyTeamSetupCompletionManifest(source.db, {
			candidateRef, attemptId: draft.attemptId, completedAt: NOW,
		});
		assert.equal(manifest.memberships.length, 2);
		await coordinatorStore.createLegacyTeamCompletion(GROUP, manifest);
		await coordinatorStore.createScope({
			scopeId: SPACE, groupId: GROUP, label: "Packed Space", kind: "team",
			authorityType: "coordinator", coordinatorId: coordinator.url, membershipEpoch: 1, status: "active",
		});
		writeFileSync(process.env.CODEMEM_CONFIG, JSON.stringify({
			actor_id: actors[1], actor_display_name: "Person B", sync_coordinator_url: coordinator.url,
			sync_coordinator_admin_secret: SECRET, sync_coordinator_groups: [GROUP], sync_coordinator_timeout_s: 2,
		}));
		mkdirSync(join(home, ".codemem"), { recursive: true });
		target = new core.MemoryStore(process.env.CODEMEM_DB);
		seedActor(target.db, 1, true);
		seedDevice(target.db, 1, fingerprints[1]);
		assert.deepEqual(target.db.prepare("SELECT actor_id FROM actors").all(), [{ actor_id: actors[1] }]);
		assert.equal(target.db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get(), 0);
		assert.equal(target.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get(), 0);

		if (scenario === "disabled") await coordinatorStore.setDeviceEnabled(GROUP, devices[0], false);
		if (scenario === "rekeyed") await coordinatorStore.enrollDevice(GROUP, {
			deviceId: devices[0], publicKey: publicKeys[1], fingerprint: fingerprints[1],
		});
		const before = snapshot(target.db);
		const sourceBytes = readFileSync(process.env.CODEMEM_DB);

		// Act: the installed CLI diagnoses before any viewer request can create a draft.
		const output = await runNode([cli, "coordinator", "diagnose-team-setup", GROUP,
			"--db-path", process.env.CODEMEM_DB, "--config", process.env.CODEMEM_CONFIG, "--json"], {
			cwd: installDir, env: process.env,
		});
		const diagnosis = JSON.parse(output).groups[0];
		// Assert: dry-run predicts the real outcome without changing the source DB.
		assert.equal(diagnosis.manifest.ok, true, JSON.stringify(diagnosis));
		assert.equal(diagnosis.apply?.ok, scenario === "recover", JSON.stringify(diagnosis));
		if (scenario === "recover") {
			assert.equal(diagnosis.apply.teamStatus, "active");
			assert.equal(diagnosis.apply.migrationState, "completed");
		}
		assert.deepEqual(snapshot(target.db), before, "Diagnosis changed source policy or draft rows");
		assert.deepEqual(readFileSync(process.env.CODEMEM_DB), sourceBytes, "Diagnosis changed source DB bytes");

		// Act: use the installed viewer's default coordinator clients over actual HTTP.
		server = await listen(viewer.createApp({ storeFactory: () => target }));
		const request = async (path, body) => {
			const response = await fetch(`${server.url}${path}`, body === undefined ? {} : {
				method: "POST", headers: { "content-type": "application/json", origin: server.url }, body: JSON.stringify(body),
			});
			return { status: response.status, body: await response.json() };
		};
		const summary = await request("/api/sync/team-setup/v1");
		if (scenario !== "recover") {
			// Assert: invalid included devices cannot create grants or placeholder actors.
			assert.equal(summary.status, 200, JSON.stringify(summary));
			assert.equal(summary.body.candidates[0].blockingError, "team_setup_completion_invalid");
			const invalidDetail = await request(`/api/sync/team-setup/v1/${candidateRef}`);
			assert.equal(invalidDetail.status, 409, JSON.stringify(invalidDetail));
			assert.equal(invalidDetail.body.error, "team_setup_completion_invalid");
			assert.equal(target.db.prepare("SELECT COUNT(*) FROM policy_teams WHERE status = 'active'").pluck().get(), 0);
			assert.equal(target.db.prepare("SELECT COUNT(*) FROM policy_team_memberships WHERE status = 'reviewed_active'").pluck().get(), 0);
			assert.equal(target.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get(), 0);
			assert.equal(target.db.prepare("SELECT COUNT(*) FROM actors WHERE actor_id = ?").pluck().get(actors[0]), 0);
			return;
		}
		// Assert: cold recovery materializes the absent teammate with no personal label invention.
		assert.equal(summary.status, 200, JSON.stringify(summary));
		assert.deepEqual(target.db.prepare("SELECT display_name, is_local, status FROM actors WHERE actor_id = ?").get(actors[0]), {
			display_name: "Team member", is_local: 0, status: "active",
		});
		assert.deepEqual(target.db.prepare("SELECT display_name, is_local, status FROM actors WHERE actor_id = ?").get(actors[1]), {
			display_name: "Person B", is_local: 1, status: "active",
		});
		assert.equal(target.db.prepare("SELECT status FROM policy_teams WHERE team_id = ?").pluck().get(manifest.team_id), "active");
		assert.deepEqual(target.db.prepare("SELECT identity_id, role, status FROM policy_team_memberships WHERE team_id = ? ORDER BY identity_id").all(manifest.team_id),
			actors.map((identity_id) => ({ identity_id, role: "member", status: "reviewed_active" })));
		assert.deepEqual(target.db.prepare("SELECT device_id, identity_id, status FROM identity_devices ORDER BY device_id").all(),
			devices.map((device_id, index) => ({ device_id, identity_id: actors[index], status: "active" })));
		assert.equal(core.getLegacyTeamSetupDraft(target.db, candidateRef).state, "completed");
		const recovered = snapshot(target.db);
		const detailPath = `/api/sync/team-setup/v1/${candidateRef}`;
		const detail = await request(detailPath);
		assert.equal(detail.status, 200, JSON.stringify(detail));
		assert.equal(detail.body.state, "completed");
		assert.equal((await request("/api/sync/team-setup/v1")).status, 200);
		assert.deepEqual(await request(detailPath), detail);
		assert.deepEqual(snapshot(target.db), recovered, "Repeated reads changed recovered policy");

		// Arrange/Act: membership controls go through the installed viewer and real fixture coordinator.
		const membersPath = `/api/coordinator/admin/groups/${GROUP}/scopes/${SPACE}/members`;
		assert.equal((await request(membersPath)).body.items.length, 0);
		const joined = await request(membersPath, { device_id: devices[1], effect_id: "packed-join" });
		assert.equal(joined.status, 200, JSON.stringify(joined));
		assert.equal(joined.body.membership.status, "active");
		assert.equal((await coordinatorStore.listScopeMemberships(SPACE)).length, 1);
		const left = await request(`${membersPath}/${devices[1]}/revoke`, { effect_id: "packed-leave" });
		assert.equal(left.status, 200, JSON.stringify(left));
		assert.equal((await coordinatorStore.listScopeMemberships(SPACE)).length, 0);
		const denied = await fetch(`${coordinator.url}/v1/admin/groups/${GROUP}/scopes/${SPACE}/members`, {
			method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong-fixture-secret" },
			body: JSON.stringify({ device_id: devices[1], effect_id: "packed-denied" }),
		});
		assert.equal(denied.status, 401);
		assert.equal((await coordinatorStore.listScopeMemberships(SPACE)).length, 0);
		assert.deepEqual(snapshot(target.db), recovered, "Space controls changed recovered Team policy");
	} finally {
		await server?.close();
		target?.close();
		source.close();
		await coordinator.close();
		await coordinatorStore.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	assert.equal(process.argv[2], "--installed-fixture");
	await installedFixture(resolve(process.argv[3]), process.argv[4]);
}
