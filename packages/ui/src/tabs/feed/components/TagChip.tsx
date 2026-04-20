import { h } from "preact";
import { Chip } from "../../../components/primitives/chip";
import { formatTagLabel } from "../../../lib/format";

export function TagChip({ tag }: { tag: unknown }) {
	const display = formatTagLabel(tag);
	if (!display) return null;
	return h(Chip, { variant: "tag", title: String(tag) }, display);
}
