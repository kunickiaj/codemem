import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Sqlite from "better-sqlite3";
import { createCoordinatorOwnerEnrollmentReceiver } from "./coordinator-account-link-receiver.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	ownerEnrollmentFinalMessage,
	verifyOwnerEnrollmentSignature,
} from "./coordinator-owner-enrollment-proof.js";
import {
	adoptOwnerProfile,
	hasCommittedOwnerProfile,
	type OwnerProfileReview,
	ownerProfileConflict,
	reviewOwnerProfile,
} from "./coordinator-owner-profile-adoption.js";
import {
	applyOwnerProfileConfig,
	assertOwnerEnvironment,
	assertOwnerRuntime,
	type OwnerFileSnapshot,
	type OwnerProfilePaths,
	ownerDatabaseFile,
	ownerFileSnapshot,
	ownerObject,
	ownerProfileWireKey,
	readOwnerProfileConfig,
	readOwnerProfileKey,
	readOwnerState,
	retainOwnerState,
	syncOwnerProfileDirectory,
} from "./coordinator-owner-profile-files.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import {
	type OwnerEnrollmentReceipt,
	type OwnerEnrollmentStart,
	ownerEnrollmentHash,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";
import { loadPublicKey } from "./sync-identity.js";

type Pins = { coordinatorId: string; origin: string; issuer: string; revision: string };
type Prepared = {
	pins: Pins;
	start: OwnerEnrollmentStart;
	review: OwnerProfileReview;
	config: OwnerFileSnapshot;
	paths: OwnerProfilePaths;
	reviewDigest: string;
	keyId: string;
	databaseFile: string;
};
type Final = { body: string; confirmationHash: string };
export type OwnerProfileClientOptions = OwnerProfilePaths & {
	coordinatorUrl: string;
	groupId: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	mode: "prepare" | "resume";
	/** Account admission is explicit; omitted selectors retain operator admission. */
	admissionMode?: "operator" | "account";
	capability?: string;
	reviewedDigest?: string;
	onBrowserStart?: (
		privateUrl: string,
		accountRequest?: { requestFile: string; deviceId: string; fingerprint: string },
	) => Promise<void> | void;
};
export type OwnerProfileClientResult =
	| { kind: "prepared"; review: OwnerProfileReview; reviewDigest: string; requestFile: string }
	| { kind: "adopted"; identityId: string; bindingId: string; groups: string[] };
export type OwnerProfileEnrollmentErrorCode =
	| "unsupported_platform"
	| "review_required"
	| "fresh_prepare_required"
	| "retained_request_incomplete";
const ERROR_MESSAGES: Record<OwnerProfileEnrollmentErrorCode, string> = {
	unsupported_platform:
		"Existing-profile owner enrollment is not available on Windows until private-file ACL verification is implemented. Keep this profile unchanged; do not copy signing keys to work around this limitation.",
	review_required:
		"Owner enrollment incomplete. Keep the profile and saved files unchanged; check the reviewed digest and selected admission mode (including the capability for operator admission). Identity, key, access or lock conflicts require operator review. Do not remove unknown, live or legacy config locks.",
	fresh_prepare_required:
		"Owner enrollment incomplete. A start may have been consumed, but no final request was saved, so this attempt cannot be reused. Keep the original directory unchanged. Ask the operator to review any Identity, key or access conflict; ownership transfer and key replacement are not supported. Once cleared, stop capture writers, run --prepare with a NEW --state-dir and admit the new request through the selected account or operator mode.",
	retained_request_incomplete:
		"Owner enrollment incomplete. A final request or receipt is retained. Keep all saved files unchanged; retry --resume with the reviewed digest for exact finalization or config-only adoption. Do not prepare a replacement request. Identity, capture, access or config lock conflicts require operator review. Do not remove unknown, live or legacy config locks.",
};
/** Only fixed guidance is exposed; transport errors and credentials never become UI copy. */
export class OwnerProfileEnrollmentError extends Error {
	readonly code: OwnerProfileEnrollmentErrorCode;
	constructor(code: OwnerProfileEnrollmentErrorCode) {
		if (
			code !== "unsupported_platform" &&
			code !== "fresh_prepare_required" &&
			code !== "retained_request_incomplete"
		)
			code = "review_required";
		super(ERROR_MESSAGES[code]);
		this.name = "OwnerProfileEnrollmentError";
		this.code = code;
	}
}
function id(value: unknown): string {
	if (!isAuthControllerId(value)) return ownerProfileConflict();
	return value;
}
function origin(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		(value !== url.origin && value !== `${url.origin}/`)
	)
		return ownerProfileConflict();
	return url.origin;
}
function pins(value: unknown, expected: string): Pins {
	const p = ownerObject(value);
	if (p.origin !== expected || p.issuer !== "https://accounts.google.com")
		return ownerProfileConflict();
	return {
		coordinatorId: id(p.coordinatorId),
		origin: expected,
		issuer: p.issuer,
		revision: id(p.revision),
	};
}
async function request(
	options: OwnerProfileClientOptions,
	path: string,
	body?: string,
	capability?: string,
): Promise<unknown> {
	try {
		const url = `${origin(options.coordinatorUrl)}${path}`;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (capability !== undefined) {
			if (!/^[A-Za-z0-9._-]{1,512}$/.test(capability)) return ownerProfileConflict();
			headers.Authorization = `Bearer ${capability}`;
		}
		const response = await (options.fetch ?? globalThis.fetch)(url, {
			method: body === undefined ? "GET" : "POST",
			headers,
			body,
			redirect: "error",
			signal: options.signal ?? AbortSignal.timeout(600000),
		});
		if (!response.ok || response.redirected || (response.url && response.url !== url))
			return ownerProfileConflict();
		return await response.json();
	} catch {
		throw new Error(
			"Owner enrollment response unavailable. Retain the saved request and resume unchanged; credentials and server details are not logged.",
		);
	}
}
function paths(options: OwnerProfilePaths): OwnerProfilePaths {
	return {
		dbPath: resolve(options.dbPath),
		configPath: resolve(options.configPath),
		keysDir: resolve(options.keysDir),
		stateDir: resolve(options.stateDir),
	};
}
function configuredOwnerActorId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() || undefined;
}
function assertConfig(
	config: Record<string, unknown>,
	options: OwnerProfileClientOptions,
	review: OwnerProfileReview,
	receipt?: OwnerEnrollmentReceipt,
): void {
	const actorId = configuredOwnerActorId(config.actor_id) ?? `local:${review.deviceId}`;
	if (actorId !== review.actorId && actorId !== receipt?.identityId) ownerProfileConflict();
	if (
		config.sync_coordinator_url !== undefined &&
		(typeof config.sync_coordinator_url !== "string" ||
			origin(config.sync_coordinator_url) !== origin(options.coordinatorUrl))
	)
		ownerProfileConflict();
	// Runtime gives a nonempty plural selection precedence; adoption preserves it verbatim.
	if (
		readCoordinatorSyncConfig(config).syncCoordinatorGroups.some(
			(group) => group !== options.groupId,
		)
	)
		ownerProfileConflict();
}
function assertStateDirectory(path: string): void {
	const stat = lstatSync(path);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o700 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())
	)
		ownerProfileConflict();
}
function reviewDigest(prepared: Omit<Prepared, "reviewDigest">, groupId: string): string {
	return createHash("sha256")
		.update(JSON.stringify(["owner-profile-review-v1", prepared, groupId]))
		.digest("hex");
}
async function prepare(
	options: OwnerProfileClientOptions,
	db: Sqlite.Database,
	databaseFile: string,
): Promise<OwnerProfileClientResult> {
	if (existsSync(options.stateDir)) return retryPrepared(options, db, databaseFile);
	const { profile, snapshot, publicKey, review, privateKey, assertRuntime } = profileContext({
		options,
		db,
		databaseFile,
	});
	const pin = pins(await request(options, "/v1/auth/owner-config"), origin(options.coordinatorUrl));
	const attemptId = randomUUID();
	const receiver = await createCoordinatorOwnerEnrollmentReceiver({
		attemptId,
		signal: options.signal,
	});
	try {
		const start: OwnerEnrollmentStart = {
			attemptId,
			deviceId: review.deviceId,
			publicKey: ownerProfileWireKey(publicKey),
			loopbackRedirect: receiver.destination,
			browserStartCode: randomBytes(32).toString("base64url"),
			signature: "",
		};
		assertRuntime();
		start.signature = sign(
			null,
			Buffer.from(ownerEnrollmentStartMessage(start, pin)),
			privateKey,
		).toString("base64url");
		await verifyCreatedStart(start, pin);
		const state = {
			pins: pin,
			start,
			review,
			config: snapshot,
			paths: profile,
			keyId: await ed25519KeyId(publicKey),
			databaseFile,
		};
		if (!state.keyId) return ownerProfileConflict();
		assertRuntime();
		const prepared: Prepared = {
			...state,
			keyId: state.keyId,
			reviewDigest: reviewDigest({ ...state, keyId: state.keyId }, options.groupId),
		};
		return retainPrepared(prepared);
	} finally {
		await receiver.close();
	}
}
async function verifyCreatedStart(start: OwnerEnrollmentStart, pin: Pins): Promise<void> {
	if (
		!(await verifyOwnerEnrollmentSignature(
			start.publicKey,
			ownerEnrollmentStartMessage(start, pin),
			start.signature,
		))
	)
		ownerProfileConflict();
}
function profileContext(input: {
	options: OwnerProfileClientOptions;
	db: Sqlite.Database;
	databaseFile: string;
}) {
	const { options, db, databaseFile } = input;
	const profile = paths(options);
	const snapshot = ownerFileSnapshot(profile.configPath);
	const config = readOwnerProfileConfig(profile.configPath);
	const publicKey = loadPublicKey(profile.keysDir);
	if (!publicKey) return ownerProfileConflict();
	const actorId = configuredOwnerActorId(config.actor_id);
	const review = db.transaction(() =>
		reviewOwnerProfile({
			db,
			actorId,
			expectedPublicKey: publicKey,
		}),
	)();
	const privateKey = readOwnerProfileKey({ paths: profile, db, deviceId: review.deviceId });
	const assertRuntime = () => {
		options.signal?.throwIfAborted();
		assertOwnerRuntime({ paths: profile, db, review, privateKey, config: snapshot, databaseFile });
	};
	assertConfig(config, options, review);
	assertRuntime();
	return { profile, snapshot, publicKey, review, privateKey, assertRuntime };
}
function retainPrepared(prepared: Prepared): OwnerProfileClientResult {
	mkdirSync(prepared.paths.stateDir, { mode: 0o700 });
	assertStateDirectory(prepared.paths.stateDir);
	// Persist the new directory's name before publishing any private state within it.
	syncOwnerProfileDirectory(dirname(prepared.paths.stateDir));
	retainOwnerState(join(prepared.paths.stateDir, "prepared.json"), prepared);
	return retainPreparedRequest(prepared);
}
function retainPreparedRequest(prepared: Prepared): OwnerProfileClientResult {
	// The operator request contains the private browser-start code; keep this file private.
	const requestFile = join(prepared.paths.stateDir, "capability-request.json");
	if (!existsSync(requestFile)) retainOwnerState(requestFile, { start: prepared.start });
	if (JSON.stringify(readOwnerState(requestFile)) !== JSON.stringify({ start: prepared.start }))
		return ownerProfileConflict();
	return {
		kind: "prepared",
		review: { ...prepared.review, publicKey: prepared.start.publicKey },
		reviewDigest: prepared.reviewDigest,
		requestFile,
	};
}
async function retryPrepared(
	options: OwnerProfileClientOptions,
	db: Sqlite.Database,
	databaseFile: string,
): Promise<OwnerProfileClientResult> {
	const prepared = await readPrepared(options);
	assertPrepareRetryAllowed(prepared.paths.stateDir);
	const current = profileContext({ options, db, databaseFile });
	if (
		prepared.databaseFile !== databaseFile ||
		JSON.stringify(prepared.config) !== JSON.stringify(current.snapshot) ||
		JSON.stringify(prepared.review) !== JSON.stringify(current.review)
	)
		return ownerProfileConflict();
	current.assertRuntime();
	await assertDiscoveredPins({
		options,
		prepared,
		finalPath: join(prepared.paths.stateDir, "final.json"),
	});
	current.assertRuntime();
	assertPrepareRetryAllowed(prepared.paths.stateDir);
	return retainPreparedRequest(prepared);
}
function assertPrepareRetryAllowed(stateDir: string): void {
	for (const name of ["start-attempted.json", "final.json", "receipt.json"]) {
		if (existsSync(join(stateDir, name))) ownerProfileConflict();
	}
}
async function readPrepared(options: OwnerProfileClientOptions): Promise<Prepared> {
	const profile = paths(options);
	assertStateDirectory(profile.stateDir);
	const raw = readOwnerState(join(profile.stateDir, "prepared.json"));
	const pin = pins(raw.pins, origin(options.coordinatorUrl));
	if (JSON.stringify(raw.paths) !== JSON.stringify(profile)) return ownerProfileConflict();
	const s = ownerObject(raw.start);
	const start: OwnerEnrollmentStart = {
		attemptId: id(s.attemptId),
		deviceId: id(s.deviceId),
		publicKey: String(s.publicKey),
		loopbackRedirect: String(s.loopbackRedirect),
		browserStartCode: String(s.browserStartCode),
		signature: String(s.signature),
	};
	const review = ownerObject(raw.review) as OwnerProfileReview;
	const config = ownerObject(raw.config) as OwnerFileSnapshot;
	const prepared = {
		pins: pin,
		start,
		review,
		config,
		paths: profile,
		keyId: id(raw.keyId),
		databaseFile: String(raw.databaseFile),
		reviewDigest: String(raw.reviewDigest),
	};
	if (
		prepared.reviewDigest !==
			reviewDigest(
				{
					pins: pin,
					start,
					review,
					config,
					paths: profile,
					keyId: prepared.keyId,
					databaseFile: prepared.databaseFile,
				},
				options.groupId,
			) ||
		review.deviceId !== start.deviceId ||
		ownerProfileWireKey(review.publicKey) !== start.publicKey ||
		prepared.keyId !== (await ed25519KeyId(start.publicKey)) ||
		!(await verifyOwnerEnrollmentSignature(
			start.publicKey,
			ownerEnrollmentStartMessage(start, pin),
			start.signature,
		))
	)
		return ownerProfileConflict();
	return prepared;
}
async function finalMessage(prepared: Prepared, final: Final): Promise<string> {
	const body = ownerObject(JSON.parse(final.body));
	return ownerEnrollmentFinalMessage(
		{
			coordinator_id: prepared.pins.coordinatorId,
			origin: prepared.pins.origin,
			auth_config_revision: prepared.pins.revision,
			issuer: prepared.pins.issuer,
			attempt_id: prepared.start.attemptId,
			device_id: prepared.review.deviceId,
			public_key: prepared.start.publicKey,
			key_id: prepared.keyId,
			fingerprint: await ownerEnrollmentHash(prepared.start.publicKey),
			confirmation_hash: final.confirmationHash,
		},
		String(body.completionSecret),
	);
}
async function complete(
	options: OwnerProfileClientOptions,
	prepared: Prepared,
	privateKey: Buffer,
	assertRuntime: () => void,
): Promise<Final> {
	if (!options.onBrowserStart) return ownerProfileConflict();
	if (
		options.admissionMode !== "account" &&
		(!options.capability || !/^[A-Za-z0-9._-]{1,512}$/.test(options.capability))
	)
		return ownerProfileConflict();
	const redirect = new URL(prepared.start.loopbackRedirect);
	const receiver = await createCoordinatorOwnerEnrollmentReceiver({
		attemptId: prepared.start.attemptId,
		host: "127.0.0.1",
		port: Number(redirect.port),
		signal: options.signal ?? AbortSignal.timeout(600000),
	});
	try {
		if (receiver.destination !== prepared.start.loopbackRedirect) return ownerProfileConflict();
		assertRuntime();
		// Publish before sending or opening: browser admission can consume the signed start too.
		retainOwnerState(join(options.stateDir, "start-attempted.json"), {
			attemptId: prepared.start.attemptId,
		});
		await deliverBrowserStart(options, prepared);
		const completion = await receiver.completion;
		assertRuntime();
		const final = {
			confirmationHash: completion.confirmationHash,
			body: JSON.stringify({
				attemptId: prepared.start.attemptId,
				completionSecret: completion.completionSecret,
			}),
		};
		const message = await finalMessage(prepared, final);
		assertRuntime();
		const signature = sign(null, Buffer.from(message), privateKey).toString("base64url");
		return {
			...final,
			body: JSON.stringify({ ...ownerObject(JSON.parse(final.body)), signature }),
		};
	} finally {
		await receiver.close();
	}
}
async function deliverBrowserStart(
	options: OwnerProfileClientOptions,
	prepared: Prepared,
): Promise<void> {
	if (!options.onBrowserStart) return ownerProfileConflict();
	if (options.admissionMode === "account") {
		// Verify the private upload still contains exactly the reviewed signed request.
		const requestFile = join(prepared.paths.stateDir, "capability-request.json");
		if (JSON.stringify(readOwnerState(requestFile)) !== JSON.stringify({ start: prepared.start }))
			return ownerProfileConflict();
		await options.onBrowserStart(`${prepared.pins.origin}/auth/owner/admit`, {
			requestFile,
			deviceId: prepared.start.deviceId,
			fingerprint: await ownerEnrollmentHash(prepared.start.publicKey),
		});
		return;
	}
	const response = ownerObject(
		await request(
			options,
			"/v1/auth/owner-attempts",
			JSON.stringify(prepared.start),
			options.capability,
		),
	);
	if (
		response.kind !== "started" ||
		response.attemptId !== prepared.start.attemptId ||
		!Number.isSafeInteger(response.expiresAtMs) ||
		Number(response.expiresAtMs) <= 0
	)
		return ownerProfileConflict();
	const query = new URLSearchParams({
		attempt_id: prepared.start.attemptId,
		start_code: prepared.start.browserStartCode,
	});
	await options.onBrowserStart(`${prepared.pins.origin}/auth/owner/start?${query}`);
}
function receipt(value: unknown, groupId: string): OwnerEnrollmentReceipt {
	const r = ownerObject(value);
	if (
		(r.kind !== "finalized" && r.kind !== "prior_commit") ||
		!Array.isArray(r.groups) ||
		r.groups.length < 1 ||
		r.groups.length > 50
	)
		return ownerProfileConflict();
	const groups = r.groups.map(id);
	if (new Set(groups).size !== groups.length || !groups.includes(groupId))
		return ownerProfileConflict();
	return { kind: r.kind, bindingId: id(r.bindingId), identityId: id(r.identityId), groups };
}
async function readFinal(path: string, prepared: Prepared): Promise<Final> {
	const value = readOwnerState(path);
	if (
		typeof value.body !== "string" ||
		typeof value.confirmationHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.confirmationHash)
	)
		return ownerProfileConflict();
	const final = { body: value.body, confirmationHash: value.confirmationHash };
	const body = ownerObject(JSON.parse(final.body));
	if (
		Object.keys(body).sort().join() !== "attemptId,completionSecret,signature" ||
		body.attemptId !== prepared.start.attemptId ||
		typeof body.completionSecret !== "string" ||
		typeof body.signature !== "string" ||
		!(await verifyOwnerEnrollmentSignature(
			prepared.start.publicKey,
			await finalMessage(prepared, final),
			body.signature,
		))
	)
		return ownerProfileConflict();
	return final;
}
async function resume(
	options: OwnerProfileClientOptions,
	db: Sqlite.Database,
): Promise<OwnerProfileClientResult> {
	const prepared = await readPrepared(options);
	assertStartRetryAllowed(options.stateDir);
	if (options.reviewedDigest !== prepared.reviewDigest) return ownerProfileConflict();
	const privateKey = readOwnerProfileKey({
		paths: prepared.paths,
		db,
		deviceId: prepared.review.deviceId,
	});
	const config = ownerFileSnapshot(options.configPath);
	const assertRuntime = () => {
		options.signal?.throwIfAborted();
		assertOwnerRuntime({
			paths: prepared.paths,
			db,
			review: prepared.review,
			privateKey,
			config,
			databaseFile: prepared.databaseFile,
		});
	};
	assertRuntime();
	const finalPath = join(options.stateDir, "final.json");
	const receiptPath = join(options.stateDir, "receipt.json");
	let result: OwnerEnrollmentReceipt;
	if (existsSync(receiptPath)) {
		result = await retainedReceipt({ receiptPath, finalPath, prepared, groupId: options.groupId });
	} else {
		if (JSON.stringify(config) !== JSON.stringify(prepared.config)) return ownerProfileConflict();
		assertConfig(readOwnerProfileConfig(options.configPath), options, prepared.review);
		const current = db.transaction(() =>
			reviewOwnerProfile({
				db,
				actorId: prepared.review.actorId,
				expectedPublicKey: prepared.review.publicKey,
			}),
		)();
		if (current.digest !== prepared.review.digest) return ownerProfileConflict();
		assertRuntime();
		await assertDiscoveredPins({ options, prepared, finalPath });
		if (!existsSync(finalPath))
			retainOwnerState(finalPath, await complete(options, prepared, privateKey, assertRuntime));
		const final = await readFinal(finalPath, prepared);
		assertRuntime();
		result = receipt(
			await request(options, "/v1/auth/owner-attempts/finalize", final.body),
			options.groupId,
		);
		retainOwnerState(receiptPath, {
			pins: prepared.pins,
			keyId: prepared.keyId,
			reviewDigest: prepared.reviewDigest,
			receipt: result,
		});
	}
	return commit(options, db, prepared, result, config, privateKey, assertRuntime);
}
function assertStartRetryAllowed(stateDir: string): void {
	if (
		existsSync(join(stateDir, "start-attempted.json")) &&
		!existsSync(join(stateDir, "final.json")) &&
		!existsSync(join(stateDir, "receipt.json"))
	)
		throw new OwnerProfileEnrollmentError("fresh_prepare_required");
}
async function retainedReceipt(input: {
	receiptPath: string;
	finalPath: string;
	prepared: Prepared;
	groupId: string;
}): Promise<OwnerEnrollmentReceipt> {
	const saved = readOwnerState(input.receiptPath);
	if (
		saved.reviewDigest !== input.prepared.reviewDigest ||
		saved.keyId !== input.prepared.keyId ||
		JSON.stringify(saved.pins) !== JSON.stringify(input.prepared.pins)
	)
		return ownerProfileConflict();
	await readFinal(input.finalPath, input.prepared);
	return receipt(saved.receipt, input.groupId);
}
async function assertDiscoveredPins(input: {
	options: OwnerProfileClientOptions;
	prepared: Prepared;
	finalPath: string;
}): Promise<void> {
	const discovered = pins(
		await request(input.options, "/v1/auth/owner-config"),
		input.prepared.pins.origin,
	);
	if (
		discovered.coordinatorId !== input.prepared.pins.coordinatorId ||
		(!existsSync(input.finalPath) && discovered.revision !== input.prepared.pins.revision)
	)
		ownerProfileConflict();
}
function commit(
	options: OwnerProfileClientOptions,
	db: Sqlite.Database,
	prepared: Prepared,
	result: OwnerEnrollmentReceipt,
	config: OwnerFileSnapshot,
	privateKey: Buffer,
	assertRuntime: () => void,
): OwnerProfileClientResult {
	assertConfig(readOwnerProfileConfig(options.configPath), options, prepared.review, result);
	const adoption = {
		db,
		review: prepared.review,
		receipt: result,
		coordinatorId: prepared.pins.coordinatorId,
		keyId: prepared.keyId,
		displayName: "Coordinator Identity",
		assertRuntime,
	};
	if (!db.transaction(() => hasCommittedOwnerProfile(adoption))()) adoptOwnerProfile(adoption);
	// Prevent a competing writer between checking committed metadata and config CAS.
	db.transaction(() => {
		if (!hasCommittedOwnerProfile(adoption)) ownerProfileConflict();
		applyOwnerProfileConfig({
			paths: prepared.paths,
			snapshot: config,
			identityId: result.identityId,
			coordinatorOrigin: prepared.pins.origin,
			groupId: options.groupId,
			assertRuntime,
			lockAuthentication: {
				privateKey,
				reviewDigest: prepared.reviewDigest,
				databaseFile: prepared.databaseFile,
				keyId: prepared.keyId,
				deviceId: prepared.review.deviceId,
				bindingId: result.bindingId,
			},
		});
	}).immediate();
	return {
		kind: "adopted",
		identityId: result.identityId,
		bindingId: result.bindingId,
		groups: result.groups,
	};
}
/** Normal existing-profile enrollment; never creates schema, devices or signing keys. */
export async function enrollOwnerProfile(
	options: OwnerProfileClientOptions,
): Promise<OwnerProfileClientResult> {
	if (process.platform === "win32") throw new OwnerProfileEnrollmentError("unsupported_platform");
	try {
		assertAdmissionMode(options);
		// A caller's cancellation signal must not disable the ceremony's ten-minute limit.
		const timeout = AbortSignal.timeout(600000);
		options = {
			...options,
			...paths(options),
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		};
		assertOwnerEnvironment(paths(options));
		if (options.mode !== "prepare" && options.mode !== "resume") return ownerProfileConflict();
		id(options.groupId);
		origin(options.coordinatorUrl);
		const databaseFile = ownerDatabaseFile(options.dbPath);
		const db = new Sqlite(options.dbPath, {
			readonly: options.mode === "prepare",
			fileMustExist: true,
			timeout: 1000,
		});
		try {
			if (ownerDatabaseFile(options.dbPath) !== databaseFile) return ownerProfileConflict();
			return options.mode === "prepare"
				? await prepare(options, db, databaseFile)
				: await resume(options, db);
		} finally {
			db.close();
		}
	} catch {
		throw enrollmentFailure(options);
	}
}
function assertAdmissionMode(options: OwnerProfileClientOptions): void {
	const selector: unknown = options.admissionMode;
	if (selector !== undefined && selector !== "operator" && selector !== "account")
		ownerProfileConflict();
	if (selector === "account" && options.capability !== undefined) ownerProfileConflict();
}
function enrollmentFailure(options: OwnerProfileClientOptions): OwnerProfileEnrollmentError {
	try {
		if (
			existsSync(join(options.stateDir, "final.json")) ||
			existsSync(join(options.stateDir, "receipt.json"))
		)
			return new OwnerProfileEnrollmentError("retained_request_incomplete");
		if (existsSync(join(options.stateDir, "start-attempted.json")))
			return new OwnerProfileEnrollmentError("fresh_prepare_required");
	} catch {
		/* Invalid paths reveal no filesystem or credential details. */
	}
	return new OwnerProfileEnrollmentError("review_required");
}
