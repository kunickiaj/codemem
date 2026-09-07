function revealTabWithinBounds(
	button: HTMLElement,
	buttonBounds: DOMRect,
	navigationBounds: DOMRect,
): void {
	const isVisible =
		buttonBounds.left >= navigationBounds.left && buttonBounds.right <= navigationBounds.right;
	if (isVisible) return;
	button.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function ensureTabIsVisible(button: HTMLElement): void {
	if (button.hidden) return;
	const navigation = button.closest<HTMLElement>(".tab-bar");
	if (!navigation) return;
	revealTabWithinBounds(button, button.getBoundingClientRect(), navigation.getBoundingClientRect());
}

export function createTabVisibilityTracker(): (button: HTMLElement) => void {
	let lastButton: HTMLElement | null = null;
	let lastButtonContentLeft: number | null = null;
	let lastButtonContentRight: number | null = null;
	let lastNavigationLeft: number | null = null;
	let lastNavigationRight: number | null = null;
	return (button) => {
		if (button.hidden) return;
		const navigation = button.closest<HTMLElement>(".tab-bar");
		if (!navigation) return;
		const buttonBounds = button.getBoundingClientRect();
		const navigationBounds = navigation.getBoundingClientRect();
		const buttonContentLeft = buttonBounds.left + navigation.scrollLeft;
		const buttonContentRight = buttonBounds.right + navigation.scrollLeft;
		if (
			button === lastButton &&
			buttonContentLeft === lastButtonContentLeft &&
			buttonContentRight === lastButtonContentRight &&
			navigationBounds.left === lastNavigationLeft &&
			navigationBounds.right === lastNavigationRight
		) {
			return;
		}
		lastButton = button;
		lastButtonContentLeft = buttonContentLeft;
		lastButtonContentRight = buttonContentRight;
		lastNavigationLeft = navigationBounds.left;
		lastNavigationRight = navigationBounds.right;
		revealTabWithinBounds(button, buttonBounds, navigationBounds);
	};
}
