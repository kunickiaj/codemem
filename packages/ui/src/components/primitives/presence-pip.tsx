/* PresencePip — atomic presence/health indicator.
 *
 * A small colored dot used in device rows, attention rows, and anywhere
 * else we need a compact health signal. Color + pulse convey the state;
 * an aria-label carries the semantic for assistive tech.
 *
 * See docs/plans/2026-04-23-sync-tab-redesign.md (loading-states section)
 * for the full state matrix and color-source rationale. */

export type PresenceState = "online" | "offline" | "degraded" | "attention" | "syncing" | "unknown";

export interface PresencePipProps {
	state: PresenceState;
	size?: 6 | 8;
	"aria-label"?: string;
}

const DEFAULT_LABEL: Record<PresenceState, string> = {
	online: "Online",
	offline: "Offline",
	degraded: "Degraded",
	attention: "Action required",
	syncing: "Syncing",
	unknown: "Status unknown",
};

export function PresencePip({ state, size = 8, "aria-label": ariaLabel }: PresencePipProps) {
	const label = ariaLabel ?? DEFAULT_LABEL[state];
	return (
		<span
			aria-label={label}
			className={`presence-pip presence-pip--${state}`}
			role="img"
			style={`--presence-pip-size: ${size}px`}
		/>
	);
}
