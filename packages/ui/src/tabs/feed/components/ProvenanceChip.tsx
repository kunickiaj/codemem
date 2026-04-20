import { h } from "preact";
import { Chip } from "../../../components/primitives/chip";

export function ProvenanceChip({ label, variant = "" }: { label: string; variant?: string }) {
	return h(Chip, { variant: "provenance", tone: variant || undefined }, label);
}
