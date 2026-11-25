import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	DeviceIdentityInventoryItemV1,
	DeviceIdentityInventoryV1,
	RecipientPolicyIntentGraphV1,
} from "../lib/api/sync";
import { closeActionMenu, openActionMenu } from "../menu-test-utils";
import { withDiscoveredRejoinNotices } from "./device-rejoin-notice";
import { mountDevices } from "./devices";

const NOTICE = "Rejoined by Google sign-in";
const DEVICE = "rejoined-device";
const LOCAL = "this-device";
const AT = 1_700_000_000_000;

const intent: RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [
		{
			version: 1,
			identityId: "owner",
			displayName: "Owner",
			kind: "personal",
			verification: "local",
			status: "active",
			mergedIntoIdentityId: null,
		},
	],
	teams: [],
	teamMemberships: [],
	identityDevices: [
		{
			version: 1,
			identityId: "owner",
			deviceId: DEVICE,
			displayName: "Work Laptop",
			status: "active",
		},
	],
	projectRecipients: [],
};

function item(
	overrides: Partial<DeviceIdentityInventoryItemV1> = {},
): DeviceIdentityInventoryItemV1 {
	return {
		version: 1,
		deviceId: DEVICE,
		evidenceDeviceIds: [DEVICE],
		displayName: "Work Laptop",
		state: "configured",
		identityId: "owner",
		suggestedIdentityId: null,
		validatedFingerprint: "fingerprint",
		isLocal: false,
		sources: ["identity_binding", "coordinator_enrollment"],
		conflictCodes: [],
		...overrides,
	};
}

function mount(
	items: DeviceIdentityInventoryItemV1[],
	options: { localDeviceId?: string | undefined; removal?: boolean } = {},
) {
	const inventory: DeviceIdentityInventoryV1 = {
		version: 1,
		items,
		coordinatorEvidence: { availability: "available", safeErrorCode: null },
		truncated: false,
	};
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() =>
		mountDevices(element, intent, { version: 1, items: [] }, [], [], {
			inventory,
			localDeviceId: options.localDeviceId,
			...(options.removal
				? { removalConfirmation: { confirm: async () => false }, enrolledDeviceBlock: true }
				: {}),
		}),
	);
}

function remount() {
	const element = document.getElementById("mount");
	if (element) act(() => render(null, element));
}

const notices = () => [...document.querySelectorAll(".device-rejoin-notice")];
const dismissButton = () =>
	document.querySelector<HTMLButtonElement>(".device-rejoin-notice button");

beforeEach(() => {
	document.body.innerHTML = '<div id="mount"></div>';
	window.localStorage.clear();
});

it("uses only an unambiguous signed discovery marker for an existing device row", () => {
	const existing = item();
	const inventory: DeviceIdentityInventoryV1 = {
		version: 1,
		items: [existing],
		coordinatorEvidence: { availability: "unavailable", safeErrorCode: null },
		truncated: false,
	};
	const marker = { device_id: DEVICE, rejoined_at_ms: AT };
	expect(
		withDiscoveredRejoinNotices(inventory, [
			marker,
			{ device_id: "unlisted-device", rejoined_at_ms: AT },
		])?.items,
	).toEqual([{ ...existing, rejoin: { deviceId: DEVICE, rejoinedAtMs: AT } }]);
	expect(withDiscoveredRejoinNotices(inventory, [marker, { device_id: DEVICE }])).toEqual(
		inventory,
	);
	expect(withDiscoveredRejoinNotices(inventory, [{ ...marker, rejoined_at_ms: -1 }])).toEqual(
		inventory,
	);
});

afterEach(() => {
	remount();
	document.body.innerHTML = "";
	window.localStorage.clear();
});

describe("Devices rejoin notice", () => {
	it("shows the notice on a configured device and keeps it until dismissed", () => {
		mount([item({ rejoin: { deviceId: DEVICE, rejoinedAtMs: AT } })], { localDeviceId: LOCAL });

		expect(notices()).toHaveLength(1);
		expect(notices()[0]?.textContent).toContain(NOTICE);
		expect(notices()[0]?.closest(".devices-table-device")).not.toBeNull();
	});

	it("shows the notice on an enrolled device that is not set up yet", () => {
		mount(
			[
				item({
					state: "pairing_required",
					identityId: null,
					sources: ["coordinator_enrollment"],
					rejoin: { deviceId: DEVICE, rejoinedAtMs: AT },
				}),
			],
			{ localDeviceId: LOCAL },
		);

		expect(notices()).toHaveLength(1);
		expect(notices()[0]?.closest("article")?.textContent).toContain("Work Laptop");
	});

	it("shows nothing without a marker or with an invalid timestamp", () => {
		mount([item()], { localDeviceId: LOCAL });
		expect(notices()).toHaveLength(0);
		for (const rejoinedAtMs of [-1, 1.5, Number.NaN, 9e15]) {
			mount([item({ rejoin: { deviceId: DEVICE, rejoinedAtMs } })], { localDeviceId: LOCAL });
			expect(notices()).toHaveLength(0);
		}
	});

	it("stays dismissed after the Viewer renders again", () => {
		const rejoined = item({ rejoin: { deviceId: DEVICE, rejoinedAtMs: AT } });
		mount([rejoined], { localDeviceId: LOCAL });

		act(() => dismissButton()?.click());
		expect(notices()).toHaveLength(0);
		remount();
		mount([rejoined], { localDeviceId: LOCAL });

		expect(notices()).toHaveLength(0);
	});

	it("shows a fresh rejoin of the same device after a dismissal", () => {
		mount([item({ rejoin: { deviceId: DEVICE, rejoinedAtMs: AT } })], { localDeviceId: LOCAL });
		act(() => dismissButton()?.click());

		mount([item({ rejoin: { deviceId: DEVICE, rejoinedAtMs: AT + 1 } })], {
			localDeviceId: LOCAL,
		});

		expect(notices()).toHaveLength(1);
	});

	it("keeps a dismissal for the device that made it only", () => {
		const rejoined = item({ rejoin: { deviceId: DEVICE, rejoinedAtMs: AT } });
		mount([rejoined], { localDeviceId: LOCAL });
		act(() => dismissButton()?.click());

		remount();
		mount([rejoined], { localDeviceId: "another-viewer-device" });

		expect(notices()).toHaveLength(1);
	});

	it("keeps the notice and offers no dismissal when this device is unknown", () => {
		mount([item({ rejoin: { deviceId: DEVICE, rejoinedAtMs: AT } })], { localDeviceId: undefined });

		expect(notices()).toHaveLength(1);
		expect(dismissButton()).toBeNull();
		expect(window.localStorage.length).toBe(0);
	});

	it("survives unwritable storage by hiding the notice until reload", () => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = () => {
			throw new Error("quota");
		};
		try {
			mount([item({ rejoin: { deviceId: DEVICE, rejoinedAtMs: AT } })], { localDeviceId: LOCAL });
			act(() => dismissButton()?.click());
			expect(notices()).toHaveLength(0);
		} finally {
			Storage.prototype.setItem = original;
		}
	});

	it("does not change the Remove and Block menu", () => {
		const labels = () => {
			const menu = openActionMenu(
				document.getElementById(`device-identity-card-${DEVICE}`) ?? document,
			);
			const found = [...menu.querySelectorAll(".feed-menu-item")].map((node) => node.textContent);
			closeActionMenu(menu);
			return found;
		};
		mount([item()], { localDeviceId: LOCAL, removal: true });
		const plain = labels();
		remount();
		mount([item({ rejoin: { deviceId: DEVICE, rejoinedAtMs: AT } })], {
			localDeviceId: LOCAL,
			removal: true,
		});

		expect(plain).toContain("Remove device…");
		expect(labels()).toEqual(plain);
	});
});
