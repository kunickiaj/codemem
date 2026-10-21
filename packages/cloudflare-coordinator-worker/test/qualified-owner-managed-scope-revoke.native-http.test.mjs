import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ownerHttpRequest } from "./owner-handoff-fixture.mjs";
import { cookie, fields, groupId, journeyFixture, origin, teamId } from "./qualified-owner-journey-fixture.mjs";

const reviewedIntent = {
	version: 1, journey: "team",
	team: { teamId, displayName: "Synthetic journey Team", futureProjectsInherit: true },
	projects: [], excludedProjects: [],
};
const scopeId = "journey-managed-project";
const projectId = "https://example.test/synthetic-journey.git";
const workspace = "/synthetic/journey/project";

async function inviteBody(f) {
	return {
		group_id: groupId, policy: "auto_admit", expires_at: new Date(f.now + 3600_000).toISOString(),
		coordinator_url: origin, invite_kind: "team_member", policy_team_id: teamId,
		reviewed_intent: reviewedIntent, reviewed_preview_digest: await f.h.recipientReviewedIntentDigest(reviewedIntent),
	};
}

async function adoptA(f) {
	const response = await f.admin("/v1/admin/invites", await inviteBody(f));
	assert.equal(response.status, 200, await response.clone().text());
	const invite = await response.json();
	assert.ok(invite.payload.assigned_identity_id);
	const initial = f.openStore();
	const [deviceId] = f.h.ensureDeviceIdentity(initial.db, { keysDir: f.keysDir });
	initial.close();
	const preview = f.h.previewRecipientPolicyOnboardingFromReviewedIntent(reviewedIntent, {
		version: 1, journey: "team", invitationId: invite.payload.token,
		identityId: invite.payload.assigned_identity_id, deviceId,
		devicePublicKey: f.publicKey, deviceDisplayName: "Synthetic A", teamId,
	});
	await f.h.coordinatorImportInviteAction({
		inviteValue: invite.encoded, dbPath: f.dbPath, keysDir: f.keysDir, configPath: f.configPath,
		recipientDisplayName: "Synthetic owner", deviceDisplayName: "Synthetic A",
		reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
	});
	const store = f.openStore();
	assert.equal(store.actorId, invite.payload.assigned_identity_id);
	assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).actor_id, store.actorId);
	return { store, deviceId, identityId: store.actorId, invite };
}

async function browserLink(f, url) {
	const page = await f.request(url);
	const binder = cookie(page);
	const started = await f.request(`${origin}/auth/link/start`, {
		method: "POST", headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
		body: (await fields(page, "/auth/link/start")).toString(),
	});
	assert.equal(started.status, 200);
	const transactionCookie = cookie(started);
	const href = (await started.text()).match(/href="(https:[^"]+\/authorize[^"]+)"/)?.[1];
	assert.ok(href);
	const verified = await f.request(f.provider.authorize(href.replaceAll("&amp;", "&")), {
		headers: { cookie: transactionCookie },
	});
	const confirmed = await f.request(`${origin}/auth/link/confirm`, {
		method: "POST", headers: { origin, cookie: transactionCookie, "content-type": "application/x-www-form-urlencoded" },
		body: (await fields(verified, "/auth/link/confirm")).toString(),
	});
	assert.equal(confirmed.status, 200);
	const hop = (await confirmed.text()).match(/href="(http:\/\/127\.0\.0\.1[^"]+)"/)?.[1];
	assert.ok(hop);
	assert.equal((await ownerHttpRequest(hop.replaceAll("&amp;", "&"))).status, 200);
}

function history(store) {
	return ["sessions", "memory_items", "replication_ops", "policy_team_memberships", "project_recipients", "scope_memberships"]
		.map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

async function initialProjectPolicy(f, a, { managed = false } = {}) {
	const session = a.store.startSession({ cwd: workspace, project: "synthetic-journey", gitRemote: "https://example.test/synthetic-journey.git" });
	a.store.remember(session, "discovery", "A history before Google", "Preserve this author and original key.", 0.8);
	const changes = [{ canonicalProjectIdentity: projectId,
		recipient: { recipientKind: "identity", identityId: a.identityId }, action: "add" }];
	const preview = f.h.previewRecipientPolicyEdges(a.store.db, { version: 1, changes });
	const stale = f.h.commitRecipientPolicyEdges(a.store.db, {
		version: 1, changes, reviewedPolicyDigest: `recipient-policy-preview-v1:${"f".repeat(64)}`,
	});
	assert.notEqual(stale.status, "applied");
	assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM project_recipients").get().n, 0);
	const committed = f.h.commitRecipientPolicyEdges(a.store.db, {
		version: 1, changes, reviewedPolicyDigest: preview.reviewedPolicyDigest,
	});
	assert.equal(committed.status, "applied", JSON.stringify(committed));
	// Existing privileged operator setup, only for A's initial Project policy. Never used to grant B.
	const scope = await f.h.coordinatorCreateScopeAction({
		groupId, scopeId, label: "Synthetic journey Project", kind: managed ? "managed_project" : "team", authorityType: "coordinator",
		coordinatorId: origin, remoteUrl: origin, adminSecret: f.adminSecret,
	});
	assert.equal(scope.coordinator_id, origin);
	await f.h.coordinatorGrantScopeMembershipAction({
		effectId: "journey-initial-a-project",
		groupId, scopeId, deviceId: a.deviceId, role: "member", coordinatorId: origin,
		remoteUrl: origin, adminSecret: f.adminSecret,
	});
	const refreshed = await f.h.refreshScopeMembershipCache(a.store.db, {
		groupIds: [groupId], remoteUrl: origin, keysDir: f.keysDir, dbPath: f.dbPath,
	});
	assert.equal(refreshed.status, "refreshed", JSON.stringify(refreshed));
	const mappings = f.h.upsertProjectScopeSettingsMappings(a.store.db, [{
		workspace_identity: workspace, project_pattern: workspace, scope_id: scopeId, source: "user", priority: 100,
	}], { deviceId: a.deviceId });
	assert.equal(mappings.length, 1);
	assert.equal(a.store.db.prepare("SELECT scope_id FROM memory_items").get().scope_id, scopeId);
}

test("reviewed Team invitation rejects a nominated Identity and stale intent without enrolling A", async t => {
	// Arrange: only the discovery group exists; the caller cannot choose the server-assigned Identity.
	const f = await journeyFixture(t);
	const body = await inviteBody(f);
	const before = await f.rows("enrolled_devices");
	// Act: exercise the configured Worker's real admin route over native HTTP.
	const nominated = await f.admin("/v1/admin/invites", { ...body, assigned_identity_id: "caller-selected" });
	const stale = await f.admin("/v1/admin/invites", { ...body, reviewed_preview_digest: "f".repeat(64) });
	// Assert: neither invalid review creates enrollment or authority.
	assert.equal(nominated.status, 400);
	assert.deepEqual(await nominated.json(), { error: "assigned_identity_id_forbidden" });
	assert.equal(stale.status, 409);
	assert.deepEqual(await stale.json(), { error: "recipient_invite_intent_mismatch" });
	assert.deepEqual(await f.rows("enrolled_devices"), before);
	assert.deepEqual(await f.rows("coordinator_identity_group_grants"), []);
});

test("invite-assigned A links with device-claim authority without rewriting existing history or granting transport", async t => {
	// Arrange: actual inspect/import adoption precedes history; no controller review or Identity-group grant.
	const f = await journeyFixture(t);
	const a = await adoptA(f);
	await initialProjectPolicy(f, a);
	const before = history(a.store);
	const keys = await Promise.all(["device.key", "device.key.pub"].map(name => readFile(join(f.keysDir, name), "utf8")));
	assert.deepEqual(await f.rows("coordinator_auth_controller_attestations"), []);
	assert.deepEqual(await f.rows("coordinator_identity_group_grants"), []);
	const readiness = await f.h.readCoordinatorAccountLinkStatus({
		dbPath: f.dbPath, keysDir: f.keysDir, coordinatorUrl: origin, groupId,
		identityId: a.identityId, fetch: f.request,
	});
	assert.equal(readiness.kind, "status");
	assert.equal(readiness.status.authority, "device_claim");
	assert.equal(readiness.status.state, "unlinked");
	// A stale controller-authority expectation must fail before opening a browser or writing a link.
	let unexpectedBrowser = false;
	await assert.rejects(f.h.linkCoordinatorAccount({
		dbPath: f.dbPath, keysDir: f.keysDir, coordinatorUrl: origin, groupId,
		expectedIdentityId: a.identityId, expectedAuthority: "controller_attestation", fetch: f.request,
		onBrowserStart: () => { unexpectedBrowser = true; },
	}));
	assert.equal(unexpectedBrowser, false);
	assert.deepEqual(await f.rows("coordinator_auth_account_links"), []);
	let browserDone;
	// Act: genuine provider-signed JWT/JWKS, browser forms/CSRF and native loopback receiver.
	const result = await f.h.linkCoordinatorAccount({
		dbPath: f.dbPath, keysDir: f.keysDir, coordinatorUrl: origin, groupId,
		expectedIdentityId: a.identityId, expectedAuthority: "device_claim", fetch: f.request,
		onBrowserStart: url => { browserDone = browserLink(f, url); void browserDone.catch(() => {}); },
	});
	await browserDone;
	// Assert: linking is not qualification, a logical grant, or permission to rewrite capture history.
	assert.equal(result.state, "finalized");
	assert.equal(result.identityId, a.identityId);
	assert.deepEqual(history(a.store), before);
	assert.deepEqual(await Promise.all(["device.key", "device.key.pub"].map(name => readFile(join(f.keysDir, name), "utf8"))), keys);
	assert.deepEqual(await f.rows("coordinator_identity_group_grants"), []);
	assert.deepEqual(await f.rows("coordinator_auth_controller_attestations"), []);
	const links = await f.rows("coordinator_auth_account_links");
	assert.equal(links.length, 1);
	assert.equal(links[0].identity_id, a.identityId);
	assert.equal(links[0].controller_attestation_id, null);
});

async function linkedA(f, options) {
	const a = await adoptA(f);
	await initialProjectPolicy(f, a, options);
	let browserDone;
	const result = await f.h.linkCoordinatorAccount({
		dbPath: f.dbPath, keysDir: f.keysDir, coordinatorUrl: origin, groupId,
		expectedIdentityId: a.identityId, expectedAuthority: "device_claim", fetch: f.request,
		onBrowserStart: url => { browserDone = browserLink(f, url); void browserDone.catch(() => {}); },
	});
	await browserDone;
	assert.equal(result.state, "finalized");
	assert.deepEqual(await f.rows("coordinator_identity_group_grants"), []);
	return a;
}

async function reviewAndGrant(f, a) {
	const review = { group_id: groupId, device_id: a.deviceId, identity_id: a.identityId,
		fingerprint: f.profileRows({ dbPath: f.dbPath }, "sync_device")[0].fingerprint };
	const preview = await f.admin("/v1/admin/auth-controller-reviews", review);
	assert.equal(preview.status, 200, await preview.clone().text());
	const { evidence_digest } = await preview.json();
	const denied = await f.admin("/v1/admin/auth-controller-reviews", { ...review, confirm_evidence_digest: "0".repeat(64) });
	assert.equal(denied.status, 409);
	assert.deepEqual(await f.rows("coordinator_auth_controller_attestations"), []);
	const committed = await f.admin("/v1/admin/auth-controller-reviews", { ...review, confirm_evidence_digest: evidence_digest });
	assert.equal(committed.status, 201, await committed.clone().text());
	const { attestation_id } = await committed.json();
	assert.deepEqual(await f.rows("coordinator_identity_group_grants"), []);
	const grant = await f.admin("/v1/admin/identity-group-grants", { attestation_id });
	assert.equal(grant.status, 200, await grant.clone().text());
	assert.equal((await f.rows("coordinator_identity_group_grants")).length, 1);
	return attestation_id;
}

async function signIn(f) {
	const page = await f.request(`${origin}/auth/sign-in`);
	const started = await f.request(`${origin}/auth/sign-in`, {
		method: "POST", headers: { origin, cookie: cookie(page), "content-type": "application/x-www-form-urlencoded" },
		body: (await fields(page, "/auth/sign-in")).toString(),
	});
	assert.equal(started.status, 200, await started.clone().text());
	const href = (await started.text()).match(/href="(https:[^"]+\/authorize[^"]+)"/)?.[1];
	assert.ok(href);
	const signedIn = await f.request(f.provider.authorize(href.replaceAll("&amp;", "&")), {
		headers: { cookie: cookie(started) },
	});
	assert.equal(signedIn.status, 303, await signedIn.clone().text());
	return cookie(signedIn);
}

async function admitAndFinishB(f, session, url, details) {
	const bindingsBefore = await f.rows("coordinator_device_ownership_bindings");
	assert.equal(url, `${origin}/auth/owner/admit`);
	assert.ok(details?.requestFile);
	const page = await f.request(url, { headers: { cookie: session } });
	const form = await fields(page, "/auth/owner/admit");
	const body = new FormData();
	body.append("csrf", form.get("csrf"));
	body.append("request", new File([await readFile(details.requestFile)], "capability-request.json", { type: "application/json" }));
	const admitted = await f.request(url, { method: "POST", headers: { origin, cookie: session }, body });
	const started = await f.request(`${origin}/auth/owner/start`, {
		method: "POST", headers: { origin, cookie: `${session}; ${cookie(admitted)}`, "content-type": "application/x-www-form-urlencoded" },
		body: (await fields(admitted, "/auth/owner/start")).toString(),
	});
	assert.equal(started.status, 303, await started.clone().text());
	const binder = cookie(started);
	const callback = await f.request(f.provider.authorize(started.headers.get("location")), { headers: { cookie: binder } });
	const confirmation = await fields(callback, "/auth/owner/confirm");
	const badCsrf = await f.request(`${origin}/auth/owner/confirm`, {
		method: "POST", headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ ...Object.fromEntries(confirmation), csrf: "wrong" }).toString(),
	});
	assert.equal(badCsrf.status, 400);
	assert.deepEqual(await f.rows("coordinator_device_ownership_bindings"), bindingsBefore);
	const confirmed = await f.request(`${origin}/auth/owner/confirm`, {
		method: "POST", headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
		body: confirmation.toString(),
	});
	assert.equal(confirmed.status, 303, await confirmed.clone().text());
	const destination = new URL(confirmed.headers.get("location"));
	assert.equal(destination.hostname, "127.0.0.1");
	assert.equal((await ownerHttpRequest(destination.href, {
		headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
	})).status, 200);
}

async function managedJourney(f, a, b) {
	const bStore = f.openProfile(b);
	const bServer = await f.serveProfile(bStore, b);
	const aPaths = { dbPath: f.dbPath, keysDir: f.keysDir };
	const config = f.h.readCoordinatorSyncConfig({ sync_enabled: true, sync_coordinator_url: origin,
		sync_coordinator_groups: [groupId], sync_coordinator_admin_secret: f.adminSecret });
	assert.equal(JSON.parse(await readFile(b.configPath, "utf8")).sync_coordinator_admin_secret, undefined);
	// Explicit manual key pairing is a network-bootstrap prerequisite, not managed Project authorization.
	const bKey = f.profileRows(b, "sync_device")[0];
	const aKey = f.profileRows(aPaths, "sync_device")[0];
	f.h.updatePeerAddresses(a.store.db, b.deviceId, [bServer.url], { publicKey: bKey.public_key,
		pinnedFingerprint: bKey.fingerprint, replaceTrust: true });
	f.h.updatePeerAddresses(bStore.db, a.deviceId, [], { publicKey: aKey.public_key,
		pinnedFingerprint: aKey.fingerprint, replaceTrust: true });
	assert.equal(bStore.db.prepare("SELECT COUNT(*) AS n FROM scope_memberships WHERE scope_id=?").get(scopeId).n, 0);
	assert.equal((await f.rows("coordinator_scope_memberships")).filter(row => row.device_id === b.deviceId).length, 0);
	const managedRequest = async (server = bServer, recipientId = b.deviceId) => {
		const url = `${server.url}/v1/ops?scope_id=${scopeId}`;
		return fetch(url, { headers: { ...f.h.buildDirectPeerAuthHeaders({ deviceId: a.deviceId, dbPath: f.dbPath,
			method: "GET", url, bodyBytes: Buffer.alloc(0), keysDir: f.keysDir, recipientId }), "X-Codemem-Sync-Capability": "scoped" } });
	};
	const beforeGrant = await managedRequest();
	assert.equal(beforeGrant.status, 409);
	assert.equal((await beforeGrant.json()).reset_required, true);
	const previousKeys = process.env.CODEMEM_KEYS_DIR;
	const previousConfig = process.env.CODEMEM_CONFIG;
	process.env.CODEMEM_CONFIG = f.configPath;
	process.env.CODEMEM_KEYS_DIR = f.keysDir;
	try {
		const enrolled = await f.h.reconcileConfiguredCoordinatorEnrollment(a.store, { config });
		assert.equal(enrolled.failedGroups, 0, JSON.stringify(enrolled));
		const effects = f.h.createRecipientPolicyReconcilerEffects(a.store, { config });
		const first = await f.h.reconcileRecipientPolicyProjects(a.store, { effects, backoffMs: 0 });
		const second = await f.h.reconcileRecipientPolicyProjects(a.store, { effects, backoffMs: 0 });
		assert.ok((await f.rows("coordinator_scope_memberships")).some(row => row.device_id === b.deviceId && row.status === "active"), JSON.stringify({ first, second,
			states: a.store.db.prepare("SELECT * FROM recipient_policy_authority_states").all(), wires: bServer.wires }));
		assert.ok(bServer.wires.some(wire => wire.path === "/v1/status" && wire.status === 200 && wire.headers["x-codemem-signature"]), "Real signed capability probe missing");
		const aServer = await f.serveProfile(a.store, aPaths);
		const bConfig = f.h.readCoordinatorSyncConfig({ sync_enabled: true, sync_coordinator_url: origin, sync_coordinator_groups: [groupId], sync_advertise: bServer.url });
		await f.h.registerCoordinatorPresence(a.store, { ...config, syncAdvertise: aServer.url }, { keysDir: f.keysDir });
		await f.h.registerCoordinatorPresence(bStore, bConfig, { keysDir: b.keysDir });
		const refresh = async (store, paths, selectedConfig) => {
			const cache = await f.h.refreshScopeMembershipCache(store.db, { groupIds: [groupId], remoteUrl: origin, keysDir: paths.keysDir, dbPath: paths.dbPath });
			assert.equal(cache.status, "refreshed", JSON.stringify(cache));
			return f.h.refreshAuthorizedCoordinatorPeerTrust(store, selectedConfig, { keysDir: paths.keysDir });
		};
		// Explicitly withdraw the temporary manual A/B network approval. Current coordinator policy must relearn it.
		for (const [store, peer] of [[a.store, b.deviceId], [bStore, a.deviceId]]) {
			const removed = await f.h.syncRoutes(() => store, () => null).request(`/api/sync/peers/${peer}`, { method: "DELETE" });
			assert.equal(removed.status, 200);
		}
		await refresh(a.store, aPaths, config);
		await refresh(bStore, b, bConfig);
		const peer = (store, deviceId) => store.db.prepare("SELECT * FROM sync_peers WHERE peer_device_id=?").get(deviceId);
		assert.equal(peer(a.store, b.deviceId).trust_provenance, "coordinator_policy");
		assert.equal(peer(bStore, a.deviceId).trust_provenance, "coordinator_policy");
		const sessionA = a.store.startSession({ cwd: workspace, project: "synthetic-journey", gitRemote: projectId });
		const portableId = a.store.remember(sessionA, "discovery", "Portable managed memory", "A authored this shared fact before revocation.", 0.8, [],
			{ visibility: "shared", workspace_id: scopeId, workspace_kind: "shared", origin_source: "manual" });
		const portable = a.store.db.prepare("SELECT * FROM memory_items WHERE id=?").get(portableId);
		const synced = await f.h.syncOnce(a.store.db, b.deviceId, [bServer.url], { keysDir: f.keysDir, dbPath: f.dbPath, scanner: a.store.scanner });
		assert.equal(synced.ok, true, JSON.stringify(synced));
		const imported = bStore.db.prepare("SELECT * FROM memory_items WHERE import_key=?").get(portable.import_key);
		assert.ok(imported);
		assert.equal(imported.actor_id, portable.actor_id);
		assert.equal(imported.origin_device_id, portable.origin_device_id);
		assert.equal(imported.scope_id, scopeId);
		assert.ok(!JSON.stringify(bServer.wires).includes(workspace), "Absolute source workspace leaked over sync");
		// C is another genuinely owner-enrolled fresh-key profile, not an injected Identity or membership.
		const c = await f.createProfile("c-existing-profile");
		process.env.CODEMEM_CONFIG = c.configPath;
		delete process.env.CODEMEM_KEYS_DIR;
		const cOptions = { ...c, coordinatorUrl: origin, groupId, admissionMode: "account", fetch: f.request };
		const preparedC = await f.h.enrollOwnerProfile({ ...cOptions, mode: "prepare" });
		const cSession = await signIn(f);
		const adoptedC = await f.h.enrollOwnerProfile({ ...cOptions, mode: "resume", reviewedDigest: preparedC.reviewDigest,
			onBrowserStart: (url, details) => admitAndFinishB(f, cSession, url, details) });
		assert.equal(adoptedC.identityId, a.identityId);
		const cStore = f.openProfile(c);
		const cKey = f.profileRows(c, "sync_device")[0];
		assert.notEqual(cKey.public_key, aKey.public_key);
		assert.notEqual(cKey.public_key, bKey.public_key);
		const cServer = await f.serveProfile(cStore, c);
		const cConfig = { ...bConfig, syncAdvertise: cServer.url };
		await f.h.registerCoordinatorPresence(cStore, cConfig, { keysDir: c.keysDir });
		// Explicit B/C network pairing remains independent of A's later revocation; scope access still comes from policy.
		f.h.updatePeerAddresses(a.store.db, c.deviceId, [cServer.url], { publicKey: cKey.public_key, pinnedFingerprint: cKey.fingerprint, replaceTrust: true });
		f.h.updatePeerAddresses(cStore.db, a.deviceId, [], { publicKey: aKey.public_key, pinnedFingerprint: aKey.fingerprint, replaceTrust: true });
		f.h.updatePeerAddresses(bStore.db, c.deviceId, [cServer.url], { publicKey: cKey.public_key, pinnedFingerprint: cKey.fingerprint, replaceTrust: true });
		f.h.updatePeerAddresses(cStore.db, b.deviceId, [bServer.url], { publicKey: bKey.public_key, pinnedFingerprint: bKey.fingerprint, replaceTrust: true });
		process.env.CODEMEM_CONFIG = f.configPath;
		process.env.CODEMEM_KEYS_DIR = f.keysDir;
		assert.equal((await f.h.reconcileConfiguredCoordinatorEnrollment(a.store, { config })).failedGroups, 0);
		await f.h.reconcileRecipientPolicyProjects(a.store, { effects: f.h.createRecipientPolicyReconcilerEffects(a.store, { config }), backoffMs: 0 });
		assert.ok((await f.rows("coordinator_scope_memberships")).some(row => row.device_id === c.deviceId && row.status === "active"));
		await refresh(bStore, b, bConfig);
		await refresh(cStore, c, cConfig);
		for (const [store, peerId] of [[a.store, c.deviceId], [cStore, a.deviceId]]) {
			assert.equal((await f.h.syncRoutes(() => store, () => null).request(`/api/sync/peers/${peerId}`, { method: "DELETE" })).status, 200);
		}
		await refresh(a.store, aPaths, config);
		await refresh(cStore, c, cConfig);
		const independentTrust = peer(bStore, c.deviceId).trust_provenance;
		assert.notEqual(independentTrust, "coordinator_policy");
		const revokeOptions = { remoteUrl: origin, adminSecret: f.adminSecret, groupId, deviceId: a.deviceId };
		const preview = await f.h.coordinatorRevokeDeviceAction(revokeOptions);
		assert.equal(preview.state, "ready");
		await assert.rejects(f.h.coordinatorRevokeDeviceAction({ ...revokeOptions, expectedDigest: "0".repeat(64), expectedContext: { coordinatorId: preview.coordinator_id, keyId: preview.key_id } }));
		const revoked = await f.h.coordinatorRevokeDeviceAction({ ...revokeOptions, expectedDigest: preview.expected_digest,
			expectedContext: { coordinatorId: preview.coordinator_id, keyId: preview.key_id } });
		assert.equal(revoked.state, "revoked");
		assert.deepEqual(revoked.revocations.map(row => row.subject_kind).sort(), ["device_id", "ed25519_key"]);
		const tombstones = await f.rows("coordinator_device_revocations");
		assert.equal(tombstones.length, 2);
		assert.deepEqual(tombstones.map(row => row.subject_kind).sort(), ["device_id", "ed25519_key"]);
		const url = `${origin}/v1/peers?group_id=${groupId}`;
		const deniedA = await f.request(url, { headers: f.h.buildAuthHeaders({ deviceId: a.deviceId, dbPath: f.dbPath, method: "GET", url, bodyBytes: Buffer.alloc(0), keysDir: f.keysDir }) });
		assert.equal(deniedA.status, 403);
		assert.equal((await deniedA.json()).error, "device_revoked");
		const enabled = await f.admin("/v1/admin/devices/enable", { group_id: groupId, device_id: a.deviceId });
		assert.equal(enabled.status, 404);
		assert.equal((await enabled.json()).error, "device_not_found");
		const retryInvite = await f.request(`${origin}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
			token: a.invite.payload.token, device_id: a.deviceId, public_key: aKey.public_key, fingerprint: aKey.fingerprint,
			invite_kind: "team_member", identity_id: a.identityId, recipient_display_name: "Synthetic owner", device_display_name: "Synthetic A" }) });
		assert.equal(retryInvite.status, 403);
		assert.equal((await retryInvite.json()).error, "device_revoked");
		assert.deepEqual(await f.rows("coordinator_device_revocations"), tombstones);
		// Historical enrollment rows need not be deleted or rewritten: global tombstones decide admission.
		const stillDeniedA = await f.request(url, { headers: f.h.buildAuthHeaders({ deviceId: a.deviceId, dbPath: f.dbPath, method: "GET", url, bodyBytes: Buffer.alloc(0), keysDir: f.keysDir }) });
		assert.equal(stillDeniedA.status, 403);
		assert.equal((await stillDeniedA.json()).error, "device_revoked");
		const refreshedB = await refresh(bStore, b, bConfig);
		assert.ok(refreshedB.peers.every(row => row.device_id !== a.deviceId));
		assert.ok(!peer(bStore, a.deviceId)?.public_key);
		assert.equal(peer(bStore, c.deviceId).trust_provenance, independentTrust);
		const deniedCacheA = await f.h.refreshScopeMembershipCache(a.store.db, { groupIds: [groupId], remoteUrl: origin, keysDir: f.keysDir, dbPath: f.dbPath });
		assert.equal(deniedCacheA.status, "stale");
		await assert.rejects(f.h.refreshAuthorizedCoordinatorPeerTrust(a.store, config, { keysDir: f.keysDir }), /403: device_revoked/);
		const deniedSync = await f.h.syncOnce(a.store.db, b.deviceId, [bServer.url], { keysDir: f.keysDir, dbPath: f.dbPath, scanner: a.store.scanner });
		assert.equal(deniedSync.ok, false, JSON.stringify(deniedSync));
		assert.equal((await managedRequest()).status, 401);
		await refresh(cStore, c, cConfig);
		assert.ok(!peer(cStore, a.deviceId)?.public_key);
		assert.equal((await managedRequest(cServer, c.deviceId)).status, 401);
		process.env.CODEMEM_CONFIG = b.configPath;
		process.env.CODEMEM_KEYS_DIR = b.keysDir;
		const sessionB = bStore.startSession({ cwd: workspace, project: "synthetic-journey", gitRemote: projectId });
		f.h.upsertProjectScopeSettingsMappings(bStore.db, [{ workspace_identity: workspace, project_pattern: workspace, scope_id: scopeId, source: "user", priority: 100 }], { deviceId: b.deviceId });
		const continuedId = bStore.remember(sessionB, "discovery", "B continues after A revocation", "B and C retain current policy access.", 0.8, [],
			{ visibility: "shared", workspace_id: scopeId, workspace_kind: "shared", origin_source: "manual" });
		const continued = bStore.db.prepare("SELECT * FROM memory_items WHERE id=?").get(continuedId);
		const continuedSync = await f.h.syncOnce(bStore.db, c.deviceId, [cServer.url], { keysDir: b.keysDir, dbPath: b.dbPath, scanner: bStore.scanner });
		assert.equal(continuedSync.ok, true, JSON.stringify(continuedSync));
		assert.equal(cStore.db.prepare("SELECT actor_id FROM memory_items WHERE import_key=?").get(continued.import_key).actor_id, continued.actor_id);
		const retained = peer(a.store, b.deviceId);
		// A's failed refresh is not a successful current snapshot omitting B. Offline evidence remains cached;
		// it cannot override B/C's independently refreshed receiving authorization (both signed requests denied above).
		assert.equal(retained.trust_provenance, "coordinator_policy");
		assert.equal(retained.public_key, bKey.public_key);
		assert.equal(retained.pinned_fingerprint, bKey.fingerprint);
		assert.equal(deniedCacheA.status, "stale");
	} finally {
		process.env.CODEMEM_CONFIG = previousConfig;
		if (previousKeys === undefined) delete process.env.CODEMEM_KEYS_DIR;
		else process.env.CODEMEM_KEYS_DIR = previousKeys;
	}
}

for (const { lostFinalReply, managed } of [{ lostFinalReply: false, managed: false }, { lostFinalReply: true, managed: false }, { lostFinalReply: false, managed: true }]) {
test(`qualification enables existing-profile B account enrollment, preserving keys and original authors (lost final reply: ${lostFinalReply}, managed journey: ${managed})`, async t => {
	// Arrange: A first links by device claim, then an actual operator separately reviews and grants transport.
	const f = await journeyFixture(t);
	const a = await linkedA(f, { managed });
	const aBefore = history(a.store);
	const linksBefore = await f.rows("coordinator_auth_account_links");
	const attestationId = await reviewAndGrant(f, a);
	const grants = await f.rows("coordinator_identity_group_grants");
	const scopeMemberships = await f.rows("coordinator_scope_memberships");
	const b = await f.createProfile("b-existing-profile");
	const before = ["sync_device", "sessions", "memory_items", "replication_ops", "policy_team_memberships", "project_recipients", "scope_memberships"]
		.map(table => f.profileRows(b, table));
	assert.equal(before[2].length, 1);
	assert.equal(before[2][0].actor_id, `local:${b.deviceId}`);
	assert.notEqual(before[2][0].actor_id, a.identityId);
	const keys = await Promise.all(["device.key", "device.key.pub"].map(name => readFile(join(b.keysDir, name), "utf8")));
	assert.notEqual(keys[1].trim(), f.publicKey);
	assert.notEqual(b.deviceId, a.deviceId);
	assert.deepEqual(f.profileRows(b, "identity_devices"), []);
	assert.deepEqual(f.profileRows(b, "actors").filter(row => row.is_local === 1).map(row => row.actor_id), [`local:${b.deviceId}`]);
	const session = await signIn(f);
	const previousConfig = process.env.CODEMEM_CONFIG;
	process.env.CODEMEM_CONFIG = b.configPath;
	try {
		const finalBodies = [];
		let dropFinalReply = lostFinalReply;
		const fetch = async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).pathname === "/v1/auth/owner-attempts/finalize") {
				finalBodies.push(await request.clone().text());
				const response = await f.request(request);
				assert.equal(response.status, 200, await response.clone().text());
				if (dropFinalReply) { dropFinalReply = false; throw new Error("Synthetic lost final reply after server commit"); }
				return response;
			}
			return f.request(request);
		};
		const options = { ...b, coordinatorUrl: origin, groupId, admissionMode: "account", fetch };
		const prepared = await f.h.enrollOwnerProfile({ ...options, mode: "prepare" });
		assert.equal(prepared.kind, "prepared");
		// Act/Assert: the authenticated account and existing transport grant are insufficient before qualification.
		const denied = await f.request(`${origin}/auth/owner/admit`, { headers: { cookie: session } });
		assert.equal(denied.status, 403, await denied.clone().text());
		assert.deepEqual(await f.rows("coordinator_owner_enrollment_attempts"), []);
		assert.deepEqual(await f.rows("coordinator_device_ownership_bindings"), []);
		assert.deepEqual(f.profileRows(b, "identity_devices"), []);
		assert.equal(JSON.parse(await readFile(b.configPath, "utf8")).actor_id, undefined);
		// Act: preview is read-only; a wrong digest refuses; exact operator confirmation qualifies the live claim.
		const preview = await f.admin("/v1/admin/owner-qualifications", { attestation_id: attestationId });
		assert.equal(preview.status, 200, await preview.clone().text());
		const { evidence_digest } = await preview.json();
		assert.deepEqual(await f.rows("coordinator_owner_enrollment_qualifications"), []);
		const stale = await f.admin("/v1/admin/owner-qualifications", { attestation_id: attestationId, confirm_evidence_digest: "0".repeat(64) });
		assert.equal(stale.status, 409);
		assert.deepEqual(await f.rows("coordinator_owner_enrollment_qualifications"), []);
		const qualified = await f.admin("/v1/admin/owner-qualifications", { attestation_id: attestationId, confirm_evidence_digest: evidence_digest });
		assert.equal(qualified.status, 201, await qualified.clone().text());
		assert.equal((await qualified.json()).evidence_digest, evidence_digest);
		const qualifications = await f.rows("coordinator_owner_enrollment_qualifications");
		assert.equal(qualifications.length, 1);
		assert.equal(qualifications[0].controller_attestation_id, attestationId);
		assert.equal(qualifications[0].link_id, linksBefore[0].link_id);
		assert.equal(qualifications[0].device_claim_id, (await f.rows("coordinator_auth_device_claims"))[0].claim_id);
		assert.deepEqual(await f.rows("coordinator_identity_group_grants"), grants);
		// Actual fixed upload URL, management sign-in, fresh owner-purpose OIDC, confirmation and native loopback.
		let browserError;
		const resume = { ...options, mode: "resume", reviewedDigest: prepared.reviewDigest,
			onBrowserStart: async (url, details) => {
				try { await admitAndFinishB(f, session, url, details); }
				catch (error) { browserError = error; throw error; }
			} };
		if (lostFinalReply) {
			await assert.rejects(f.h.enrollOwnerProfile(resume), { code: "retained_request_incomplete" });
			if (browserError) throw browserError;
			assert.equal((await f.rows("coordinator_device_ownership_bindings")).length, 1);
			assert.deepEqual(f.profileRows(b, "identity_devices"), []);
			assert.equal(JSON.parse(await readFile(b.configPath, "utf8")).actor_id, undefined);
			// The core client closed its database. A new call reopens the saved profile and exact final request;
			// this is file/database reopen coverage, not a new OS process or Commander CLI proof.
			resume.onBrowserStart = undefined;
		}
		const result = await f.h.enrollOwnerProfile(resume).catch(error => { throw browserError ?? error; });
		// Assert: only the real signed finalization receipt may adopt A's assigned Identity into B.
		assert.equal(result.kind, "adopted");
		assert.equal(result.identityId, a.identityId);
		const receipt = JSON.parse(await readFile(join(b.stateDir, "receipt.json"), "utf8")).receipt;
		assert.equal(receipt.identityId, a.identityId);
		assert.equal(receipt.bindingId, result.bindingId);
		assert.deepEqual(receipt.groups, [groupId]);
		assert.equal(receipt.kind, lostFinalReply ? "prior_commit" : "finalized");
		assert.equal(finalBodies.length, lostFinalReply ? 2 : 1);
		assert.ok(finalBodies.every(body => body === finalBodies[0]));
		assert.equal(JSON.parse(await readFile(join(b.stateDir, "final.json"), "utf8")).body, finalBodies[0]);
		assert.equal(JSON.parse(await readFile(b.configPath, "utf8")).actor_id, a.identityId);
		assert.equal(f.profileRows(b, "identity_devices")[0].identity_id, a.identityId);
		assert.deepEqual(["sync_device", "sessions", "memory_items", "replication_ops", "policy_team_memberships", "project_recipients", "scope_memberships"]
			.map(table => f.profileRows(b, table)), before);
		assert.deepEqual(await Promise.all(["device.key", "device.key.pub"].map(name => readFile(join(b.keysDir, name), "utf8"))), keys);
		assert.deepEqual(history(a.store), aBefore);
		assert.deepEqual(await f.rows("coordinator_auth_account_links"), linksBefore);
		assert.deepEqual(await f.rows("coordinator_identity_group_grants"), grants);
		assert.deepEqual(await f.rows("coordinator_scope_memberships"), scopeMemberships);
		const enrolled = (await f.rows("enrolled_devices")).find(row => row.device_id === b.deviceId);
		assert.equal(enrolled.identity_id, a.identityId);
		assert.equal(enrolled.public_key, keys[1].trim());
		assert.equal((await f.rows("coordinator_owner_enrollment_audit_log")).length, 1);
		if (managed) await managedJourney(f, a, b);
	} finally { process.env.CODEMEM_CONFIG = previousConfig; }
});
}
