import { vi } from "vitest";

/** Isolate listeners installed by each fresh app import, including focus and hash routing. */
export function trackAppListeners(): () => void {
	const cleanups: Array<() => void> = [];
	for (const target of [document, window] as EventTarget[]) {
		const addEventListener = target.addEventListener.bind(target);
		vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
			cleanups.push(() => target.removeEventListener(type, listener, options));
			addEventListener(type, listener, options);
		});
	}
	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}
