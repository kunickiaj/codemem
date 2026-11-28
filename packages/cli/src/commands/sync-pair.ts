import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import * as p from "@clack/prompts";
import {
	buildPairingPayload,
	DeviceIdentityError,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	loadPublicKey,
	MemoryStore,
	type PeerProjectFilterLists,
	peerProjectFilterChangeOnlyNarrows,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readPeerProjectFilterAuthority,
	recordPairingTransportEvidence,
	resolveDbPath,
	setPeerProjectFilterChecked,
	updatePeerAddresses,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	emitJsonError,
	resolveDbOpt,
} from "../shared-options.js";
import { collectAdvertiseAddresses, parseProjectList } from "./sync-helpers.js";

export interface SyncPairOptions {
	accept?: string;
	acceptFile?: string;
	payloadOnly?: boolean;
	name?: string;
	address?: string;
	include?: string;
	exclude?: string;
	all?: boolean;
	default?: boolean;
	config?: string;
	db?: string;
	dbPath?: string;
	json?: boolean;
}

/*
 * Who may change a pairing's Project filters. Sending a pairing more than it
 * gets now changes another device's access, which only an administrator's
 * device may do (ADR 0007 Decision 4). The pin is refused before anything is
 * stored, and the filter write checks again inside its own transaction.
 */
const PAIR_FILTERS_REFUSED =
	"These filters would send this pairing Projects it does not receive now. Only an administrator's device can do that. This device can send less. Nothing was changed.";

const STALE_PIN =
	"Pairing payload conflicts with the existing trusted fingerprint for this device. Remove or repair the old peer before accepting this pairing payload.";

/** A refusal with its JSON error code. Usage errors exit 2 in JSON mode, like other commands. */
class PairRefusal extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly jsonExitCode = 1,
	) {
		super(message);
	}
}

const usage = (message: string) => new PairRefusal("usage_error", message, 2);

function reportFailure(opts: SyncPairOptions, error: unknown): void {
	const code =
		error instanceof PairRefusal || error instanceof DeviceIdentityError
			? error.code
			: "pairing_failed";
	const message = error instanceof Error ? error.message : "Pairing failed";
	const jsonExitCode = error instanceof PairRefusal ? error.jsonExitCode : 1;
	if (opts.json) {
		emitJsonError(code, message, jsonExitCode);
		return;
	}
	p.log.error(message);
	process.exitCode = 1;
}

/** The filters the pair flags ask for, or null when no filter flag was given. */
function pairFilterChange(opts: SyncPairOptions): PeerProjectFilterLists | null {
	if (opts.default) return { include: null, exclude: null };
	if (opts.all) return { include: [], exclude: [] };
	if (!opts.include && !opts.exclude) return null;
	return { include: parseProjectList(opts.include), exclude: parseProjectList(opts.exclude) };
}

function checkModeFlags(opts: SyncPairOptions): void {
	const acceptRequested = opts.accept != null || opts.acceptFile != null;
	if (opts.payloadOnly && acceptRequested)
		throw usage("--payload-only cannot be combined with --accept or --accept-file");
	if (opts.accept && opts.acceptFile) throw usage("Use only one of --accept or --accept-file");
}

function readStdin(): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let text = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			text += chunk;
		});
		process.stdin.on("end", () => resolve(text));
		process.stdin.on("error", reject);
	});
}

async function readAcceptText(opts: SyncPairOptions): Promise<string | undefined> {
	if (!opts.acceptFile) return opts.accept;
	try {
		return opts.acceptFile === "-" ? await readStdin() : readFileSync(opts.acceptFile, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? `: ${error.message}` : "";
		throw new PairRefusal(
			"read_error",
			`Failed to read pairing payload from ${opts.acceptFile}${detail}`,
		);
	}
}

function checkFilterFlags(opts: SyncPairOptions, acceptText: string | undefined): void {
	const acceptRequested = opts.accept != null || opts.acceptFile != null;
	if (acceptRequested && !(acceptText ?? "").trim())
		throw usage("Empty pairing payload; provide JSON via --accept or --accept-file");
	const filtered = opts.include || opts.exclude || opts.all || opts.default;
	if (!acceptText && filtered)
		throw usage("Project filters are outbound-only and must be set on the device running --accept");
	if (!acceptText?.trim()) return;
	if (opts.all && opts.default) throw usage("Use only one of --all or --default");
	if ((opts.all || opts.default) && (opts.include || opts.exclude))
		throw usage("--include/--exclude cannot be combined with --all/--default");
}

function payloadAddresses(opts: SyncPairOptions, payload: Record<string, unknown>): string[] {
	if (opts.address?.trim()) return [opts.address.trim()];
	if (!Array.isArray(payload.addresses)) return [];
	return (payload.addresses as unknown[])
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

function parsePayload(opts: SyncPairOptions, text: string) {
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		const detail = error instanceof Error ? `: ${error.message}` : "";
		throw new PairRefusal("invalid_payload", `Invalid pairing payload${detail}`);
	}
	const deviceId = String(payload.device_id || "").trim();
	const fingerprint = String(payload.fingerprint || "").trim();
	const publicKey = String(payload.public_key || "").trim();
	const addresses = payloadAddresses(opts, payload);
	if (!deviceId || !fingerprint || !publicKey || addresses.length === 0)
		throw new PairRefusal(
			"invalid_payload",
			"Pairing payload missing device_id, fingerprint, public_key, or addresses",
		);
	if (fingerprintPublicKey(publicKey) !== fingerprint)
		throw new PairRefusal("fingerprint_mismatch", "Pairing payload fingerprint mismatch");
	return { payload, deviceId, fingerprint, publicKey, addresses };
}

type ParsedPayload = ReturnType<typeof parsePayload>;

/** Pins the payload's key and records what it says about Noise in one transaction. */
function savePairing(store: MemoryStore, opts: SyncPairOptions, pairing: ParsedPayload): void {
	const { deviceId } = pairing;
	const db = store.db;
	const pinned = db
		.prepare("SELECT pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.pluck()
		.get(deviceId);
	const existing = String(pinned ?? "").trim();
	if (existing && existing !== pairing.fingerprint)
		throw new PairRefusal("peer_conflict", STALE_PIN);
	const change = pairFilterChange(opts);
	db.transaction(() => {
		const widens = change !== null && !peerProjectFilterChangeOnlyNarrows(db, deviceId, change);
		if (widens && !readPeerProjectFilterAuthority(db)) throw new Error(PAIR_FILTERS_REFUSED);
		updatePeerAddresses(db, deviceId, pairing.addresses, {
			name: opts.name,
			pinnedFingerprint: pairing.fingerprint,
			publicKey: pairing.publicKey,
			replaceTrust: true,
		});
		recordPairingTransportEvidence(db, deviceId, pairing.payload);
	})();
	if (change && setPeerProjectFilterChecked(db, deviceId, change) !== "saved")
		throw new Error(PAIR_FILTERS_REFUSED);
}

function acceptPairing(store: MemoryStore, opts: SyncPairOptions, text: string): void {
	const pairing = parsePayload(opts, text);
	savePairing(store, opts, pairing);
	if (opts.json) {
		console.log(JSON.stringify({ ok: true, peer_device_id: pairing.deviceId }));
		return;
	}
	p.log.success(`Paired with ${pairing.deviceId}`);
}

function readCliConfig(configPath?: string): Record<string, unknown> {
	return configPath ? readCodememConfigFileAtPath(configPath) : readCodememConfigFile();
}

function localPairingPayload(store: MemoryStore, opts: SyncPairOptions): string {
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	const [deviceId, fingerprint] = ensureDeviceIdentity(store.db, { keysDir });
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new PairRefusal("missing_key", "Public key missing");
	const config = readCliConfig(opts.config);
	const addresses = collectAdvertiseAddresses(
		opts.address?.trim() ?? null,
		typeof config.sync_host === "string" ? config.sync_host : null,
		typeof config.sync_port === "number" ? config.sync_port : 7337,
		networkInterfaces(),
	);
	return JSON.stringify(buildPairingPayload({ deviceId, fingerprint, publicKey, addresses }));
}

function printPairingPayload(store: MemoryStore, opts: SyncPairOptions): void {
	const payloadText = localPairingPayload(store, opts);
	if (opts.payloadOnly || opts.json) {
		process.stdout.write(`${payloadText}\n`);
		return;
	}
	const escaped = payloadText.replaceAll("'", "'\\''");
	console.log("Pairing payload");
	console.log(payloadText);
	console.log("On the other device, save this JSON to pairing.json, then run:");
	console.log("  codemem sync pair --accept-file pairing.json");
	console.log("If you prefer inline JSON, run:");
	console.log(`  codemem sync pair --accept '${escaped}'`);
	console.log("For machine-friendly output next time, run:");
	console.log("  codemem sync pair --payload-only");
	console.log(
		"On the accepting device, --include/--exclude control both what it sends and what it accepts from that peer.",
	);
}

async function runPair(opts: SyncPairOptions): Promise<void> {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		checkModeFlags(opts);
		const acceptText = await readAcceptText(opts);
		checkFilterFlags(opts, acceptText);
		if (acceptText?.trim()) acceptPairing(store, opts, acceptText);
		else printPairingPayload(store, opts);
	} catch (error) {
		reportFailure(opts, error);
	} finally {
		store.close();
	}
}

export function buildSyncPairCommand(): Command {
	const command = new Command("pair")
		.configureHelp(helpStyle)
		.description("Create or accept a device pairing request")
		.option("--accept <json>", "accept pairing payload JSON from another device")
		.option("--accept-file <path>", "accept pairing payload from file path, or '-' for stdin")
		.option("--payload-only", "when generating pairing payload, print JSON only")
		.option("--name <name>", "label for the peer")
		.option("--address <host:port>", "override peer address (host:port)")
		.option("--include <projects>", "outbound-only allowlist for accepted peer")
		.option("--exclude <projects>", "outbound-only blocklist for accepted peer")
		.option("--all", "with --accept, push all projects to that peer")
		.option("--default", "with --accept, use default/global push filters");
	addDbOption(command);
	addConfigOption(command);
	addJsonOption(command);
	command.action(runPair);
	return command;
}
