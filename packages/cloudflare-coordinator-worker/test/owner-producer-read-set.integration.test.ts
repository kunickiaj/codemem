import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	exec,
	producer,
	reset,
	retain,
	state,
	timestamp,
} from "./owner-producer-consistency-test-fixtures.js";

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// Native D1 runs owner enrollment's retained-ownership reads and the guards that lead its
// write batch. A legacy completion naming the device, which only the negative owner reads
// select, lands after the reads and must refuse the enrollment there too.
it("native D1 refuses owner enrollment when retained history changes before the write", async () => {
	// Arrange
	const p = await producer("enrollment");
	await retain(p.subject);
	p.h.arm(async () => {
		await exec(
			"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES ('raced-group','raced-candidate',1,?,?,?)",
			`not json ${JSON.stringify(p.subject.deviceId)}`,
			timestamp,
			timestamp,
		);
	});
	// Act
	const outcome = await p.run();
	// Assert
	expect(p.h.observed()).toBe(true);
	expect(outcome).toBe(false);
	expect(await state()).toEqual(p.h.afterMutation());
});
