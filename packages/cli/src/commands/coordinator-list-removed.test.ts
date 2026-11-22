import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BetterSqliteCoordinatorStore, createCoordinatorApp } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCoordinatorCommand } from "./coordinator.js";

const origin = "https://coordinator.example.test";
const secret = "fixture-removal-list-secret";
const publicKey =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea";
const config = vi.hoisted(() => vi.fn());
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	readCodememConfigFileAtPath: config,
}));

const initialExitCode = process.exitCode;
beforeEach(() => {
	process.exitCode = undefined;
	config.mockReturnValue({
		sync_coordinator_url: origin,
		sync_coordinator_admin_secret: secret,
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
});
afterEach(() => {
	process.exitCode = initialExitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function run(...args: string[]) {
	return buildCoordinatorCommand().parseAsync(["device", "list", "--json", ...args], {
		from: "user",
	});
}

function output(): unknown {
	return JSON.parse(String(vi.mocked(console.log).mock.lastCall?.[0]));
}

async function remove(store: BetterSqliteCoordinatorStore, groupId: string, deviceId: string) {
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, { deviceId, publicKey, fingerprint: "fixture" });
	expect(await store.removeDevice(groupId, deviceId)).toBe(true);
}

it("lists a removed device from an existing local coordinator, with or without a group filter", async () => {
	const root = mkdtempSync(join(tmpdir(), "codemem-cli-removals-"));
	const path = join(root, "coordinator.sqlite");
	try {
		const store = new BetterSqliteCoordinatorStore(path);
		try {
			await remove(store, "group-a", "device-a");
		} finally {
			await store.close();
		}
		await run("--removed", "--db-path", path);
		expect(output()).toMatchObject([{ group_id: "group-a", device_id: "device-a" }]);
		await run("group-b", "--removed", "--db-path", path);
		expect(output()).toEqual([]);
		await run("group-a", "--db-path", path);
		expect(output()).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each(["--config", "-c"])("lists through the merged admin route using %s", async (flag) => {
	const store = new BetterSqliteCoordinatorStore(":memory:");
	const close = vi.spyOn(store, "close").mockResolvedValue();
	try {
		await remove(store, "group-a", "device-a");
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => secret, now: () => "2026-11-21T00:00:00.000Z" },
			requestVerifier: () => false,
		});
		vi.mocked(fetch).mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			expect(request.url).toBe(`${origin}/v1/admin/devices/removals`);
			return app.request(request);
		});
		await run("--removed", flag, "fixture.json");
		expect(config).toHaveBeenCalledWith("fixture.json");
		expect(output()).toMatchObject([{ group_id: "group-a", device_id: "device-a" }]);
		expect(process.exitCode).toBeUndefined();
	} finally {
		close.mockRestore();
		await store.close();
	}
});

const item = {
	group_id: "group-a",
	device_id: "device-a",
	removal_id: "removal-a",
	fingerprint: "fixture",
	key_id: null,
	display_name: null,
	identity_id: null,
	removed_at: "2026-11-21T00:00:00.000Z",
	removal_seq: 1,
};

it("follows the cursor before filtering a remote listing and omits unrecognized fields", async () => {
	vi.mocked(fetch)
		.mockResolvedValueOnce(
			Response.json({
				version: 1,
				next_before_seq: 2,
				items: [{ ...item, group_id: "group-b", removal_seq: 2 }],
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				version: 1,
				next_before_seq: null,
				items: [{ ...item, private_field: secret }],
			}),
		);
	await run("group-a", "--removed", "--config", "fixture.json");
	expect(output()).toEqual([item]);
	expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe(
		`${origin}/v1/admin/devices/removals?before_seq=2`,
	);
});

it("fails without a partial result when a remote cursor does not advance", async () => {
	const page = () => Response.json({ version: 1, items: [item], next_before_seq: 1 });
	vi.mocked(fetch).mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
	await run("--removed", "--config", "fixture.json");
	expect(output()).toMatchObject({ error: "list_devices_failed" });
	expect(console.log).toHaveBeenCalledOnce();
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(process.exitCode).toBe(1);
});

it("reports an older coordinator without falling back to any other listing", async () => {
	vi.mocked(fetch).mockResolvedValueOnce(new Response(secret, { status: 404 }));
	await run("--removed", "--config", "fixture.json");
	expect(output()).toEqual({
		error: "list_devices_failed",
		message: "Update the coordinator to list removed devices.",
	});
	expect(fetch).toHaveBeenCalledOnce();
	expect(process.exitCode).toBe(1);
});

it("does not contact the coordinator when its saved admin secret is invalid", async () => {
	config.mockReturnValue({ sync_coordinator_url: origin, sync_coordinator_admin_secret: 123 });
	await run("--removed", "--config", "fixture.json");
	expect(output()).toMatchObject({ error: "list_devices_failed" });
	expect(fetch).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});

it("does not broaden an empty group filter to the whole coordinator", async () => {
	await run(" ", "--removed", "--config", "fixture.json");
	expect(output()).toEqual({
		error: "list_devices_failed",
		message: "Enter a group ID or omit the group filter.",
	});
	expect(fetch).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});
