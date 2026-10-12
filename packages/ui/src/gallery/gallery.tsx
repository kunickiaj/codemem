import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { LoadingCardList } from "../components/LoadingCardList";
import { Chip } from "../components/primitives/chip";
import { PresencePip, type PresenceState } from "../components/primitives/presence-pip";
import { RadixTabs, RadixTabsContent } from "../components/primitives/radix-tabs";
import { ButtonExamples, ChoiceExamples, FieldExamples, SelectExamples } from "./inputs";
import { OverlayExamples } from "./overlays";

export const GALLERY_FAMILIES = [
	"buttons",
	"selects",
	"fields",
	"choices",
	"tabs",
	"indicators",
	"overlays",
	"loading",
] as const;

export function GallerySection({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: ComponentChildren;
}) {
	return (
		<section
			className="gallery-section"
			id={id}
			data-testid={`gallery-${id}`}
			aria-labelledby={`${id}-heading`}
		>
			<h2 id={`${id}-heading`}>{title}</h2>
			<div className="gallery-stack">{children}</div>
		</section>
	);
}

function ThemeToggle() {
	const [theme, setTheme] = useState("dark");
	const toggle = () => {
		const next = theme === "dark" ? "light" : "dark";
		document.documentElement.dataset.theme = next;
		document.documentElement.dataset.colorMode = next;
		setTheme(next);
	};
	return (
		<button
			type="button"
			data-testid="gallery-theme-toggle"
			onClick={toggle}
			aria-pressed={theme === "light"}
		>
			Light theme
		</button>
	);
}

function TabExamples() {
	const [tab, setTab] = useState("overview");
	return (
		<RadixTabs
			ariaLabel="Example views"
			value={tab}
			onValueChange={setTab}
			listClassName="coordinator-admin-tabs-list"
			triggerClassName="coordinator-admin-tab-trigger"
			tabs={[
				{ value: "overview", label: "Overview" },
				{ value: "details", label: "Details and a longer label" },
				{ value: "disabled", label: "Unavailable", disabled: true },
			]}
		>
			<RadixTabsContent value="overview">Synthetic overview content</RadixTabsContent>
			<RadixTabsContent value="details">Synthetic details content</RadixTabsContent>
		</RadixTabs>
	);
}

function IndicatorExamples() {
	const states: PresenceState[] = [
		"online",
		"offline",
		"degraded",
		"attention",
		"syncing",
		"unknown",
	];
	return (
		<>
			<div className="gallery-row feed-item" data-testid="gallery-chips">
				<Chip variant="kind" tone="change">
					Change
				</Chip>
				<Chip variant="provenance" tone="mine">
					Mine
				</Chip>
				<Chip variant="tag">synthetic-tag</Chip>
				<Chip variant="badge">12</Chip>
				<Chip variant="scope">A longer synthetic sharing domain label</Chip>
			</div>
			<div className="gallery-row">
				{states.map((state) => (
					<span className="gallery-row" key={state} data-testid={`gallery-presence-${state}`}>
						<PresencePip state={state} />
						{state}
					</span>
				))}
			</div>
		</>
	);
}

export function Gallery() {
	return (
		<main className="gallery" data-testid="gallery-root">
			<header className="gallery-header">
				<h1>Shared controls</h1>
				<p>Interactive synthetic examples. No viewer, database, or API connection.</p>
				<ThemeToggle />
				<nav className="gallery-row" aria-label="Control families">
					{GALLERY_FAMILIES.map((id) => (
						<a href={`#${id}`} key={id}>
							{id}
						</a>
					))}
				</nav>
			</header>
			<div className="gallery-grid">
				<GallerySection id="buttons" title="Buttons">
					<ButtonExamples />
				</GallerySection>
				<GallerySection id="selects" title="Selects">
					<SelectExamples />
				</GallerySection>
				<GallerySection id="fields" title="Text fields">
					<FieldExamples />
				</GallerySection>
				<GallerySection id="choices" title="Switches and choices">
					<ChoiceExamples />
				</GallerySection>
				<GallerySection id="tabs" title="Tabs">
					<TabExamples />
				</GallerySection>
				<GallerySection id="indicators" title="Chips and presence">
					<IndicatorExamples />
				</GallerySection>
				<GallerySection id="overlays" title="Overlays">
					<OverlayExamples />
				</GallerySection>
				<GallerySection id="loading" title="Loading">
					<LoadingCardList label="Loading synthetic cards" />
				</GallerySection>
			</div>
		</main>
	);
}
