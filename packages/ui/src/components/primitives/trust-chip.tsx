/* TrustChip — typed chip wrapper for peer trust state.
 *
 * Maps a four-state trust model to the existing `Chip` primitive's
 * scope-variant vocabulary with a tone derived from state. Keeps copy +
 * tone decisions in one place so device rows, drawers, and future
 * admin surfaces render trust identically.
 *
 * See docs/plans/2026-04-23-sync-tab-redesign.md for trust-state
 * semantics and chip tone mappings. */

import { Chip } from "./chip";

export type TrustState = "two-way" | "you-trust-them" | "they-trust-you" | "not-trusted";

export interface TrustChipProps {
	state: TrustState;
	compact?: boolean;
}

const LABELS: Record<TrustState, { long: string; short: string }> = {
	"two-way": { long: "Two-way trust", short: "Mutual" },
	"you-trust-them": { long: "You trust them", short: "You → them" },
	"they-trust-you": { long: "They trust you", short: "Them → you" },
	"not-trusted": { long: "Not trusted", short: "Not trusted" },
};

const TONES: Record<TrustState, "ok" | "pending" | "warn"> = {
	"two-way": "ok",
	"you-trust-them": "pending",
	"they-trust-you": "pending",
	"not-trusted": "warn",
};

export function TrustChip({ state, compact = false }: TrustChipProps) {
	const label = compact ? LABELS[state].short : LABELS[state].long;
	return (
		<Chip variant="scope" tone={TONES[state]} title={LABELS[state].long}>
			{label}
		</Chip>
	);
}
