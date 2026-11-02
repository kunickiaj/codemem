import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import Database from "better-sqlite3";
import { type Mock, vi } from "vitest";
import {
	decodeRelayCheckPacket,
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
	type RelayAdmissionBody,
	type RelayCheckPacket,
	type RelayRegistrationBody,
} from "./relay-admission-codec.js";
import {
	decideRelayAdmission,
	type RelayAdmissionBudgetStatus,
} from "./relay-admission-decision.js";
import { decisionFixture, decisionSeed } from "./relay-admission-decision-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import { PARTICIPANT_TEST_SCHEMA_SQL } from "./relay-admission-participant-nonce-test-fixtures.js";
import { encodeRelayAdmissionReply } from "./relay-admission-reply.js";
import {
	decodeRelayControl,
	encodeRelayControl,
	type RelayControl,
} from "./relay-control-codec.js";
import { encodeRelayDataFrame } from "./relay-data-frame.js";
import {
	createRelayServer,
	type RelayServerLimits,
	type RelayServerOptions,
	type RelayServerSocket,
	type RelaySocketEvents,
} from "./relay-server.js";
import { relayBodyDigest } from "./relay-service-proof.js";

export const bytes = (text: string) => new TextEncoder().encode(text);
export const SESSION = "e".repeat(32);
export const finiteLimits: RelayServerLimits = {
	sockets: 8,
	pendingSockets: 4,
	routes: 4,
	deviceRoutes: 4,
	queuedBytes: 1024 * 1024,
	deviceQueuedBytes: 512 * 1024,
	coordinatorTimeoutMs: 5000,
	quotaTimeoutMs: 3000,
};
export const deferred = <T>() => Promise.withResolvers<T>();
export async function settle() {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}

// Fixed disposable seeds keep cryptographic assertions reproducible without credentials.
export function testSigner(seed: number) {
	const privateKey = createPrivateKey({
		key: Buffer.concat([
			Buffer.from("302e020100300506032b657004220420", "hex"),
			Buffer.alloc(32, seed),
		]),
		format: "der",
		type: "pkcs8",
	});
	const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	return {
		keyId: relayBodyDigest(wire),
		publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
		sign: vi.fn(async (value: Uint8Array) => new Uint8Array(sign(null, value, privateKey))),
	};
}

interface FakeSocket {
	texts: RelayControl[];
	binaries: Uint8Array[];
	callbacks: ((error?: Error) => void)[];
	buffered: number;
	sendText: Mock<RelayServerSocket["sendText"]>;
	sendBinary: Mock<RelayServerSocket["sendBinary"]>;
	bufferedBytes: Mock<RelayServerSocket["bufferedBytes"]>;
	pauseInput: Mock<RelayServerSocket["pauseInput"]>;
	resumeInput: Mock<RelayServerSocket["resumeInput"]>;
	close: Mock<RelayServerSocket["close"]>;
	written(error?: Error): void;
}
export function fakeSocket(): FakeSocket {
	const texts: RelayControl[] = [];
	const binaries: Uint8Array[] = [];
	const callbacks: ((error?: Error) => void)[] = [];
	const socket = {
		texts,
		binaries,
		callbacks,
		buffered: 0,
		sendText: vi.fn((json: string) => {
			texts.push(decodeRelayControl(bytes(json)));
		}),
		sendBinary: vi.fn((frame: Uint8Array, callback: (error?: Error) => void) => {
			binaries.push(new Uint8Array(frame));
			callbacks.push(callback);
		}),
		bufferedBytes: vi.fn((): number => socket.buffered),
		pauseInput: vi.fn(),
		resumeInput: vi.fn(),
		close: vi.fn(),
		written(error?: Error) {
			const callback = callbacks.shift();
			if (!callback) throw new Error("No pending write");
			callback(error);
		},
	} satisfies RelayServerSocket & Record<string, unknown>;
	return socket;
}
export type TestSocket = ReturnType<typeof fakeSocket> & { events: RelaySocketEvents };
export function control(
	events: RelaySocketEvents,
	type: RelayControl["type"],
	body: unknown = {},
	session = SESSION,
) {
	return events.text(bytes(encodeRelayControl({ v: 1, type, session, body } as RelayControl)));
}
export function data(size = 1, sessionId = SESSION, fill = 17) {
	return encodeRelayDataFrame({ sessionId, payload: new Uint8Array(size).fill(fill) });
}

async function decisionBackend() {
	const template = await decisionFixture({ role: "relay" });
	const namespace = template.request.namespace;
	const source = testSigner(1),
		target = testSigner(2),
		service = testSigner(3);
	template.rows = template.rows.map((row) => ({
		...row,
		public_key: row.device_id === "target" ? target.publicKey : source.publicKey,
	}));
	template.rows = template.rows.flatMap((row) =>
		row.device_id === "source"
			? [row, { ...row, device_id: "third", fingerprint: "2".repeat(64) }]
			: [row],
	);
	const db = new Database(":memory:");
	db.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) db.exec(sql);
	const clock = { now: 0, monotonicMs: () => clock.now, utcMs: () => 110_000 + clock.now };
	db.function("strftime", (format, when) => {
		if (when !== "now") throw new Error("Unexpected SQL clock");
		const now = clock.utcMs();
		if (format === "%s") return String(Math.floor(now / 1000));
		if (format === "%f")
			return `${String(Math.floor(now / 1000) % 60).padStart(2, "0")}.${String(now % 1000).padStart(3, "0")}`;
		if (format === "%Y-%m-%dT%H:%M:%fZ") return new Date(now).toISOString();
		throw new Error("Unexpected SQL format");
	});
	const params = (values: readonly (string | number | null)[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	for (const { sql, values } of decisionSeed(template, clock.utcMs()))
		db.prepare(sql).run(params(values));
	return { template, namespace, source, target, service, db, clock, params };
}
type Backend = Awaited<ReturnType<typeof decisionBackend>>;

function signedPackets({ source, target, template }: Backend) {
	let nonce = 0;
	return async function packet(
		value: RelayRegistrationBody | RelayAdmissionBody,
	): Promise<RelayCheckPacket> {
		const bodyBytes =
			"role" in value ? encodeRelayAdmissionBody(value) : encodeRelayRegistrationBody(value);
		const requestNonce = (++nonce).toString(16).padStart(32, "0");
		const deviceId = "deviceId" in value ? value.deviceId : value.sourceDeviceId;
		const signer = deviceId === "target" ? target : source;
		const canonical = [
			"POST",
			template.request.externalPathname,
			String(value.createdAt),
			requestNonce,
			relayBodyDigest(bodyBytes),
		].join("\n");
		return encodeRelayCheckPacket({
			bodyBytes,
			timestamp: String(value.createdAt),
			nonce: requestNonce,
			signatureBytes: await signer.sign(bytes(canonical)),
		});
	};
}
function decisionCoordinator({ template, db, params }: Backend) {
	return {
		check: vi.fn(
			async ({
				packet: requestPacket,
				deviceHeader,
			}: Parameters<RelayServerOptions["coordinator"]["check"]>[0]) => {
				const decoded = decodeRelayCheckPacket(requestPacket);
				const expected =
					decoded.kind === "registration"
						? { kind: "registration" as const }
						: { kind: "admission" as const, role: decoded.value.role };
				const decision = await decideRelayAdmission(
					{ ...template.request, packet: requestPacket, deviceHeader, expected },
					{
						database: {
							query: async (sql, values) => db.prepare(sql).all(params(values)),
							insertReturning: async (sql, values) => db.prepare(sql).get(params(values)) ?? null,
						},
						budgets: {
							reserveIngress: async () => "reserved",
							reserveVerifiedDevice: async () => "reserved",
						},
					},
				);
				return encodeRelayAdmissionReply(decision);
			},
		),
	};
}
function finiteQuota() {
	// Finite, nonrefundable test credits. Reconnects never replenish them.
	const credits = { control: 10000, open: 100, traffic: 64 * 1024 * 1024 };
	const quota = {
		reserve: vi.fn(
			async (
				request: Parameters<RelayServerOptions["quota"]["reserve"]>[0],
				_signal: AbortSignal,
			): Promise<RelayAdmissionBudgetStatus> => {
				if (credits[request.purpose] < request.units) return "denied";
				credits[request.purpose] -= request.units;
				return "reserved";
			},
		),
	};
	return { credits, quota };
}

/** No listener, network, payload storage, or production quota implementation. */
export async function serverFixture(limits: Partial<RelayServerLimits> = {}) {
	const backend = await decisionBackend();
	const { namespace, source, target, service, clock, db } = backend;
	const packet = signedPackets(backend);
	const coordinator = decisionCoordinator(backend);
	const { credits, quota } = finiteQuota();
	const options: RelayServerOptions = {
		namespace,
		limits: { ...finiteLimits, ...limits },
		coordinator,
		quota,
		signer: service,
		clock,
	};
	const server = createRelayServer(options);
	const controls = fixtureControls({ server, namespace, source, target, packet });
	return {
		server,
		options,
		clock,
		coordinator,
		quota,
		credits,
		source,
		target,
		service,
		packet,
		...controls,
		refreshReadiness() {
			// Only the disposable coordinator fixture publishes these trusted health rows.
			for (const scope of ["authority", "realm"])
				db.prepare(
					"UPDATE relay_admission_readiness SET revision = revision + 1, observed_at_ms = ? WHERE scope = ?",
				).run(clock.utcMs(), scope);
		},
		dispose() {
			server.close();
			db.close();
		},
	};
}

function fixtureControls({
	server,
	namespace,
	source,
	target,
	packet,
}: {
	server: ReturnType<typeof createRelayServer>;
	namespace: RelayServerOptions["namespace"];
	source: ReturnType<typeof testSigner>;
	target: ReturnType<typeof testSigner>;
	packet: ReturnType<typeof signedPackets>;
}) {
	function adopt(): TestSocket {
		const socket = fakeSocket();
		const events = server.adopt(socket);
		if (!events) throw new Error("Fixture adoption denied");
		return Object.assign(socket, { events });
	}
	async function challenge(socket: TestSocket) {
		await control(socket.events, "SERVICE_CHALLENGE", { audienceId: namespace.relayAudienceId });
		const issued = socket.texts.findLast((message) => message.type === "SOCKET_CHALLENGE");
		if (!issued) throw new Error("Fixture challenge denied");
		return issued.session;
	}
	async function registration(
		socket: TestSocket,
		deviceId = "source",
		overrides: Partial<RelayRegistrationBody> = {},
	) {
		const session = await challenge(socket);
		const key = deviceId === "target" ? target : source;
		const body = await packet({
			...namespace,
			...registrationContext(deviceId, key.keyId, session),
			...overrides,
		});
		return { session, body };
	}
	async function register(deviceId = "source") {
		const socket = adopt();
		const request = await registration(socket, deviceId);
		await control(socket.events, "REGISTER", request.body, request.session);
		return socket;
	}
	const openPacket = openPackets({ namespace, source, target, packet });
	async function route({ accepted = true }: { accepted?: boolean } = {}) {
		const a = await register(),
			b = await register("target");
		const open = await openPacket();
		await a.events.text(bytes(encodeRelayControl(open)));
		if (accepted) await control(b.events, "ACCEPTED");
		return { a, b, open };
	}
	return { adopt, challenge, registration, register, openPacket, route };
}

function openPackets({
	namespace,
	source,
	target,
	packet,
}: Pick<Backend, "namespace" | "source" | "target"> & {
	packet: ReturnType<typeof signedPackets>;
}) {
	return async function openPacket(
		overrides: Partial<RelayAdmissionBody> = {},
		session = SESSION,
	): Promise<Extract<RelayControl, { type: "OPEN" }>> {
		const common = {
			...namespace,
			...routeContext(source.keyId, target.keyId, session),
			...overrides,
		};
		return {
			v: 1,
			type: "OPEN",
			session,
			body: {
				checks: [
					await packet({ ...common, role: "relay" }),
					await packet({ ...common, role: "responder" }),
				],
			},
		};
	};
}

function routeContext(sourceKeyId: string, targetKeyId: string, routeSessionId: string) {
	return {
		sourceDeviceId: "source",
		sourceKeyId,
		targetDeviceId: "target",
		targetKeyId,
		routeSessionId,
		messageADigest: "d".repeat(64),
		createdAt: 100,
		admitBefore: 130,
		routeNotAfter: 155,
	};
}

function registrationContext(deviceId: string, keyId: string, socketChallengeId: string) {
	return { deviceId, keyId, socketChallengeId, createdAt: 100, admitBefore: 130 };
}
