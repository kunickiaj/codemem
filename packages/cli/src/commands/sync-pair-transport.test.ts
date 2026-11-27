import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPairingPayload,
	connect,
	fingerprintPublicKey,
	initTestSchema,
	loadPublicKey,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncCommand } from "./sync.js";

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

// The CLI still builds its payload inline. This keeps it identical to the shared builder until
// the pair command is split and calls the builder directly.
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
