import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as enrollmentReceiver from "./coordinator-account-link-receiver.js";
import { enrollOwnerProfile } from "./coordinator-owner-profile-client.js";
import {
	facts,
	fixture,
	now,
	pin,
	prepared,
	read,
	registerOwnerProfileClientMockState,
} from "./coordinator-owner-profile-client-test-harness.js";
import { ownerFileSnapshot } from "./coordinator-owner-profile-files.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";

const signing = vi.hoisted(() => ({ corrupt: false }));
const databaseOpens = vi.hoisted(() => [] as Array<{ readonly?: boolean }>);
const platformAccess = vi.hoisted(() => ({ tracking: false, files: [] as string[], databases: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const tracked = Object.fromEntries(
		[
			"existsSync",
			"lstatSync",
			"statSync",
			"readFileSync",
			"writeFileSync",
			"mkdirSync",
			"openSync",
			"closeSync",
			"fsyncSync",
			"linkSync",
			"unlinkSync",
			"renameSync",
			"chmodSync",
			"copyFileSync",
			"rmSync",
			"readdirSync",
			"realpathSync",
		].map((name) => [
			name,
			(...args: unknown[]) => {
				if (platformAccess.tracking) platformAccess.files.push(name);
				return Reflect.apply(
					actual[name as keyof typeof actual] as (...args: unknown[]) => unknown,
					actual,
					args,
				);
			},
		]),
	);
	return { ...actual, ...tracked };
});
vi.mock("better-sqlite3", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof import("better-sqlite3") }>();
	return {
		...actual,
		default: new Proxy(actual.default, {
			construct(target, args, newTarget) {
				databaseOpens.push((args[1] as { readonly?: boolean } | undefined) ?? {});
				if (platformAccess.tracking) platformAccess.databases += 1;
				return Reflect.construct(target, args, newTarget);
			},
		}),
	};
});
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		sign: (...args: unknown[]) =>
			signing.corrupt ? Buffer.alloc(64) : Reflect.apply(actual.sign, undefined, args),
	};
});
registerOwnerProfileClientMockState({ signing, databaseOpens });

it.each([
	{ config: "~/config.json", database: "~/memory.sqlite" },
	{ config: "  ~/config.json  ", database: "~/memory.sqlite" },
	{ config: "", database: "" },
	{ config: "  ", database: "" },
])(
	"prepares with resolver-compatible profile environment (case %#)",
	async ({ config, database }) => {
		// Arrange: HOME points only at this test's existing isolated profile fixture.
		vi.stubEnv("HOME", fixture.directory);
		vi.stubEnv("CODEMEM_CONFIG", config);
		vi.stubEnv("CODEMEM_DB", database);
		const before = facts();
		const privateKey = readFileSync(join(fixture.options.keysDir, "device.key"));

		// Act: exercise the real core environment checks, not mocked path resolvers.
		const result = await enrollOwnerProfile(fixture.options);

		// Assert: a valid profile prepares without changing authorship, history or keys.
		expect(result.kind).toBe("prepared");
		expect(facts()).toEqual(before);
		expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(privateKey);
		expect(fixture.calls.map((call) => call.path)).toEqual(["/v1/auth/owner-config"]);
	},
);

it.each([
	{ variable: "CODEMEM_CONFIG", value: "  ~/private-other-config  " },
	{ variable: "CODEMEM_DB", value: "~/private-other-db" },
	{ variable: "CODEMEM_DB", value: " ~/memory.sqlite " },
	{ variable: "CODEMEM_KEYS_DIR", value: "~/keys" },
	{ variable: "CODEMEM_KEYS_DIR", value: " \tprivate-other-keys\t " },
])(
	"refuses different normalized $variable target before profile access (case %#)",
	async ({ variable, value }) => {
		// Arrange: config expands after trimming; DB whitespace and key tilde remain literal.
		vi.stubEnv("HOME", fixture.directory);
		vi.stubEnv(variable, value);
		platformAccess.files = [];
		platformAccess.databases = 0;
		platformAccess.tracking = true;

		// Act: isolate the core's early check from fixture inspection below.
		const result = await enrollOwnerProfile(fixture.options).then(
			() => null,
			(error: unknown) => error,
		);
		platformAccess.tracking = false;

		// Assert: only retained-state existence checks classify the sanitized failure.
		expect(result).toBeInstanceOf(Error);
		expect(String(result)).not.toMatch(/private-other|memory\.sqlite|~\/keys/);
		expect(platformAccess.files).toEqual(["existsSync", "existsSync", "existsSync"]);
		expect(platformAccess.databases).toBe(0);
		expect(fixture.calls).toEqual([]);
	},
);

it.each(["padded", "empty", "whitespace", "literal explicit"])(
	"prepares with runtime-compatible keys directory: %s",
	async (kind) => {
		// Arrange: explicit paths retain filename whitespace; only the environment is trimmed.
		if (kind === "literal explicit") {
			const literal = join(fixture.directory, "keys with spaces ");
			renameSync(fixture.options.keysDir, literal);
			fixture.options.keysDir = literal;
		}
		let environment = ` \t${fixture.options.keysDir}\t `;
		if (kind === "empty" || kind === "literal explicit") environment = "";
		if (kind === "whitespace") environment = " \t ";
		vi.stubEnv("CODEMEM_KEYS_DIR", environment);
		const before = facts();
		const key = ownerFileSnapshot(join(fixture.options.keysDir, "device.key"));
		const receiver = vi
			.spyOn(enrollmentReceiver, "createCoordinatorOwnerEnrollmentReceiver")
			.mockResolvedValue({
				destination: "http://127.0.0.1:43127/owner/callback",
				close: vi.fn().mockResolvedValue(undefined),
				completion: Promise.resolve({ completionSecret: "unused", confirmationHash: "unused" }),
			});
		// Act: core agrees with runtime env normalization without expanding explicit keys paths.
		const result = await enrollOwnerProfile(fixture.options);
		// Assert: prepare uses existing keys and preserves the exact selected path and history.
		expect(result.kind).toBe("prepared");
		expect(read("prepared.json").paths.keysDir).toBe(fixture.options.keysDir);
		expect(receiver).toHaveBeenCalledOnce();
		expect(facts()).toEqual(before);
		expect(ownerFileSnapshot(join(fixture.options.keysDir, "device.key"))).toEqual(key);
	},
);

it("rejects conflicting bootstrap actor state before issuing even config discovery", async () => {
	// Arrange: the bootstrap actor already conflicts with the existing profile.
	fixture.db
		.prepare(
			"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES ('local:device', 'Conflict', 0, 'active', ?, ?)",
		)
		.run(now, now);
	// Act: stop before discovery.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: no request or enrollment state is published.
	expect(fixture.calls).toEqual([]);
	expect(existsSync(fixture.options.stateDir)).toBe(false);
});

it.each([
	{ plural: ["private-other-group"] },
	{ plural: ["group", "private-other-group"] },
	{ plural: "group, private-other-group" },
	{ plural: [], singular: "private-other-group" },
	{ plural: " , ", singular: "private-other-group" },
])(
	"refuses incompatible effective groups including singular fallback (case %#)",
	async ({ plural, singular = "group" }) => {
		// Arrange: populated plural groups take precedence; empty lists use singular fallback.
		const config = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
		config.sync_coordinator_group = singular;
		config.sync_coordinator_groups = plural;
		writeFileSync(fixture.options.configPath, JSON.stringify(config));
		const snapshot = ownerFileSnapshot(fixture.options.configPath);
		const before = facts();
		const actors = fixture.db.prepare("SELECT * FROM actors").all();
		expect(readCoordinatorSyncConfig(config).syncCoordinatorGroups).toContain(
			"private-other-group",
		);
		// Act: refuse rather than remove existing group access or silently add grants.
		await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
		// Assert: refusal precedes discovery, state publication and profile mutation.
		expect(fixture.calls).toEqual([]);
		expect(existsSync(fixture.options.stateDir)).toBe(false);
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(snapshot);
		expect(facts()).toEqual(before);
		expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
	},
);
it.each([
	{ plural: [" group ", ""], singular: "group" },
	{ plural: " , group , ", singular: "group" },
	{ plural: [], singular: "group" },
	{ plural: ["", " \t ", 42], singular: "group" },
	{ plural: " , \t , ", singular: "group" },
	{ plural: ["group"], singular: "stale-group" },
	{ plural: " group ", singular: " stale-group " },
	{ plural: ["group"], singular: 42 },
])(
	"preserves parser-compatible plural settings through adoption (case %#)",
	async ({ plural, singular }) => {
		// Arrange: effective plural groups supersede stale singular values; empty lists fall back.
		const config = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
		config.sync_coordinator_group = singular;
		config.sync_coordinator_groups = plural;
		writeFileSync(fixture.options.configPath, JSON.stringify(config));
		const snapshot = ownerFileSnapshot(fixture.options.configPath);
		const before = facts();
		expect(readCoordinatorSyncConfig(config).syncCoordinatorGroups).toEqual(["group"]);
		// Act: prepare read-only, then adopt without reconciling the retained plural field.
		await prepared();
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(snapshot);
		const result = await enrollOwnerProfile(fixture.options);
		// Assert: future runtime discovery agrees with the receipt, and raw lists/history survive.
		const adopted = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
		expect(result).toMatchObject({ kind: "adopted", groups: ["group"] });
		expect(adopted.sync_coordinator_groups).toEqual(plural);
		expect(readCoordinatorSyncConfig(adopted).syncCoordinatorGroups).toEqual(["group"]);
		expect(facts()).toEqual(before);
	},
);
it.each(
	["", "group", "private-other-group"].flatMap((value) =>
		["prepare", "resume"].map((mode) => ({ value, mode })),
	),
)(
	"refuses defined plural environment before $mode discovery (case %#)",
	async ({ value, mode }) => {
		// Arrange: resume has a real saved request, not fabricated enrollment authority.
		if (mode === "resume") await prepared();
		const saved =
			mode === "resume"
				? ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))
				: undefined;
		const config = ownerFileSnapshot(fixture.options.configPath);
		const before = facts();
		vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", value);
		fixture.calls = [];
		// Act: defined overrides, including empty and matching values, cannot be persisted safely.
		const error = await enrollOwnerProfile(fixture.options).catch((error: unknown) => error);
		// Assert: no request or local adoption occurs, and error text hides private values.
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("private-other-group");
		expect(fixture.calls).toEqual([]);
		expect(fixture.finalBodies).toEqual([]);
		expect(facts()).toEqual(before);
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(config);
		if (saved)
			expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(saved);
		else expect(existsSync(fixture.options.stateDir)).toBe(false);
	},
);
it.each([" \tlocal:local\n", "", " \t ", null, 42, { invalid: true }])(
	"uses runtime-normalized configured actor for review and adoption (case %#)",
	async (actor) => {
		// Arrange: fallback uses the existing unsigned capture's actor without rewriting proof.
		if (typeof actor !== "string" || !actor.trim())
			fixture.db.prepare("UPDATE sync_device SET device_id = 'local'").run();
		const config = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
		config.actor_id = actor;
		writeFileSync(fixture.options.configPath, JSON.stringify(config));
		const snapshot = ownerFileSnapshot(fixture.options.configPath);
		const before = facts();
		// Act: normalization applies to both review and the pre-commit config comparison.
		await prepared();
		expect(read("prepared.json").review.actorId).toBe("local:local");
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(snapshot);
		const result = await enrollOwnerProfile(fixture.options);
		// Assert: only the adopted config identity changes; historical proof remains immutable.
		expect(result.kind).toBe("adopted");
		expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8")).actor_id).toBe("identity");
		expect(facts()).toEqual(before);
	},
);
it.each([" local:someone-else ", "", " \t ", null, 42])(
	"refuses normalized actor inconsistent with existing capture (case %#)",
	async (actor) => {
		// Arrange: fallback local:device cannot claim the existing local:local capture.
		const config = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
		config.actor_id = actor;
		writeFileSync(fixture.options.configPath, JSON.stringify(config));
		const snapshot = ownerFileSnapshot(fixture.options.configPath);
		const before = facts();
		// Act: runtime normalization cannot repair conflicting authorship.
		await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
		// Assert: no discovery, grants, config rewrite or history mutation.
		expect(fixture.calls).toEqual([]);
		expect(existsSync(fixture.options.stateDir)).toBe(false);
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(snapshot);
		expect(facts()).toEqual(before);
	},
);
it("refuses raw actor config drift even when both values normalize to the same actor", async () => {
	// Arrange: a saved review binds the exact original config bytes.
	const config = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
	config.actor_id = " local:local ";
	writeFileSync(fixture.options.configPath, JSON.stringify(config));
	await prepared();
	const saved = ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"));
	config.actor_id = "local:local";
	writeFileSync(fixture.options.configPath, JSON.stringify(config));
	const changed = ownerFileSnapshot(fixture.options.configPath);
	const before = facts();
	fixture.calls = [];
	// Act: effective actor equivalence must not bypass raw snapshot checks.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: retained evidence and intervening config remain untouched before POST.
	expect(fixture.calls).toEqual([]);
	expect(fixture.finalBodies).toEqual([]);
	expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(changed);
	expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(saved);
	expect(facts()).toEqual(before);
});

it("normalizes a configured coordinator trailing slash through prepare and adoption", async () => {
	// Arrange: ordinary config stores a URL with an optional trailing slash.
	const config = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
	config.sync_coordinator_url = `${pin.origin}/`;
	writeFileSync(fixture.options.configPath, JSON.stringify(config));
	fixture.options.coordinatorUrl = `${pin.origin}/`;
	const before = facts();

	// Act: review and adopt against the same normalized origin.
	await prepared();
	const result = await enrollOwnerProfile(fixture.options);

	// Assert: normalization does not change history or unrelated configuration.
	expect(result).toMatchObject({ kind: "adopted", identityId: "identity" });
	expect(facts()).toEqual(before);
	expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8"))).toMatchObject({
		sync_coordinator_url: pin.origin,
		unrelated: config.unrelated,
	});
});
it("rejects a different configured coordinator rather than normalizing it into agreement", async () => {
	// Arrange: a different origin is a conflict, not a cosmetic URL difference.
	const config = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
	config.sync_coordinator_url = "https://another.example/";
	writeFileSync(fixture.options.configPath, JSON.stringify(config));
	const before = facts();

	// Act: review must stop before contacting the configured coordinator.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();

	// Assert: no request or enrollment state is published.
	expect(fixture.calls).toEqual([]);
	expect(facts()).toEqual(before);
	expect(existsSync(fixture.options.stateDir)).toBe(false);
});

it.each([` ${pin.origin} `, "https://private-user:private-password@coordinator.example", null, 42])(
	"refuses malformed raw coordinator config before discovery (case %#)",
	async (url) => {
		// Arrange: the explicit valid URL must not conceal invalid retained config.
		const config = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
		config.sync_coordinator_url = url;
		writeFileSync(fixture.options.configPath, JSON.stringify(config));
		const snapshot = ownerFileSnapshot(fixture.options.configPath);
		const before = facts();
		// Act: reject raw URL whitespace, credentials and nonstring values without normalizing.
		const error = await enrollOwnerProfile(fixture.options).catch((error: unknown) => error);
		// Assert: sanitized refusal preserves the profile and never reaches the coordinator.
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("private-");
		expect(fixture.calls).toEqual([]);
		expect(facts()).toEqual(before);
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(snapshot);
		expect(existsSync(fixture.options.stateDir)).toBe(false);
	},
);

it.each(["CODEMEM_ACTOR_ID", "CODEMEM_DEVICE_ID", "CODEMEM_SYNC_COORDINATOR_URL"])(
	"denies %s overrides before any request or profile mutation",
	async (name) => {
		// Arrange: runtime overrides conflict with the profile being reviewed.
		vi.stubEnv(name, "conflicting");
		const before = facts();
		// Act: refuse the override.
		await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
		// Assert: leave profile and enrollment state unchanged without discovery.
		expect(fixture.calls).toEqual([]);
		expect(facts()).toEqual(before);
		expect(existsSync(fixture.options.stateDir)).toBe(false);
	},
);
