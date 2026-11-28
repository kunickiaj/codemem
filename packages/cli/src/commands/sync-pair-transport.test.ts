import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPairingPayload,
	connect,
	fingerprintPublicKey,
	initTestSchema,
	loadPublicKey,
	readPeerTransportPolicy,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { syncCommand } from "./sync.js";

const PEER = "peer-1";
const BASE = {
	device_id: PEER,
	fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
	public_key: CANONICAL_PUBLIC_KEY,
	addresses: ["127.0.0.1:1"],
};

let dir: string;
let dbPath: string;
let db: ReturnType<typeof connect>;
let output: string[];
let previousExitCode: typeof process.exitCode;

async function pair(...args: string[]) {
	const command = syncCommand.commands.find((candidate) => candidate.name() === "pair");
	if (!command) throw new Error("sync pair command missing");
	for (const option of command.options) {
		command.setOptionValueWithSource(option.attributeName(), undefined, "default");
	}
	await command.parseAsync([...args, "--db-path", dbPath, "--json"], { from: "user" });
	return JSON.parse(output.at(-1) ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-sync-pair-transport-"));
	dbPath = join(dir, "mem.sqlite");
	writeFileSync(join(dir, "config.json"), "{}");
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(dir, "keys"));
	for (const name of ["CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "CODEMEM_SYNC_COORDINATOR_URL"]) {
		vi.stubEnv(name, undefined);
	}
	db = connect(dbPath);
	initTestSchema(db);
	output = [];
	vi.spyOn(console, "log").mockImplementation((line) => {
		output.push(String(line));
	});
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output.push(String(chunk));
		return true;
	});
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
});

afterEach(() => {
	db.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = previousExitCode;
	rmSync(dir, { recursive: true, force: true });
});

it("emits the shared pairing payload, without transports while Noise is off", async () => {
	const payload = await pair("--payload-only", "--address", "127.0.0.1:7337");
	const publicKey = loadPublicKey(join(dir, "keys"));
	expect(publicKey).toBeTruthy();
	expect(payload).toEqual(
		buildPairingPayload({
			deviceId: String(payload.device_id),
			fingerprint: fingerprintPublicKey(publicKey ?? ""),
			publicKey: publicKey ?? "",
			addresses: payload.addresses as string[],
		}),
	);
	expect(payload).not.toHaveProperty("transports");
});

const accept = (payload: Record<string, unknown>, ...flags: string[]) =>
	pair("--accept", JSON.stringify(payload), ...flags);

it("records Noise from an accepted payload that lists it, and never downgrades", async () => {
	expect(await accept({ ...BASE, transports: ["noise1"] })).toEqual({
		ok: true,
		peer_device_id: PEER,
	});
	expect(readPeerTransportPolicy(db, PEER)).toBe("noise_required");
	expect(await accept(BASE)).toMatchObject({ ok: true });
	expect(readPeerTransportPolicy(db, PEER)).toBe("noise_required");
});

it("records an accepted payload without transports as legacy plaintext", async () => {
	expect(await accept(BASE)).toMatchObject({ ok: true });
	expect(readPeerTransportPolicy(db, PEER)).toBe("legacy_plaintext");
});

it("records nothing when the pairing itself is refused", async () => {
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ sync_coordinator_url: "http://127.0.0.1:1", sync_coordinator_group: "g1" }),
	);
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json,
		 projects_include_json, projects_exclude_json, created_at)
		 VALUES (?, ?, ?, '["127.0.0.1:1"]', '[]', '["secret"]', '2026-11-18T00:00:00.000Z')`,
	).run(PEER, BASE.fingerprint, BASE.public_key);

	const result = await accept({ ...BASE, transports: ["noise1"] }, "--all");

	expect(result).toEqual({
		error: "pairing_failed",
		message: expect.stringContaining("Nothing was changed"),
	});
	expect(readPeerTransportPolicy(db, PEER)).toBe("legacy_plaintext");
});

it.each([
	[["--payload-only", "--accept", "{}"], "usage_error"],
	[["--accept", "{}", "--accept-file", "x"], "usage_error"],
	[["--accept", "  "], "usage_error"],
	[["--include", "work"], "usage_error"],
	[["--accept", "not json"], "invalid_payload"],
	[["--accept", JSON.stringify({ ...BASE, fingerprint: "wrong" })], "fingerprint_mismatch"],
])("keeps the JSON error code for %o", async (args, code) => {
	expect(await pair(...args)).toMatchObject({ error: code });
});
