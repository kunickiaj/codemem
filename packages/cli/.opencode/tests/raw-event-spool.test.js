import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	DEFAULT_MAX_ENTRIES,
	RAW_EVENT_SPOOL_FULL_CODE,
	loadRawEventSpoolEntries,
	removeRawEventSpoolEntry,
	resolveSpoolDirectory,
	writeRawEventSpoolEntry,
} from "../../../opencode-plugin/.opencode/lib/raw-event-spool.js";

describe("OpenCode raw-event spool", () => {
	const temporaryHomes = [];

	afterEach(() => {
		for (const home of temporaryHomes.splice(0)) {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("uses one stable private entry for duplicate event IDs", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "codemem-opencode-spool-helper-"));
		temporaryHomes.push(homeDir);
		const envelope = { event_id: "event-stable", event_type: "tool", payload: { value: 1 } };
		const serialized = JSON.stringify(envelope);

		await writeRawEventSpoolEntry({ envelope, serialized, homeDir });
		await writeRawEventSpoolEntry({ envelope, serialized, homeDir });

		const directory = resolveSpoolDirectory(homeDir);
		const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
		expect(files).toHaveLength(1);
		expect(readFileSync(join(directory, files[0]), "utf8")).toBe(serialized);
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(join(directory, files[0])).mode & 0o777).toBe(0o600);
	});

	test("retains corrupt entries while loading valid envelopes", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "codemem-opencode-spool-corrupt-"));
		temporaryHomes.push(homeDir);
		const envelope = { event_id: "event-valid", event_type: "tool", payload: {} };
		await writeRawEventSpoolEntry({ envelope, homeDir });
		const directory = resolveSpoolDirectory(homeDir);
		const corruptPath = join(directory, "corrupt.json");
		writeFileSync(corruptPath, "{not-json", { mode: 0o600 });

		const loaded = await loadRawEventSpoolEntries({ homeDir, limit: 10 });

		expect(loaded.entries.map((entry) => entry.eventId)).toEqual(["event-valid"]);
		expect(loaded.corruptCount).toBe(1);
		expect(readFileSync(corruptPath, "utf8")).toBe("{not-json");
		await removeRawEventSpoolEntry({ eventId: "event-valid", homeDir });
		expect(readdirSync(directory)).toEqual(["corrupt.json"]);
	});

	test("loads a valid entry after a limit-sized corrupt prefix", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "codemem-opencode-spool-starvation-"));
		temporaryHomes.push(homeDir);
		await writeRawEventSpoolEntry({ envelope: { event_id: "event-valid" }, homeDir });
		const directory = resolveSpoolDirectory(homeDir);
		for (let index = 0; index < 2; index += 1) {
			const path = join(directory, `corrupt-${index}.json`);
			writeFileSync(path, "{not-json", { mode: 0o600 });
			utimesSync(path, new Date(1_000 + index), new Date(1_000 + index));
		}
		const validFile = readdirSync(directory).find((name) => !name.startsWith("corrupt-"));
		utimesSync(join(directory, validFile), new Date(3_000), new Date(3_000));

		const loaded = await loadRawEventSpoolEntries({ homeDir, limit: 2 });

		expect(loaded.entries.map((entry) => entry.eventId)).toEqual(["event-valid"]);
		expect(loaded.corruptCount).toBe(2);
	});

	test("keeps a duplicate event id idempotent at max capacity", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "codemem-opencode-spool-full-duplicate-"));
		temporaryHomes.push(homeDir);
		const envelope = { event_id: "event-existing", payload: { stable: true } };
		const serialized = JSON.stringify(envelope);
		await writeRawEventSpoolEntry({ envelope, serialized, homeDir, maxEntries: 1 });

		await expect(
			writeRawEventSpoolEntry({ envelope, serialized, homeDir, maxEntries: 1 }),
		).resolves.toEqual({ eventId: "event-existing", serialized });
	});

	test("rejects a new event id at max capacity without evicting entries", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "codemem-opencode-spool-full-new-"));
		temporaryHomes.push(homeDir);
		await writeRawEventSpoolEntry({
			envelope: { event_id: "event-existing" },
			homeDir,
			maxEntries: 1,
		});

		await expect(
			writeRawEventSpoolEntry({
				envelope: { event_id: "event-new" },
				homeDir,
				maxEntries: 1,
			}),
		).rejects.toThrow("raw event spool is full");
		const loaded = await loadRawEventSpoolEntries({ homeDir, limit: 10 });
		expect(loaded.entries.map((entry) => entry.eventId)).toEqual(["event-existing"]);
	});

	test("enforces max capacity across concurrent writes", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "codemem-opencode-spool-full-race-"));
		temporaryHomes.push(homeDir);

		const results = await Promise.allSettled([
			writeRawEventSpoolEntry({ envelope: { event_id: "event-first" }, homeDir, maxEntries: 1 }),
			writeRawEventSpoolEntry({ envelope: { event_id: "event-second" }, homeDir, maxEntries: 1 }),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected").reason?.code).toBe(
			RAW_EVENT_SPOOL_FULL_CODE,
		);
		const directory = resolveSpoolDirectory(homeDir);
		expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
	});

	test("conflicting concurrent writes never overwrite the winning envelope", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "codemem-opencode-spool-conflict-"));
		temporaryHomes.push(homeDir);
		const first = { event_id: "event-race", payload: { value: 1 } };
		const second = { event_id: "event-race", payload: { value: 2 } };
		const firstSerialized = JSON.stringify(first);
		const secondSerialized = JSON.stringify(second);

		const results = await Promise.allSettled([
			writeRawEventSpoolEntry({ envelope: first, serialized: firstSerialized, homeDir }),
			writeRawEventSpoolEntry({ envelope: second, serialized: secondSerialized, homeDir }),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const winner = results.find((result) => result.status === "fulfilled").value.serialized;
		const directory = resolveSpoolDirectory(homeDir);
		const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
		expect(files).toHaveLength(1);
		expect(readFileSync(join(directory, files[0]), "utf8")).toBe(winner);
		expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("exports the stable default max-entry ceiling", () => {
		expect(DEFAULT_MAX_ENTRIES).toBe(2000);
		expect(RAW_EVENT_SPOOL_FULL_CODE).toBe("raw_event_spool_full");
	});

	test("loads a bounded oldest-first set", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "codemem-opencode-spool-order-"));
		temporaryHomes.push(homeDir);
		await writeRawEventSpoolEntry({ envelope: { event_id: "newer" }, homeDir });
		await writeRawEventSpoolEntry({ envelope: { event_id: "older" }, homeDir });
		const directory = resolveSpoolDirectory(homeDir);
		const loaded = await loadRawEventSpoolEntries({ homeDir, limit: 10 });
		const olderEntry = loaded.entries.find((entry) => entry.eventId === "older");
		const newerEntry = loaded.entries.find((entry) => entry.eventId === "newer");
		expect(olderEntry).toBeTruthy();
		expect(newerEntry).toBeTruthy();
		const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
		const olderFile = files.find((name) =>
			readFileSync(join(directory, name), "utf8").includes("older"),
		);
		const newerFile = files.find((name) =>
			readFileSync(join(directory, name), "utf8").includes("newer"),
		);
		utimesSync(join(directory, olderFile), new Date(1_000), new Date(1_000));
		utimesSync(join(directory, newerFile), new Date(2_000), new Date(2_000));

		const bounded = await loadRawEventSpoolEntries({ homeDir, limit: 1 });

		expect(bounded.entries.map((entry) => entry.eventId)).toEqual(["older"]);
	});
});
