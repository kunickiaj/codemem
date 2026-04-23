import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addressDedupeKey,
	advertiseMdns,
	discoverPeersViaMdns,
	loadPeerAddresses,
	mdnsAddressesForPeer,
	mdnsEnabled,
	mergeAddresses,
	normalizeAddress,
	recordPeerSuccess,
	recordSyncAttempt,
	selectDialAddresses,
	updatePeerAddresses,
} from "./sync-discovery.js";
import { initTestSchema } from "./test-utils.js";

// ---------------------------------------------------------------------------
// normalizeAddress
// ---------------------------------------------------------------------------

describe("normalizeAddress", () => {
	it("normalizes host:port to http://host:port", () => {
		expect(normalizeAddress("192.168.1.1:9090")).toBe("http://192.168.1.1:9090");
	});

	it("normalizes host:port with uppercase", () => {
		expect(normalizeAddress("MyHost:8080")).toBe("http://myhost:8080");
	});

	it("preserves scheme and strips default port", () => {
		// Default ports (443 for https, 80 for http) are stripped — semantically equivalent
		expect(normalizeAddress("https://example.com:443/path/")).toBe("https://example.com/path");
		expect(normalizeAddress("https://example.com:8443/path/")).toBe(
			"https://example.com:8443/path",
		);
	});

	it("strips trailing slashes and default port", () => {
		expect(normalizeAddress("http://host:80/")).toBe("http://host");
		expect(normalizeAddress("http://host:8080/")).toBe("http://host:8080");
	});

	it("returns empty for empty input", () => {
		expect(normalizeAddress("")).toBe("");
		expect(normalizeAddress("  ")).toBe("");
	});

	it("returns empty for invalid port", () => {
		expect(normalizeAddress("host:99999")).toBe("");
		expect(normalizeAddress("host:0")).toBe("");
	});

	it("handles http:// prefix without port", () => {
		expect(normalizeAddress("http://example.com")).toBe("http://example.com");
	});
});

// ---------------------------------------------------------------------------
// addressDedupeKey
// ---------------------------------------------------------------------------

describe("addressDedupeKey", () => {
	it("strips http scheme for host:port", () => {
		expect(addressDedupeKey("http://192.168.1.1:9090")).toBe("192.168.1.1:9090");
	});

	it("returns as-is for non-URL input", () => {
		expect(addressDedupeKey("not-a-url")).toBe("not-a-url");
	});

	it("returns empty for empty input", () => {
		expect(addressDedupeKey("")).toBe("");
	});

	it("returns full URL for addresses with paths", () => {
		// Port 80 is default for http, so dedup key is just the host
		expect(addressDedupeKey("http://host:80/path")).toBe("host");
		// Non-default port preserves host:port
		expect(addressDedupeKey("http://host:8080/path")).toBe("host:8080");
	});
});

// ---------------------------------------------------------------------------
// mergeAddresses
// ---------------------------------------------------------------------------

describe("mergeAddresses", () => {
	it("deduplicates addresses", () => {
		const result = mergeAddresses(
			["http://host:8080", "192.168.1.1:9090"],
			["host:8080", "http://192.168.1.1:9090"],
		);
		expect(result).toEqual(["http://host:8080", "http://192.168.1.1:9090"]);
	});

	it("preserves order (existing first)", () => {
		const result = mergeAddresses(["a.com:1"], ["b.com:2"]);
		expect(result).toEqual(["http://a.com:1", "http://b.com:2"]);
	});

	it("filters out empty after normalization", () => {
		const result = mergeAddresses(["", "  "], ["host:8080"]);
		expect(result).toEqual(["http://host:8080"]);
	});
});

// ---------------------------------------------------------------------------
// selectDialAddresses
// ---------------------------------------------------------------------------

describe("selectDialAddresses", () => {
	it("returns stored when no mDNS", () => {
		const result = selectDialAddresses({ stored: ["host:8080"], mdns: [] });
		expect(result).toEqual(["http://host:8080"]);
	});

	it("puts mDNS first when available", () => {
		const result = selectDialAddresses({
			stored: ["stored:8080"],
			mdns: ["mdns:9090"],
		});
		expect(result[0]).toBe("http://mdns:9090");
		expect(result[1]).toBe("http://stored:8080");
	});
});

// ---------------------------------------------------------------------------
// DB round-trip: loadPeerAddresses / updatePeerAddresses
// ---------------------------------------------------------------------------

describe("peer address storage", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns empty for unknown peer", () => {
		expect(loadPeerAddresses(db, "unknown")).toEqual([]);
	});

	it("round-trips addresses through update/load", () => {
		updatePeerAddresses(db, "peer-1", ["192.168.1.1:9090"], {
			name: "test-peer",
			pinnedFingerprint: "abc123",
		});
		const loaded = loadPeerAddresses(db, "peer-1");
		expect(loaded).toEqual(["http://192.168.1.1:9090"]);
	});

	it("merges new addresses on subsequent updates", () => {
		updatePeerAddresses(db, "peer-1", ["host1:8080"]);
		updatePeerAddresses(db, "peer-1", ["host2:9090"]);
		const loaded = loadPeerAddresses(db, "peer-1");
		expect(loaded).toEqual(["http://host1:8080", "http://host2:9090"]);
	});

	it("deduplicates on merge", () => {
		updatePeerAddresses(db, "peer-1", ["host:8080"]);
		updatePeerAddresses(db, "peer-1", ["http://host:8080"]);
		const loaded = loadPeerAddresses(db, "peer-1");
		expect(loaded).toEqual(["http://host:8080"]);
	});
});

// ---------------------------------------------------------------------------
// recordSyncAttempt
// ---------------------------------------------------------------------------

describe("recordSyncAttempt", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "fp", new Date().toISOString());
	});

	afterEach(() => {
		db.close();
	});

	it("records a successful attempt and clears last_error", () => {
		// Set an error first
		db.prepare("UPDATE sync_peers SET last_error = ? WHERE peer_device_id = ?").run(
			"old error",
			"peer-1",
		);
		recordSyncAttempt(db, "peer-1", { ok: true, opsIn: 5, opsOut: 3 });

		const attempt = db
			.prepare("SELECT * FROM sync_attempts WHERE peer_device_id = ?")
			.get("peer-1") as Record<string, unknown>;
		expect(attempt.ok).toBe(1);
		expect(attempt.ops_in).toBe(5);
		expect(attempt.ops_out).toBe(3);

		const peer = db
			.prepare("SELECT last_error FROM sync_peers WHERE peer_device_id = ?")
			.get("peer-1") as Record<string, unknown>;
		expect(peer.last_error).toBeNull();
	});

	it("records a failed attempt with error", () => {
		recordSyncAttempt(db, "peer-1", { ok: false, error: "connection refused" });

		const peer = db
			.prepare("SELECT last_error FROM sync_peers WHERE peer_device_id = ?")
			.get("peer-1") as Record<string, unknown>;
		expect(peer.last_error).toBe("connection refused");
	});
});

// ---------------------------------------------------------------------------
// recordPeerSuccess
// ---------------------------------------------------------------------------

describe("recordPeerSuccess", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("promotes successful address to front", () => {
		updatePeerAddresses(db, "peer-1", ["host1:8080", "host2:90"], {
			pinnedFingerprint: "fp",
		});
		const ordered = recordPeerSuccess(db, "peer-1", "host2:90");
		expect(ordered[0]).toBe("http://host2:90");
		expect(ordered[1]).toBe("http://host1:8080");
	});

	it("handles null address gracefully", () => {
		updatePeerAddresses(db, "peer-1", ["host1:8080"], {
			pinnedFingerprint: "fp",
		});
		const ordered = recordPeerSuccess(db, "peer-1", null);
		expect(ordered).toEqual(["http://host1:8080"]);
	});
});

// ---------------------------------------------------------------------------
// mdnsEnabled
// ---------------------------------------------------------------------------

describe("mdnsEnabled", () => {
	let tmpDir: string;
	let configPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-mdns-test-"));
		configPath = join(tmpDir, "config.json");
		vi.stubEnv("CODEMEM_CONFIG", configPath);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false with no env and no config", () => {
		vi.stubEnv("CODEMEM_SYNC_MDNS", "");
		expect(mdnsEnabled()).toBe(false);
	});

	it("env '1' wins over missing config", () => {
		vi.stubEnv("CODEMEM_SYNC_MDNS", "1");
		expect(mdnsEnabled()).toBe(true);
	});

	it("env 'true' wins over missing config", () => {
		vi.stubEnv("CODEMEM_SYNC_MDNS", "true");
		expect(mdnsEnabled()).toBe(true);
	});

	it("env '0' explicitly disables even if config says enabled", () => {
		writeFileSync(configPath, JSON.stringify({ sync_mdns: true }));
		vi.stubEnv("CODEMEM_SYNC_MDNS", "0");
		expect(mdnsEnabled()).toBe(false);
	});

	it("config sync_mdns=true enables when env is unset", () => {
		writeFileSync(configPath, JSON.stringify({ sync_mdns: true }));
		vi.stubEnv("CODEMEM_SYNC_MDNS", "");
		expect(mdnsEnabled()).toBe(true);
	});

	it("config sync_mdns=false keeps it disabled when env is unset", () => {
		writeFileSync(configPath, JSON.stringify({ sync_mdns: false }));
		vi.stubEnv("CODEMEM_SYNC_MDNS", "");
		expect(mdnsEnabled()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// mdnsAddressesForPeer
// ---------------------------------------------------------------------------

describe("mdnsAddressesForPeer", () => {
	it("extracts addresses matching peer device ID", () => {
		const entries = [
			{
				host: "peer-host.local",
				port: 9090,
				properties: { device_id: "peer-1" },
			},
			{
				host: "other-host.local",
				port: 9091,
				properties: { device_id: "peer-2" },
			},
		];
		const addresses = mdnsAddressesForPeer("peer-1", entries);
		expect(addresses).toEqual(["peer-host.local:9090"]);
	});

	it("returns empty for no matching peer", () => {
		const entries = [
			{
				host: "host.local",
				port: 9090,
				properties: { device_id: "other" },
			},
		];
		expect(mdnsAddressesForPeer("peer-1", entries)).toEqual([]);
	});

	it("skips entries without device_id property", () => {
		const entries = [{ host: "host.local", port: 9090, properties: {} }];
		expect(mdnsAddressesForPeer("peer-1", entries)).toEqual([]);
	});

	it("handles Uint8Array device_id", () => {
		const entries = [
			{
				host: "host.local",
				port: 9090,
				properties: { device_id: new TextEncoder().encode("peer-1") },
			},
		];
		expect(mdnsAddressesForPeer("peer-1", entries)).toEqual(["host.local:9090"]);
	});
});

describe("mDNS runtime hooks", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-mdns-runtime-"));
		vi.stubEnv("CODEMEM_CONFIG", join(tmpDir, "config.json"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns no entries and no-op close when mDNS is disabled", async () => {
		vi.stubEnv("CODEMEM_SYNC_MDNS", "0");
		await expect(discoverPeersViaMdns()).resolves.toEqual([]);
		expect(() => advertiseMdns("dev-local", 7337).close()).not.toThrow();
	});
});
