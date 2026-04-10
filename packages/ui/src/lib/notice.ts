import { $ } from "./dom";
import { state } from "./state";

let hideAbort: AbortController | null = null;

export function hideGlobalNotice() {
	const notice = $("globalNotice");
	if (!notice) return;
	if (state.noticeTimer) {
		clearTimeout(state.noticeTimer);
		state.noticeTimer = null;
	}
	// Cancel any previous hide listener before registering a new one
	if (hideAbort) hideAbort.abort();
	hideAbort = new AbortController();
	notice.classList.add("hiding");
	notice.addEventListener(
		"animationend",
		() => {
			hideAbort = null;
			notice.hidden = true;
			notice.textContent = "";
			notice.classList.remove("success", "warning", "hiding");
		},
		{ once: true, signal: hideAbort.signal },
	);
}

export function showGlobalNotice(message: string, type: "success" | "warning" = "success") {
	const notice = $("globalNotice");
	if (!notice || !message) return;
	// Cancel any in-progress hide animation so it can't kill this notice
	if (hideAbort) {
		hideAbort.abort();
		hideAbort = null;
	}
	notice.classList.remove("hiding");
	notice.textContent = message;
	notice.classList.remove("success", "warning");
	notice.classList.add(type === "warning" ? "warning" : "success");
	notice.hidden = false;
	if (state.noticeTimer) clearTimeout(state.noticeTimer);
	state.noticeTimer = setTimeout(() => {
		hideGlobalNotice();
	}, 12_000);
}
