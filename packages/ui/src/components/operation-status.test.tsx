import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountOperationStatusHost, startOperationStatus } from "./operation-status";

let root: HTMLElement;
let header: HTMLElement;
let height: number;
let notifyResize: () => void;
const observe = vi.fn();
const disconnect = vi.fn();
const disposers: Array<() => void> = [];

function mount() {
	let dispose!: () => void;
	act(() => {
		dispose = mountOperationStatusHost(root);
	});
	disposers.push(dispose);
	return dispose;
}

function start(message = "Syncing devices…") {
	let token!: ReturnType<typeof startOperationStatus>;
	act(() => {
		token = startOperationStatus(message, "You can keep browsing.");
	});
	if (!token) throw new Error("Expected mounted operation host");
	return token;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = observe;
			disconnect = disconnect;
			constructor(callback: ResizeObserverCallback) {
				notifyResize = () => callback([], this as unknown as ResizeObserver);
			}
		},
	);
	document.body.innerHTML =
		'<header><div id="operationStatusRoot"></div></header><button id="other">Other action</button>';
	root = document.getElementById("operationStatusRoot") as HTMLElement;
	header = document.querySelector("header") as HTMLElement;
	height = 60;
	vi.spyOn(header, "getBoundingClientRect").mockImplementation(() => ({ height }) as DOMRect);
});

afterEach(() => {
	act(() => {
		for (const dispose of disposers.splice(0)) dispose();
	});
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.body.innerHTML = "";
	document.body.style.removeProperty("--header-sticky-offset");
});

describe("operation status host", () => {
	it("mounts one empty polite live region even when initialized twice", () => {
		// Arrange
		const dispose = mount();
		const liveRegion = root.querySelector('[role="status"]');
		// Act
		const repeatedDispose = mount();
		// Assert
		expect(repeatedDispose).toBe(dispose);
		expect(root.querySelectorAll('[role="status"]')).toHaveLength(1);
		expect(root.querySelector('[role="status"]')).toBe(liveRegion);
		expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
		expect(liveRegion?.getAttribute("aria-atomic")).toBe("true");
		expect(root.textContent).toBe("");
		expect(observe).toHaveBeenCalledExactlyOnceWith(header);
	});

	it("keeps pending work visible after nine seconds without cancel, dismiss, or focus changes", async () => {
		// Arrange
		mount();
		const other = document.getElementById("other") as HTMLButtonElement;
		other.focus();
		// Act
		start();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(9_000);
		});
		// Assert
		expect(root.textContent).toContain("Syncing devices…");
		expect(root.textContent).toContain("You can keep browsing.");
		expect(root.querySelector('[data-tone="pending"]')).not.toBeNull();
		expect(root.querySelector("button")).toBeNull();
		expect(root.textContent).not.toMatch(/cancel|dismiss|\d+%/i);
		expect(document.activeElement).toBe(other);
	});

	it.each(["success", "warning"] as const)(
		"dismisses a %s result but leaves the live region ready",
		(tone) => {
			// Arrange
			mount();
			const token = start();
			act(() => {
				expect(token.finish("<b>Confirmed result</b>", tone)).toBe(true);
			});
			const dismiss = root.querySelector("button") as HTMLButtonElement;
			expect(root.querySelector(`[data-tone="${tone}"]`)).not.toBeNull();
			expect(root.querySelector("b")).toBeNull();
			expect(root.querySelectorAll("button")).toHaveLength(1);
			expect(dismiss.getAttribute("aria-label")).toMatch(/dismiss/i);
			// Act
			act(() => dismiss.click());
			// Assert
			expect(root.textContent).toBe("");
			expect(root.querySelector("[data-tone]")).toBeNull();
			expect(root.querySelector('[role="status"]')).not.toBeNull();
			expect(token.finish("Late rewrite", tone)).toBe(false);
		},
	);

	it("does not let an older operation finish over a newer one", () => {
		// Arrange
		mount();
		const old = start("Old pending");
		const current = start("New pending");
		// Act
		let accepted = true;
		act(() => {
			accepted = old.finish("Old complete", "success");
		});
		// Assert
		expect(accepted).toBe(false);
		expect(root.textContent).toContain("New pending");
		expect(root.textContent).not.toContain("Old complete");
		act(() => {
			expect(current.finish("New complete", "success")).toBe(true);
		});
		expect(root.textContent).toContain("New complete");
	});
});

describe("operation token lifecycle", () => {
	it("does not let a token rewrite its already confirmed terminal result", () => {
		// Arrange
		mount();
		const token = start();
		act(() => {
			expect(token.finish("Confirmed success", "success")).toBe(true);
		});
		// Act
		let accepted = true;
		act(() => {
			accepted = token.finish("Contradictory warning", "warning");
		});
		// Assert
		expect(accepted).toBe(false);
		expect(root.textContent).toContain("Confirmed success");
		expect(root.querySelector('[data-tone="success"]')).not.toBeNull();
	});

	it("rejects an old finish after disposal and remount of the same element", () => {
		// Arrange
		const dispose = mount();
		const old = start("Old pending");
		act(() => dispose());
		mount();
		start("Remounted pending");
		// Act
		let accepted = true;
		act(() => {
			accepted = old.finish("Old result", "success");
		});
		// Assert
		expect(accepted).toBe(false);
		expect(root.textContent).toContain("Remounted pending");
		expect(root.textContent).not.toContain("Old result");
	});

	it("makes an old disposer harmless after remount of the same element", () => {
		// Arrange
		const oldDispose = mount();
		act(() => oldDispose());
		const currentDispose = mount();
		const current = start("Remounted pending");
		// Act
		act(() => oldDispose());
		// Assert
		expect(root.textContent).toContain("Remounted pending");
		expect(mountOperationStatusHost(root)).toBe(currentDispose);
		act(() => {
			expect(current.finish("Remounted complete", "success")).toBe(true);
		});
		expect(root.textContent).toContain("Remounted complete");
	});

	it("cannot finish a removed host or start without a global host", () => {
		// Arrange
		mount();
		const token = start();
		root.remove();
		// Act
		const finished = token.finish("Detached result", "success");
		const missing = startOperationStatus("No host");
		// Assert
		expect(finished).toBe(false);
		expect(missing).toBeNull();
	});
});

describe("operation header layout", () => {
	it("captures the inline override when work starts, not when the empty host mounts", () => {
		// Arrange
		mount();
		const style = document.body.style;
		style.setProperty("--header-sticky-offset", "99px", "important");
		const token = start();
		act(() => {
			token.finish("Confirmed", "success");
		});
		// Act
		act(() => (root.querySelector("button") as HTMLButtonElement).click());
		// Assert
		expect(style.getPropertyValue("--header-sticky-offset")).toBe("99px");
		expect(style.getPropertyPriority("--header-sticky-offset")).toBe("important");
	});

	it.each([
		{ mode: "observer", previous: "", priority: "" },
		{ mode: "observer", previous: "88px", priority: "important" },
		{ mode: "resize fallback", previous: "", priority: "" },
		{ mode: "resize fallback", previous: "88px", priority: "important" },
	])(
		"owns the offset only while visible: $mode, previous=$previous",
		({ mode, previous, priority }) => {
			// Arrange: JSDOM has no layout; supply measured header heights explicitly.
			if (mode === "resize fallback") vi.stubGlobal("ResizeObserver", undefined);
			const style = document.body.style;
			style.setProperty("--header-sticky-offset", previous, priority);
			const removeListener = vi.spyOn(window, "removeEventListener");
			const dispose = mount();
			expect(style.getPropertyValue("--header-sticky-offset")).toBe(previous);
			expect(style.getPropertyPriority("--header-sticky-offset")).toBe(priority);
			// Act / Assert: each state transition must use the current rendered header height.
			height = 112;
			const token = start();
			expect(style.getPropertyValue("--header-sticky-offset")).toBe("112px");
			height = 96;
			act(() => {
				token.finish("Confirmed", "success");
			});
			expect(style.getPropertyValue("--header-sticky-offset")).toBe("96px");
			height = 60;
			act(() => (root.querySelector("button") as HTMLButtonElement).click());
			expect(style.getPropertyValue("--header-sticky-offset")).toBe(previous);
			expect(style.getPropertyPriority("--header-sticky-offset")).toBe(priority);
			height = 72;
			start("Next sync");
			height = 84;
			if (mode === "observer") notifyResize();
			else window.dispatchEvent(new Event("resize"));
			expect(style.getPropertyValue("--header-sticky-offset")).toBe("84px");
			height = 0;
			window.dispatchEvent(new Event("resize"));
			expect(style.getPropertyValue("--header-sticky-offset")).toBe("84px");
			act(() => dispose());
			expect(style.getPropertyValue("--header-sticky-offset")).toBe(previous);
			expect(style.getPropertyPriority("--header-sticky-offset")).toBe(priority);
			expect(removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
			if (mode === "observer") expect(disconnect).toHaveBeenCalledOnce();
			height = 140;
			window.dispatchEvent(new Event("resize"));
			expect(style.getPropertyValue("--header-sticky-offset")).toBe(previous);
		},
	);

	it("does not let a detached header's observer clobber the new current header", () => {
		// Arrange
		mount();
		start("Old pending");
		const oldNotify = notifyResize;
		header.remove();
		const replacement = document.createElement("header");
		replacement.innerHTML = '<div id="operationStatusRoot"></div>';
		document.body.append(replacement);
		vi.spyOn(replacement, "getBoundingClientRect").mockReturnValue({ height: 144 } as DOMRect);
		const replacementRoot = replacement.firstElementChild as HTMLElement;
		act(() => {
			disposers.push(mountOperationStatusHost(replacementRoot));
		});
		start("Current pending");
		// Act: a queued callback from the detached header must no longer own the offset.
		height = 12;
		oldNotify();
		// Assert
		expect(document.body.style.getPropertyValue("--header-sticky-offset")).toBe("144px");
		expect(replacementRoot.textContent).toContain("Current pending");
	});
});
