/**
 * Preact runs effects after the next frame. It starts a requestAnimationFrame and
 * a 35 ms timer, and whichever fires first cancels the other. When a render
 * schedules effects just before a test file ends, that timer can fire after the
 * jsdom environment is torn down. It then calls a cancelAnimationFrame that no
 * longer exists, and Vitest fails the run with an unhandled ReferenceError.
 *
 * This setup file schedules effects the same way, but keeps track of them. After
 * each test, and after each file, it cancels the frame and timers of any effects
 * still waiting and runs them inside act while the DOM still exists. No frame or
 * timer outlives the test that scheduled it.
 */
import { options } from "preact";
import { act } from "preact/test-utils";
import { afterAll, afterEach } from "vitest";

/** Preact's own fallback when no frame arrives. */
const FRAME_TIMEOUT_MS = 35;

interface WaitingEffects {
	flush: () => void;
	frame: number;
	timers: Array<ReturnType<typeof setTimeout>>;
}

const waiting = new Set<WaitingEffects>();

function scheduleAfterNextFrame(flush: () => void): void {
	const entry: WaitingEffects = { flush, frame: 0, timers: [] };
	waiting.add(entry);
	let painted = false;
	const afterPaint = () => {
		if (painted) return;
		painted = true;
		for (const timer of entry.timers) clearTimeout(timer);
		cancelAnimationFrame(entry.frame);
		entry.timers = [
			setTimeout(() => {
				if (waiting.delete(entry)) flush();
			}),
		];
	};
	entry.timers.push(setTimeout(afterPaint, FRAME_TIMEOUT_MS));
	entry.frame = requestAnimationFrame(afterPaint);
}

function runWaitingEffects(): void {
	for (const entry of [...waiting]) {
		waiting.delete(entry);
		for (const timer of entry.timers) clearTimeout(timer);
		cancelAnimationFrame(entry.frame);
		act(() => entry.flush());
	}
}

/** How many scheduled effect batches haven't run yet. */
export function waitingEffectBatches(): number {
	return waiting.size;
}

(options as { requestAnimationFrame?: (flush: () => void) => void }).requestAnimationFrame =
	scheduleAfterNextFrame;

afterEach(runWaitingEffects);
afterAll(runWaitingEffects);
