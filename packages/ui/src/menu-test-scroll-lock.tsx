import type { ComponentChildren } from "preact";

// Scroll locking is outside menu interaction tests. Its CommonJS entry creates
// native React forwardRefs despite Vite aliases; keep Radix's focus/portal real.
export function RemoveScroll({ children }: { children: ComponentChildren }) {
	return <>{children}</>;
}
