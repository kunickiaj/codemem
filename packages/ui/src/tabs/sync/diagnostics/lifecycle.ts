/* Diagnostics lifecycle — owns the pairing disclosure, pairing
 * payload render, redact switch, and init wiring. Keeps cross-module
 * render callbacks (renderSyncPeers + refreshPairing) on shared state
 * so the redact toggle can trigger everything without circular
 * imports. */

import { h } from "preact";
import { RadixSwitch } from "../../../components/primitives/radix-switch";
import { copyToClipboard } from "../../../lib/dom";
import {
	isSyncRedactionEnabled,
	setSyncPairingOpen,
	setSyncRedactionEnabled,
	state,
} from "../../../lib/state";
import { renderIntoSyncMount } from "../components/render-root";
import { renderPairingView } from "../components/sync-diagnostics";
import { renderPairingDisclosure } from "../components/sync-disclosure";
import { pairingView } from "./helpers";
import { renderSyncAttempts } from "./render/sync-attempts";
import { renderSyncStatus } from "./render/sync-status";
import { SYNC_REDACT_LABEL_ID, SYNC_REDACT_MOUNT_ID } from "./types";

let _renderSyncPeers: () => void = () => {};
export function setRenderSyncPeers(fn: () => void) {
	_renderSyncPeers = fn;
}

let _refreshPairing: () => void = () => {};

function renderPairingCollapsible() {
	const mount = document.getElementById("syncPairingDisclosureMount") as HTMLElement | null;
	const contentHost = document.getElementById("syncPairingPanelMount") as HTMLElement | null;
	if (!mount || !contentHost) return;

	renderPairingDisclosure(mount, {
		contentHost,
		open: state.syncPairingOpen,
		onOpenChange: (open) => {
			setSyncPairingOpen(open);
			renderPairingCollapsible();
			if (open) {
				const pairingPayloadEl = document.getElementById("pairingPayload");
				const pairingHint = document.getElementById("pairingHint");
				if (pairingPayloadEl) {
					renderPairingView(pairingPayloadEl, pairingHint, {
						payloadText: "Loading…",
						hintText: "Fetching pairing payload…",
					});
				}
			}
			_refreshPairing();
		},
	});

	const pairingCopy = document.getElementById("pairingCopy") as HTMLButtonElement | null;
	if (pairingCopy) {
		pairingCopy.onclick = async () => {
			const text =
				state.pairingCommandRaw || document.getElementById("pairingPayload")?.textContent || "";
			if (text) await copyToClipboard(text, pairingCopy);
		};
	}
}

export function renderPairing() {
	renderPairingCollapsible();
	const pairingPayloadEl = document.getElementById("pairingPayload");
	const pairingHint = document.getElementById("pairingHint");
	if (!pairingPayloadEl) return;

	renderPairingView(pairingPayloadEl, pairingHint, pairingView(state.pairingPayloadRaw));
}

function renderRedactControl() {
	const mount = document.getElementById(SYNC_REDACT_MOUNT_ID) as HTMLElement | null;
	if (!mount) return;

	renderIntoSyncMount(
		mount,
		h(RadixSwitch, {
			"aria-labelledby": SYNC_REDACT_LABEL_ID,
			checked: isSyncRedactionEnabled(),
			className: "sync-redact-switch",
			id: "syncRedact",
			onCheckedChange: (checked: boolean) => {
				setSyncRedactionEnabled(checked);
				renderRedactControl();
				// Redaction is honored server-side (the viewer proxy strips
				// addresses, pairing payloads, and last_error unless
				// includeDiagnostics=true). Flip the local switch and
				// immediately re-fetch so the re-rendered cards actually
				// reflect the new state instead of echoing the prior
				// server payload.
				_refreshPairing();
				renderSyncStatus();
				_renderSyncPeers();
				renderSyncAttempts();
				renderPairing();
			},
			thumbClassName: "sync-redact-switch-thumb",
		}),
	);
}

export function initDiagnosticsEvents(refreshCallback: () => void) {
	_refreshPairing = refreshCallback;
	renderPairingCollapsible();
	renderRedactControl();
}
