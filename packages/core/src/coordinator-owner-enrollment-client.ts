import { randomBytes, randomUUID, sign } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createCoordinatorOwnerEnrollmentReceiver } from "./coordinator-account-link-receiver.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	ownerEnrollmentFinalMessage,
	verifyOwnerEnrollmentSignature,
} from "./coordinator-owner-enrollment-proof.js";
import { connect, type Database, tableExists } from "./db.js";
import { assignIdentityDeviceInTransaction } from "./identity-device-assignment.js";
import { atomicReplaceConfigFile, writeCodememConfigFile } from "./observer-config.js";
import {
	type OwnerEnrollmentReceipt,
	type OwnerEnrollmentStart,
	ownerEnrollmentHash,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";
import { assertAddDeviceIdentityAdoptionAllowed } from "./recipient-policy-onboarding.js";
import { MemoryStore } from "./store.js";
import { ensureDeviceIdentity, loadPrivateKey, loadPublicKey } from "./sync-identity.js";

export interface OwnerEnrollmentOptions {
	profileDir: string;
	coordinatorUrl: string;
	groupId: string;
	openBrowser: (
		privateURL: string,
		publicKeyContext: { deviceId: string; fingerprint: string },
	) => Promise<void> | void;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	resume?: boolean;
}
type Pins = { coordinatorId: string; origin: string; issuer: string; revision: string };
type Retained = {
	pins: Pins;
	groupId: string;
	deviceId: string;
	publicKey: string;
	keyId: string;
	confirmationHash: string;
	body: string;
};
const MARKER = "codemem-isolated-owner-pilot-v1";
const CONFIG_LOCK_REFUSAL =
	"Owner pilot config lock is unknown or unverifiable. Keep the profile unchanged for operator review; automatic lock removal is refused.";
const EMPTY_TABLES =
	`memory_items raw_events raw_event_sessions sessions sync_peers policy_teams policy_team_memberships policy_team_device_decisions project_recipients recipient_policy_review_resolutions recipient_policy_authority_states recipient_policy_deny_overlays recipient_policy_reconciliation_steps recipient_managed_project_projections share_operations project_scope_mappings scope_memberships replication_scopes device_identity_binding_commits device_identity_binding_audit raw_event_flush_batches raw_event_ingest_samples raw_event_ingest_stats opencode_sessions pi_import_state user_prompts session_summaries artifacts memory_file_refs memory_concept_refs usage_events retrieval_attempts retrieval_exposures outcome_evidence attribution_assessments maintenance_jobs replication_ops replication_cursors replication_cursors_v2 sync_nonces sync_attempts sync_peer_signature_state coordinator_group_preferences legacy_team_setup_drafts legacy_team_setup_completions legacy_team_setup_draft_devices legacy_team_setup_draft_projects`.split(
		" ",
	);
function fail(): never {
	throw new Error(
		"Owner pilot validation failed; retain the isolated profile and retry only its saved final request.",
	);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
	return value as Record<string, unknown>;
}
function id(value: unknown): string {
	if (!isAuthControllerId(value)) return fail();
	return value;
}
function origin(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(value !== url.origin && value !== `${url.origin}/`)
	)
		return fail();
	return url.origin;
}
function pins(value: unknown, expectedOrigin: string): Pins {
	const p = object(value);
	if (p.origin !== expectedOrigin || p.issuer !== "https://accounts.google.com") return fail();
	return {
		coordinatorId: id(p.coordinatorId),
		origin: expectedOrigin,
		issuer: p.issuer,
		revision: id(p.revision),
	};
}
function privateFile(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) fail();
}
function persist(path: string, value: unknown): void {
	const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(value));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	// Hard-link publication cannot replace any previously retained request or receipt.
	linkSync(temp, path);
	unlinkSync(temp);
	fsyncDirectory(resolve(path, ".."));
}
function fsyncDirectory(path: string): void {
	const dir = openSync(path, "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}
function prepareProfile(options: OwnerEnrollmentOptions) {
	const dir = resolve(options.profileDir);
	const config = join(dir, "config.json");
	// MemoryStore's maintained constructor reads process config. Never change shared process env.
	if (
		resolve(process.env.CODEMEM_CONFIG ?? "") !== config ||
		process.env.CODEMEM_ACTOR_ID !== undefined ||
		process.env.CODEMEM_DEVICE_ID !== undefined ||
		process.env.CODEMEM_SYNC_KEY_STORE?.toLowerCase() === "keychain"
	)
		fail();
	if (!options.resume) {
		mkdirSync(dir, { mode: 0o700 });
		persist(join(dir, "owner-pilot.json"), { kind: MARKER });
	} else {
		const stat = lstatSync(dir);
		if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) fail();
		privateFile(join(dir, "owner-pilot.json"));
		if (object(JSON.parse(readFileSync(join(dir, "owner-pilot.json"), "utf8"))).kind !== MARKER)
			fail();
	}
	assertProfileFiles(dir, { resume: options.resume === true });
	if (
		options.resume &&
		!["mem.sqlite", "keys/device.key", "keys/device.key.pub"].every((name) =>
			existsSync(join(dir, name)),
		)
	)
		fail();
	return {
		dir,
		config,
		db: join(dir, "mem.sqlite"),
		keys: join(dir, "keys"),
		retained: join(dir, "owner-finalize.json"),
	};
}
function assertProfileFiles(dir: string, options: { resume: boolean }): void {
	const stale: string[] = [];
	for (const name of readdirSync(dir)) {
		const temp =
			/^(?:owner-finalize\.json|owner-receipt\.json|config\.json|config\.json\.lock)\.tmp-([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(
				name,
			);
		if (temp) {
			if (!options.resume) fail();
			privateFile(join(dir, name));
			assertStaleProcess(Number(temp[1]));
			stale.push(name);
			continue;
		}
		if (name === "config.json.lock") {
			const lock = readPilotConfigLock(join(dir, name));
			assertStaleProcess(lock.record.pid);
			continue;
		}
		if (
			![
				"owner-pilot.json",
				"owner-finalize.json",
				"owner-receipt.json",
				"mem.sqlite",
				"mem.sqlite-wal",
				"mem.sqlite-shm",
				"config.json",
				"keys",
			].includes(name) ||
			lstatSync(join(dir, name)).isSymbolicLink()
		)
			fail();
	}
	assertProfileKeys(dir);
	for (const name of stale) {
		privateFile(join(dir, name));
		unlinkSync(join(dir, name));
	}
	if (stale.length) fsyncDirectory(dir);
}
function assertProfileKeys(dir: string): void {
	const keys = join(dir, "keys");
	if (!existsSync(keys)) return;
	if (!lstatSync(keys).isDirectory()) fail();
	for (const name of readdirSync(keys)) {
		const stat = lstatSync(join(keys, name));
		if (!["device.key", "device.key.pub"].includes(name) || !stat.isFile() || stat.isSymbolicLink())
			fail();
	}
}
function assertStaleProcess(pid: number): void {
	if (!Number.isSafeInteger(pid) || pid <= 0) fail();
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		fail();
	}
	fail();
}
/** Creates only a new disposable profile; no ownership binding or memory is added. */
export function initializeOwnerPilotProfile(
	profileDir: string,
	options: { displayName?: string } = {},
) {
	const displayName = options.displayName?.trim() || "Owner pilot device";
	if (displayName.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(displayName)) fail();
	const paths = prepareProfile({
		profileDir,
		coordinatorUrl: "",
		groupId: "",
		openBrowser: () => undefined,
	});
	const db = connect(paths.db);
	try {
		assertFresh(db);
		const [deviceId] = ensureDeviceIdentity(db, { keysDir: paths.keys });
		const publicKey = loadPublicKey(paths.keys);
		if (!publicKey || !loadPrivateKey(paths.keys, paths.db, deviceId)) return fail();
		const initialActorId = `local:${deviceId}`;
		assertAddDeviceIdentityAdoptionAllowed(db, initialActorId, deviceId);
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, ?, 1, 'active', ?, ?)",
		).run(initialActorId, displayName, now, now);
		writeCodememConfigFile(
			{ actor_id: initialActorId, actor_display_name: displayName, sync_device_name: displayName },
			paths.config,
		);
		return { ...paths, deviceId, publicKey, initialActorId };
	} finally {
		db.close();
	}
}
function assertFresh(
	db: Database,
	deviceId?: string,
	receipt?: OwnerEnrollmentReceipt,
	source?: string,
): void {
	for (const table of EMPTY_TABLES) {
		if (tableExists(db, table) && db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()) fail();
	}
	if (!deviceId) return;
	if (Number(db.prepare("SELECT COUNT(*) FROM sync_device").pluck().get()) !== 1) fail();
	assertActors(db, deviceId, receipt);
	assertAddDeviceIdentityAdoptionAllowed(db, receipt?.identityId ?? `local:${deviceId}`, deviceId);
	const bindings = db.prepare("SELECT * FROM identity_devices").all() as Array<
		Record<string, unknown>
	>;
	if (
		bindings.length &&
		(bindings.length !== 1 ||
			!receipt ||
			bindings[0]?.device_id !== deviceId ||
			bindings[0]?.identity_id !== receipt.identityId ||
			bindings[0]?.source_fingerprint !== source ||
			bindings[0]?.provenance !== "user_confirmed_identity_setup" ||
			bindings[0]?.status !== "active")
	)
		fail();
}
function assertActors(db: Database, deviceId: string, receipt?: OwnerEnrollmentReceipt): void {
	const actors = db
		.prepare("SELECT actor_id, is_local, status, merged_into_actor_id FROM actors")
		.all() as Array<{
		actor_id: string;
		is_local: number;
		status: string;
		merged_into_actor_id: string | null;
	}>;
	for (const actor of actors) {
		if (
			actor.actor_id === receipt?.identityId &&
			actor.is_local === 1 &&
			actor.status === "active" &&
			actor.merged_into_actor_id === null
		)
			continue;
		if (actor.actor_id !== `local:${deviceId}`) fail();
		if (actor.is_local === 1 && actor.status === "active" && actor.merged_into_actor_id === null)
			continue;
		if (
			!receipt ||
			actor.is_local !== 0 ||
			actor.status !== "merged" ||
			actor.merged_into_actor_id !== receipt.identityId
		)
			fail();
	}
}
async function request(
	options: OwnerEnrollmentOptions,
	url: string,
	body?: string,
): Promise<unknown> {
	try {
		const response = await (options.fetch ?? globalThis.fetch)(url, {
			method: body === undefined ? "GET" : "POST",
			body,
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			redirect: "error",
			signal: options.signal,
		});
		if (!response.ok || response.redirected || (response.url && response.url !== url))
			return fail();
		return await response.json();
	} catch {
		throw new Error(
			"Owner pilot response unavailable; any saved final request must be retried unchanged.",
		);
	}
}
function receipt(value: unknown, groupId: string): OwnerEnrollmentReceipt {
	const r = object(value);
	if (
		(r.kind !== "finalized" && r.kind !== "prior_commit") ||
		!Array.isArray(r.groups) ||
		r.groups.length < 1 ||
		r.groups.length > 50
	)
		return fail();
	const groups = r.groups.map(id);
	if (new Set(groups).size !== groups.length || !groups.includes(groupId)) return fail();
	return { kind: r.kind, bindingId: id(r.bindingId), identityId: id(r.identityId), groups };
}
async function retainedRequest(
	path: string,
	o: OwnerEnrollmentOptions,
	p: Pins,
	deviceId: string,
	publicKey: string,
	keyId: string,
): Promise<Retained> {
	privateFile(path);
	const r = object(JSON.parse(readFileSync(path, "utf8")));
	const savedPins = pins(r.pins, p.origin);
	if (
		savedPins.coordinatorId !== p.coordinatorId ||
		r.groupId !== o.groupId ||
		r.deviceId !== deviceId ||
		r.publicKey !== publicKey ||
		r.keyId !== keyId ||
		typeof r.body !== "string" ||
		typeof r.confirmationHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(r.confirmationHash)
	)
		return fail();
	const saved = {
		pins: savedPins,
		groupId: o.groupId,
		deviceId,
		publicKey,
		keyId,
		body: r.body,
		confirmationHash: r.confirmationHash,
	};
	const b = object(JSON.parse(saved.body));
	if (
		Object.keys(b).sort().join() !== "attemptId,completionSecret,signature" ||
		typeof b.completionSecret !== "string" ||
		typeof b.signature !== "string"
	)
		return fail();
	if (
		!(await verifyOwnerEnrollmentSignature(
			publicKey,
			await finalMessage(saved, id(b.attemptId), b.completionSecret),
			b.signature,
		))
	)
		return fail();
	return saved;
}
async function finalMessage(
	r: Omit<Retained, "body">,
	attemptId: string,
	completionSecret: string,
): Promise<string> {
	return ownerEnrollmentFinalMessage(
		{
			coordinator_id: r.pins.coordinatorId,
			origin: r.pins.origin,
			auth_config_revision: r.pins.revision,
			issuer: r.pins.issuer,
			attempt_id: attemptId,
			device_id: r.deviceId,
			public_key: r.publicKey,
			key_id: r.keyId,
			fingerprint: await ownerEnrollmentHash(r.publicKey),
			confirmation_hash: r.confirmationHash,
		},
		completionSecret,
	);
}
function receiverSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(600000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function assertKeyContext(options: {
	paths: ReturnType<typeof prepareProfile>;
	db: Database;
	deviceId: string;
	publicKey: string;
	privateKey: Buffer;
	keyId: string;
}): Buffer {
	const rows = options.db.prepare("SELECT device_id, public_key FROM sync_device").all() as Array<{
		device_id: string;
		public_key: string;
	}>;
	if (
		rows.length !== 1 ||
		rows[0]?.device_id !== options.deviceId ||
		rows[0]?.public_key !== options.publicKey ||
		loadPublicKey(options.paths.keys) !== options.publicKey
	)
		fail();
	const current = loadPrivateKey(options.paths.keys, options.paths.db, options.deviceId);
	if (!current?.equals(options.privateKey)) fail();
	return current;
}
async function start(
	options: OwnerEnrollmentOptions,
	p: Pins,
	deviceId: string,
	publicKey: string,
	keyId: string,
	keyContext: Parameters<typeof assertKeyContext>[0],
): Promise<Retained> {
	const attemptId = randomUUID();
	const receiver = await createCoordinatorOwnerEnrollmentReceiver({
		attemptId,
		host: "127.0.0.1",
		signal: receiverSignal(options.signal),
	});
	// Install rejection handling before opening a browser or issuing the signed start.
	void receiver.completion.catch(() => undefined);
	try {
		const body: OwnerEnrollmentStart = {
			attemptId,
			deviceId,
			publicKey,
			loopbackRedirect: receiver.destination,
			browserStartCode: randomBytes(32).toString("base64url"),
			signature: "",
		};
		body.signature = sign(
			null,
			Buffer.from(ownerEnrollmentStartMessage(body, p)),
			assertKeyContext(keyContext),
		).toString("base64url");
		const response = object(
			await request(options, `${p.origin}/v1/auth/owner-attempts`, JSON.stringify(body)),
		);
		if (
			response.kind !== "started" ||
			response.attemptId !== attemptId ||
			!Number.isSafeInteger(response.expiresAtMs)
		)
			return fail();
		const query = new URLSearchParams({ attempt_id: attemptId, start_code: body.browserStartCode });
		await options.openBrowser(`${p.origin}/auth/owner/start?${query}`, {
			deviceId,
			fingerprint: await ownerEnrollmentHash(publicKey),
		});
		const completion = await receiver.completion;
		assertKeyContext(keyContext);
		const r = {
			pins: p,
			groupId: options.groupId,
			deviceId,
			publicKey,
			keyId,
			confirmationHash: completion.confirmationHash,
		};
		const signature = sign(
			null,
			Buffer.from(await finalMessage(r, attemptId, completion.completionSecret)),
			assertKeyContext(keyContext),
		).toString("base64url");
		return {
			...r,
			body: JSON.stringify({ attemptId, completionSecret: completion.completionSecret, signature }),
		};
	} finally {
		await receiver.close();
	}
}
function adopt(
	db: Database,
	deviceId: string,
	r: OwnerEnrollmentReceipt,
	source: string,
	labels: { actor_display_name: string; sync_device_name: string },
): void {
	db.transaction(() => {
		assertFresh(db, deviceId, r, source);
		if (db.prepare("SELECT 1 FROM identity_devices WHERE device_id = ?").get(deviceId)) return;
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE actors SET is_local = 0, status = 'merged', merged_into_actor_id = ?, updated_at = ? WHERE is_local = 1 AND actor_id <> ?",
		).run(r.identityId, now, r.identityId);
		db.prepare(
			"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, ?, 1, 'active', ?, ?) ON CONFLICT(actor_id) DO NOTHING",
		).run(r.identityId, labels.actor_display_name, now, now);
		assignIdentityDeviceInTransaction(db, {
			deviceId,
			targetIdentityId: r.identityId,
			expectation: { kind: "absent" },
			insert: {
				displayName: labels.sync_device_name,
				provenance: "user_confirmed_identity_setup",
				revision: r.bindingId,
				migrationState: "user_managed",
				sourceFingerprint: source,
				idempotencyKey: source,
			},
		});
	}).immediate();
}
/** Isolated opt-in only. The caller launches with CODEMEM_CONFIG=<profileDir>/config.json. */
export async function runOwnerEnrollment(
	options: OwnerEnrollmentOptions,
): Promise<OwnerEnrollmentReceipt> {
	try {
		return await run(options);
	} catch (error) {
		if (error instanceof Error && error.message === CONFIG_LOCK_REFUSAL) throw error;
		throw new Error(
			"Owner pilot incomplete. Keep the isolated profile; resume its saved final request unchanged. Before a final request exists, abandon only this disposable profile.",
		);
	}
}
async function preflight(
	paths: ReturnType<typeof prepareProfile>,
	options: OwnerEnrollmentOptions,
	db: Database,
) {
	assertFresh(db);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir: paths.keys });
	const publicKey = loadPublicKey(paths.keys);
	const privateKey = loadPrivateKey(paths.keys, paths.db, deviceId);
	const keyId = publicKey && (await ed25519KeyId(publicKey));
	if (!publicKey || !privateKey || !keyId) return fail();
	privateFile(paths.config);
	const configText = readFileSync(paths.config, "utf8");
	const configNode = lstatSync(paths.config, { bigint: true });
	const config = object(JSON.parse(configText));
	let previous: OwnerEnrollmentReceipt | undefined;
	if (existsSync(join(paths.dir, "owner-receipt.json"))) {
		privateFile(join(paths.dir, "owner-receipt.json"));
		previous = receipt(
			JSON.parse(readFileSync(join(paths.dir, "owner-receipt.json"), "utf8")),
			options.groupId,
		);
	}
	let saved: Retained | undefined;
	if (options.resume) {
		privateFile(paths.retained);
		const p = pins(
			object(JSON.parse(readFileSync(paths.retained, "utf8"))).pins,
			origin(options.coordinatorUrl),
		);
		saved = await retainedRequest(paths.retained, options, p, deviceId, publicKey, keyId);
	}
	const source = previous && saved && (await adoptionSource(saved.pins, previous, deviceId, keyId));
	assertFresh(db, deviceId, previous, source || undefined);
	const labels = profileLabels(config, { deviceId, previous, options });
	if (existsSync(`${paths.config}.lock`))
		reclaimPilotConfigLock({ paths, db, deviceId, publicKey, privateKey, keyId }, previous);
	return {
		deviceId,
		publicKey,
		privateKey,
		keyId,
		previous,
		saved,
		labels,
		configText,
		configNode,
	};
}
function profileLabels(
	config: Record<string, unknown>,
	context: { deviceId: string; previous?: OwnerEnrollmentReceipt; options: OwnerEnrollmentOptions },
) {
	const { deviceId, previous, options } = context;
	if (
		Object.keys(config).some(
			(key) =>
				![
					"actor_id",
					"actor_display_name",
					"sync_device_name",
					"sync_coordinator_url",
					"sync_coordinator_group",
				].includes(key),
		) ||
		(config.actor_id !== undefined &&
			config.actor_id !== previous?.identityId &&
			config.actor_id !== `local:${deviceId}`) ||
		(config.sync_coordinator_url !== undefined &&
			config.sync_coordinator_url !== origin(options.coordinatorUrl)) ||
		(config.sync_coordinator_group !== undefined &&
			config.sync_coordinator_group !== options.groupId)
	)
		fail();
	return {
		actor_display_name: profileLabel(config.actor_display_name),
		sync_device_name: profileLabel(config.sync_device_name),
	};
}
function profileLabel(value: unknown): string {
	if (value === undefined) return "Owner pilot device";
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value !== value.trim() ||
		value.length > 200 ||
		/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	)
		return fail();
	return value;
}
function adoptionSource(p: Pins, r: OwnerEnrollmentReceipt, deviceId: string, keyId: string) {
	return ownerEnrollmentHash(
		JSON.stringify([
			"owner-pilot-adoption-v1",
			p.coordinatorId,
			r.bindingId,
			r.identityId,
			deviceId,
			keyId,
		]),
	);
}
function readPilotConfigLock(path: string) {
	try {
		privateFile(path);
		const text = readFileSync(path, "utf8");
		const node = lstatSync(path, { bigint: true });
		const value = object(JSON.parse(text));
		if (Object.keys(value).sort().join() !== "bindingId,deviceId,keyId,ownerToken,pid,purpose")
			fail();
		if (
			value.purpose !== "owner-pilot-config-v1" ||
			typeof value.pid !== "number" ||
			!Number.isSafeInteger(value.pid) ||
			value.pid <= 0 ||
			typeof value.ownerToken !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
				value.ownerToken,
			)
		)
			fail();
		return {
			text,
			node,
			record: {
				purpose: value.purpose,
				pid: value.pid,
				ownerToken: value.ownerToken,
				deviceId: id(value.deviceId),
				bindingId: id(value.bindingId),
				keyId: id(value.keyId),
			},
		};
	} catch {
		throw new Error(CONFIG_LOCK_REFUSAL);
	}
}
function assertFileSnapshot(
	path: string,
	snapshot: { text: string; node: { dev: bigint; ino: bigint; ctimeNs: bigint } },
): void {
	privateFile(path);
	const current = lstatSync(path, { bigint: true });
	if (
		current.dev !== snapshot.node.dev ||
		current.ino !== snapshot.node.ino ||
		current.ctimeNs !== snapshot.node.ctimeNs ||
		readFileSync(path, "utf8") !== snapshot.text
	)
		fail();
}
function reclaimPilotConfigLock(
	context: Parameters<typeof assertKeyContext>[0],
	receipt?: OwnerEnrollmentReceipt,
): void {
	const path = `${context.paths.config}.lock`;
	const lock = readPilotConfigLock(path);
	assertStaleProcess(lock.record.pid);
	assertKeyContext(context);
	if (
		!receipt ||
		lock.record.deviceId !== context.deviceId ||
		lock.record.bindingId !== receipt.bindingId ||
		lock.record.keyId !== context.keyId
	)
		fail();
	assertFileSnapshot(path, lock);
	unlinkSync(path);
	fsyncDirectory(context.paths.dir);
}
function writePilotConfig(
	context: Parameters<typeof assertKeyContext>[0],
	receipt: OwnerEnrollmentReceipt,
	snapshot: Pick<Awaited<ReturnType<typeof preflight>>, "configText" | "configNode">,
	config: Record<string, unknown>,
): void {
	const path = `${context.paths.config}.lock`;
	const ownerToken = randomUUID();
	assertKeyContext(context);
	persist(path, {
		purpose: "owner-pilot-config-v1",
		pid: process.pid,
		ownerToken,
		deviceId: context.deviceId,
		bindingId: receipt.bindingId,
		keyId: context.keyId,
	});
	const lock = readPilotConfigLock(path);
	if (lock.record.ownerToken !== ownerToken) fail();
	try {
		const verify = () => {
			assertKeyContext(context);
			assertFileSnapshot(path, lock);
			assertFileSnapshot(context.paths.config, {
				text: snapshot.configText,
				node: snapshot.configNode,
			});
		};
		verify();
		atomicReplaceConfigFile(
			context.paths.config,
			`${JSON.stringify(config, null, 2)}\n`,
			0o600,
			undefined,
			verify,
			{ followSymlink: false },
		);
	} finally {
		assertFileSnapshot(path, lock);
		unlinkSync(path);
		fsyncDirectory(context.paths.dir);
	}
}
function writeAndReopen(
	paths: ReturnType<typeof prepareProfile>,
	r: OwnerEnrollmentReceipt,
	deviceId: string,
	options: OwnerEnrollmentOptions,
	p: Pins,
	labels: { actor_display_name: string; sync_device_name: string },
	context: Parameters<typeof assertKeyContext>[0],
	configSnapshot: Pick<Awaited<ReturnType<typeof preflight>>, "configText" | "configNode">,
) {
	writePilotConfig(context, r, configSnapshot, {
		...labels,
		actor_id: r.identityId,
		sync_coordinator_url: p.origin,
		sync_coordinator_group: options.groupId,
	});
	const reopened = new MemoryStore(paths.db, { keysDir: paths.keys });
	try {
		if (
			reopened.deviceId !== deviceId ||
			reopened.actorId !== r.identityId ||
			!reopened.refreshPersistedLocalIdentity(r.identityId)
		)
			return fail();
	} finally {
		reopened.close();
	}
}
async function run(options: OwnerEnrollmentOptions): Promise<OwnerEnrollmentReceipt> {
	const coordinatorOrigin = origin(options.coordinatorUrl);
	id(options.groupId);
	const paths = options.resume
		? prepareProfile(options)
		: initializeOwnerPilotProfile(options.profileDir);
	if (options.resume && !existsSync(paths.retained)) return fail();
	const db = connect(paths.db);
	try {
		const {
			deviceId,
			publicKey,
			privateKey,
			keyId,
			previous,
			labels,
			configText,
			configNode,
			saved: existing,
		} = await preflight(paths, options, db);
		const keyContext = { paths, db, deviceId, publicKey, privateKey, keyId };
		const p = pins(
			await request(options, `${coordinatorOrigin}/v1/auth/owner-pilot`),
			coordinatorOrigin,
		);
		let saved: Retained;
		assertKeyContext(keyContext);
		if (existing) {
			if (existing.pins.coordinatorId !== p.coordinatorId) return fail();
			saved = existing;
		} else {
			saved = await start(options, p, deviceId, publicKey, keyId, keyContext);
			persist(paths.retained, saved);
		}
		assertKeyContext(keyContext);
		const r = receipt(
			await request(options, `${p.origin}/v1/auth/owner-attempts/finalize`, saved.body),
			options.groupId,
		);
		if (
			previous &&
			(previous.bindingId !== r.bindingId ||
				previous.identityId !== r.identityId ||
				JSON.stringify(previous.groups) !== JSON.stringify(r.groups))
		)
			return fail();
		if (!previous) persist(join(paths.dir, "owner-receipt.json"), r);
		const source = await adoptionSource(p, r, deviceId, keyId);
		assertKeyContext(keyContext);
		adopt(db, deviceId, r, source, labels);
		assertKeyContext(keyContext);
		writeAndReopen(paths, r, deviceId, options, p, labels, keyContext, { configText, configNode });
		return r;
	} finally {
		db.close();
	}
}
