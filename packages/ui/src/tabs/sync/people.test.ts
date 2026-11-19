import { beforeEach, expect, it, vi } from "vitest";
import * as api from "../../lib/api";
import { state } from "../../lib/state";
import { renderSyncPeersList } from "./components/sync-peers";
import { renderSyncPeers, setLoadSyncData } from "./people";

vi.mock("../../lib/api", () => ({ deletePeer: vi.fn() }));
vi.mock("./components/sync-peers", () => ({
	renderSyncPeersList: vi.fn(),
	canManageLegacyCoordinatorSpaces: () => false,
}));

beforeEach(() => {
	vi.clearAllMocks();
	document.body.innerHTML = '<div id="syncPeers"></div>';
	state.lastSyncPeers = [];
	state.syncPeersSectionFeedback = null;
	state.syncPeerFeedbackById.clear();
	setLoadSyncData(async () => {});
});

it("explains that disconnecting keeps the device in Projects", async () => {
	vi.mocked(api.deletePeer).mockResolvedValue({ binding: "kept" });
	renderSyncPeers();
	const options = vi.mocked(renderSyncPeersList).mock.calls[0]?.[1];
	const feedback = await options?.onRemove("fixture-peer", "Desk");
	expect(feedback?.message).toBe(
		"Disconnected this device from Desk. The device stays in Projects. An administrator's device can remove it.",
	);
	expect(state.syncPeersSectionFeedback?.message).toBe(feedback?.message);
	expect(api.deletePeer).toHaveBeenCalledWith("fixture-peer");
});

it("keeps the removal message when the binding was ended", async () => {
	vi.mocked(api.deletePeer).mockResolvedValue({ binding: "ended" });
	renderSyncPeers();
	const options = vi.mocked(renderSyncPeersList).mock.calls[0]?.[1];
	expect((await options?.onRemove("fixture-peer", "Desk"))?.message).toBe("Removed peer Desk.");
});
