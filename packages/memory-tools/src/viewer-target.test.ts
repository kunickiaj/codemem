import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildViewerIdentityTarget,
	canonicalJson,
	isViewerTargetConflict,
	profileMatchesViewerTarget,
	resolveViewerDbPath,
	viewerCapabilities,
} from "./viewer-target.js";

describe("resolveViewerDbPath", () => {
	it("defaults to ~/.codemem/mem.sqlite", () => {
		expect(resolveViewerDbPath("/work", {})).toBe(join(homedir(), ".codemem", "mem.sqlite"));
	});

	it("expands ~/ with HOME and resolves relative paths from cwd", () => {
		expect(resolveViewerDbPath("/work", { CODEMEM_DB: "~/db.sqlite", HOME: "/home/x" })).toBe(
			"/home/x/db.sqlite",
		);
		expect(resolveViewerDbPath("/work", { CODEMEM_DB: "rel/db.sqlite" })).toBe(
			"/work/rel/db.sqlite",
		);
	});
});

describe("buildViewerIdentityTarget", () => {
	it("pins the default embedding revision only for the default model", () => {
		const withDefault = buildViewerIdentityTarget({ HOME: "/home/x" }, "/work");
		const custom = buildViewerIdentityTarget(
			{ HOME: "/home/x", CODEMEM_EMBEDDING_MODEL: "other/model" },
			"/work",
		);

		expect(withDefault.embedding_model).toBe("Xenova/bge-small-en-v1.5");
		expect(withDefault.embedding_revision).toMatch(/^[0-9a-f]{40}$/);
		expect(custom.embedding_revision).toBeNull();
	});

	it("distinguishes an unset actor from an empty one", () => {
		expect(buildViewerIdentityTarget({ HOME: "/h" }, "/w").actor_id_present).toBe(false);
		const empty = buildViewerIdentityTarget({ HOME: "/h", CODEMEM_ACTOR_ID: "" }, "/w");
		expect(empty.actor_id_present).toBe(true);
		expect(empty.actor_id).toBeNull();
	});

	it("parses boolean flags leniently", () => {
		const target = buildViewerIdentityTarget(
			{ HOME: "/h", CODEMEM_EMBEDDING_DISABLED: "YES", CODEMEM_EMBEDDING_OFFLINE: "0" },
			"/w",
		);
		expect(target.embedding_disabled).toBe(true);
		expect(target.embedding_offline).toBe(false);
	});
});

describe("profileMatchesViewerTarget", () => {
	const identity = buildViewerIdentityTarget({ HOME: "/home/x" }, "/work");
	const profile = {
		service: "codemem-viewer",
		protocol_version: 1,
		db_path: "/db.sqlite",
		identity_target: identity,
	};

	it("matches when service, protocol, db path, and identity agree", () => {
		expect(profileMatchesViewerTarget(profile, "/db.sqlite", identity)).toBe(true);
	});

	it("compares identity by canonical JSON so key order does not matter", () => {
		const reordered = Object.fromEntries(Object.entries(identity).reverse());
		expect(profileMatchesViewerTarget(profile, "/db.sqlite", reordered)).toBe(true);
	});

	it("rejects a different service, an incompatible protocol, or a different db", () => {
		expect(
			profileMatchesViewerTarget({ ...profile, service: "other" }, "/db.sqlite", identity),
		).toBe(false);
		expect(
			profileMatchesViewerTarget(
				{ ...profile, protocol_version: 2, min_supported_protocol_version: 2 },
				"/db.sqlite",
				identity,
			),
		).toBe(false);
		expect(profileMatchesViewerTarget(profile, "/other.sqlite", identity)).toBe(false);
	});
});

describe("viewerCapabilities", () => {
	it("reads string entries and ignores everything else", () => {
		expect([...viewerCapabilities({ capabilities: ["tool_directory", 3, null] })]).toEqual([
			"tool_directory",
		]);
		expect(viewerCapabilities({}).size).toBe(0);
		expect(viewerCapabilities("nope").size).toBe(0);
	});
});

describe("isViewerTargetConflict", () => {
	it("recognizes the 409 target-mismatch codes only", () => {
		expect(isViewerTargetConflict(409, { error: { code: "viewer_db_mismatch" } })).toBe(true);
		expect(isViewerTargetConflict(409, { error: { code: "other" } })).toBe(false);
		expect(isViewerTargetConflict(400, { error: { code: "viewer_db_mismatch" } })).toBe(false);
	});
});

describe("canonicalJson", () => {
	it("sorts object keys recursively and preserves array order", () => {
		expect(canonicalJson({ b: [2, { z: 1, a: 2 }], a: null })).toBe(
			'{"a":null,"b":[2,{"a":2,"z":1}]}',
		);
	});
});
