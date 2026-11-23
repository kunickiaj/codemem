import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterAll, expect, it } from "vitest";
import { waitingEffectBatches } from "./preact-frame-test-setup";

const container = document.createElement("div");
let bump: (() => void) | null = null;
let effectRuns = 0;

function Counter() {
	const [count, setCount] = useState(0);
	bump = () => setCount((value) => value + 1);
	useEffect(() => {
		effectRuns += 1;
	}, [count]);
	return <span>{count}</span>;
}

afterAll(() => {
	act(() => render(null, container));
	container.remove();
});

it("ends right after a render that schedules an effect outside act", async () => {
	// Arrange
	document.body.append(container);
	act(() => render(<Counter />, container));
	const runsBefore = effectRuns;

	// Act: a state change outside act schedules its effect for after the next frame.
	bump?.();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));

	// Assert: the effect is still waiting when this test ends.
	expect(container.textContent).toBe("1");
	expect(effectRuns).toBe(runsBefore);
	expect(waitingEffectBatches()).toBe(1);
});

it("starts with no effect left waiting from the previous test", () => {
	// Assert: the setup ran the waiting effect before the previous test's teardown.
	expect(waitingEffectBatches()).toBe(0);
	expect(effectRuns).toBe(2);
});
