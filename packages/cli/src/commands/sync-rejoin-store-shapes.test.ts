import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, ensureDeviceIdentity } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareOfflineScopeServingStore } from "../../../core/src/offline-serving-preparation.js";
import { buildSyncRejoinCommand } from "./sync-rejoin.js";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	log: { error: vi.fn(), success: vi.fn(), warn: vi.fn(), message: vi.fn() },
}));
vi.mock("@clack/prompts", () => ({ log: mocks.log }));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	readCodememConfigFileAtPath: () => ({ sync_coordinator_url: "https://coordinator.example.test" }),
	runDeviceRejoin: mocks.run,
}));

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const initialExitCode = process.exitCode;
let dir = "";

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	process.exitCode = undefined;
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	dir = mkdtempSync(join(tmpdir(), "codemem-cli-rejoin-shapes-"));
});

afterEach(() => {
	process.exitCode = initialExitCode;
	if (ttyDescriptor) Object.defineProperty(process.stderr, "isTTY", ttyDescriptor);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

it("starts rejoin with the same device from a store before and after its transition", async () => {
	const dbPath = join(dir, "device.sqlite");
	const keysDir = join(dir, "keys");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	const db = connect(dbPath);
	let deviceId: string;
	try {
		[deviceId] = ensureDeviceIdentity(db, { keysDir });
	} finally {
		db.close();
	}
	const started: unknown[] = [];
	mocks.run.mockImplementation(async (options) => {
		started.push({ deviceId: options.deviceId, current: options.assertCurrentContext() });
		return { kind: "finalized", receipt: { groupIds: ["group-a"] } };
	});
	const rejoin = () =>
		buildSyncRejoinCommand().parseAsync(["--db-path", dbPath, "--config", "fixture.json"], {
			from: "user",
		});
	await rejoin();
	prepareOfflineScopeServingStore(
		dbPath,
		{
			coordinatorId: "fixture",
			groupId: "group-a",
			generation: "ddc460b1-6dd8-4489-ab5c-799c2319af62",
		},
		[],
	);
	await rejoin();
	expect(process.exitCode).toBeUndefined();
	expect(started).toEqual([
		{ deviceId, current: true },
		{ deviceId, current: true },
	]);
	const { readDeviceStorageShape } = await import("../../../core/src/device-database-open.js");
	expect(readDeviceStorageShape(dbPath)).toBe("transitioned");
});
