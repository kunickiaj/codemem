import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
	loadRawEventSpoolEntries,
	writeRawEventSpoolEntry,
} from "../.opencode/lib/raw-event-spool.js";

const race = vi.hoisted(() => ({ published: null }));
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		link: async (_temporary, destination) => {
			await actual.writeFile(destination, JSON.stringify(race.published));
			const error = new Error("synthetic concurrent publish");
			error.code = "EEXIST";
			throw error;
		},
	};
});

test("concurrent publish keeps the first copy when only delivery time differs", async () => {
	const home = await mkdtemp(join(tmpdir(), "codemem-spool-publish-"));
	const original = {
		event_id: "same-event-id",
		event_type: "user_prompt",
		session_id: "session-1",
		ts_wall_ms: 1,
		ts_mono_ms: 0.1,
		payload: { prompt_text: "same semantic event" },
	};
	race.published = original;
	try {
		const result = await writeRawEventSpoolEntry({
			homeDir: home,
			envelope: { ...original, ts_wall_ms: 2, ts_mono_ms: 0.2 },
		});
		expect(result.eventId).toBe("same-event-id");
		expect((await loadRawEventSpoolEntries({ homeDir: home })).entries[0].serialized).toBe(
			JSON.stringify(original),
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("concurrent publish rejects different content with the same ID", async () => {
	const home = await mkdtemp(join(tmpdir(), "codemem-spool-publish-conflict-"));
	const original = {
		event_id: "same-event-id",
		event_type: "user_prompt",
		session_id: "session-1",
		ts_wall_ms: 1,
		ts_mono_ms: 0.1,
		payload: { prompt_text: "first event" },
	};
	race.published = original;
	try {
		await expect(
			writeRawEventSpoolEntry({
				homeDir: home,
				envelope: { ...original, ts_wall_ms: 2, payload: { prompt_text: "different event" } },
			}),
		).rejects.toThrow("conflicts with existing event_id");
		expect((await loadRawEventSpoolEntries({ homeDir: home })).entries[0].serialized).toBe(
			JSON.stringify(original),
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
