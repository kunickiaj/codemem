import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../lib/state";
import { FeedItemCard } from "./FeedItemCard";

vi.mock("../../../components/primitives/tooltip", () => ({
	Tooltip: ({ children }: { children?: unknown }) => children,
	TooltipProvider: ({ children }: { children?: unknown }) => children,
}));

let mount: HTMLDivElement;

beforeEach(() => {
	state.lastStatsPayload = null;
	mount = document.createElement("div");
	document.body.appendChild(mount);
});

afterEach(() => {
	act(() => {
		render(null, mount);
	});
	mount.remove();
});

describe("FeedItemCard", () => {
	function renderCard(item: Parameters<typeof FeedItemCard>[0]["item"]): void {
		act(() => {
			render(
				h(FeedItemCard, {
					item,
					onReload: async () => {},
					onRemove: () => {},
					onReplace: () => {},
					onViewRefresh: () => {},
				}),
				mount,
			);
		});
	}

	it("shows the memory database id as quiet provenance", () => {
		renderCard({
			body_text: "A diagnostic memory body.",
			created_at: "2026-05-26T23:30:00.000Z",
			id: 1234,
			kind: "discovery",
			metadata_json: {},
			owned_by_self: false,
			project: "btha",
			title: "BTHA diagnostic memory",
			visibility: "shared",
		});

		expect(mount.textContent).toContain("ID 1234");
		const chip = mount.querySelector(".provenance-chip.memory-id");
		expect(chip?.textContent).toBe("ID 1234");
	});

	it("renders resolved identity labels without raw provenance ids", () => {
		const actorId = "local:0ea043cc-c61c-427d-8b77-572331b9855c";
		const deviceId = "0ea043cc-c61c-427d-8b77-572331b9855c";
		renderCard({
			actor_id: actorId,
			origin_device_id: deviceId,
			resolved_actor_display_name: "Ada Lovelace",
			resolved_device_display_name: "Ada's MacBook",
			title: "Shared memory",
		});

		expect(mount.textContent).toContain("Ada Lovelace");
		expect(mount.textContent).toContain("Device Ada's MacBook");
		expect(mount.textContent).not.toContain(actorId);
		expect(mount.textContent).not.toContain(deviceId);
	});

	it("renders neutral legacy fallbacks without stored machine labels or raw ids", () => {
		const actorId = "local:0ea043cc-c61c-427d-8b77-572331b9855c";
		const deviceId = "0ea043cc-c61c-427d-8b77-572331b9855c";
		renderCard({
			actor_display_name: actorId,
			actor_id: actorId,
			origin_device_id: deviceId,
			resolved_actor_display_name: actorId,
			resolved_device_display_name: deviceId,
			title: "Legacy shared memory",
		});

		expect(mount.textContent).toContain("Teammate");
		expect(mount.textContent).toContain("Shared device");
		expect(mount.textContent).not.toContain(actorId);
		expect(mount.textContent).not.toContain(deviceId);
	});
});
