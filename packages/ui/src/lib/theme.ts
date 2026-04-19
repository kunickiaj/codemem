/* Theme management — light/dark/variant switching. */

export type ThemeOption = {
	id: string;
	label: string;
	mode: "light" | "dark";
};

export const THEME_OPTIONS: ThemeOption[] = [
	{ id: "light", label: "Light", mode: "light" },
	{ id: "dark", label: "Dark", mode: "dark" },
];

const THEME_STORAGE_KEY = "codemem-theme";

function resolveTheme(themeId: string): ThemeOption {
	const exact = THEME_OPTIONS.find((t) => t.id === themeId);
	if (exact) return exact;
	const fallback = themeId.startsWith("dark") ? "dark" : "light";
	return THEME_OPTIONS.find((t) => t.id === fallback) || THEME_OPTIONS[0];
}

export function getTheme(): string {
	const saved = localStorage.getItem(THEME_STORAGE_KEY);
	if (saved) return resolveTheme(saved).id;
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setTheme(theme: string) {
	const selected = resolveTheme(theme);
	document.documentElement.setAttribute("data-theme", selected.mode);
	document.documentElement.setAttribute("data-color-mode", selected.mode);
	if (selected.id === selected.mode) {
		document.documentElement.removeAttribute("data-theme-variant");
	} else {
		document.documentElement.setAttribute("data-theme-variant", selected.id);
	}
	localStorage.setItem(THEME_STORAGE_KEY, selected.id);
}

interface LucideLike {
	createIcons: () => void;
}

/**
 * Theme toggle as a Lucide icon button. The icon shows the *destination*
 * mode — sun while dark, moon while light — so the button reads as
 * "click me to become this." Aria-label and icon update each flip.
 */
export function initThemeToggle(button: HTMLButtonElement | null) {
	if (!button) return;
	const applyIcon = (mode: "light" | "dark") => {
		const iconName = mode === "dark" ? "sun" : "moon";
		const nextLabel = mode === "dark" ? "Switch to light theme" : "Switch to dark theme";
		button.setAttribute("aria-label", nextLabel);
		button.textContent = "";
		const icon = document.createElement("i");
		icon.setAttribute("data-lucide", iconName);
		icon.setAttribute("aria-hidden", "true");
		button.appendChild(icon);
		const lucide = (globalThis as { lucide?: LucideLike }).lucide;
		lucide?.createIcons?.();
	};

	applyIcon(getTheme() === "dark" ? "dark" : "light");

	button.addEventListener("click", () => {
		const next = getTheme() === "dark" ? "light" : "dark";
		setTheme(next);
		applyIcon(next);
	});
}
