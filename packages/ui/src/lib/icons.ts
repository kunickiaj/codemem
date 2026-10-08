import {
	Activity,
	AlertTriangle,
	Archive,
	BookOpen,
	CheckCircle,
	CircleArrowUp,
	CircleHelp,
	CopyCheck,
	createIcons,
	Filter,
	HelpCircle,
	Inbox,
	Layers,
	Loader,
	MinusCircle,
	Moon,
	Package,
	Pencil,
	Percent,
	Settings,
	ShieldCheck,
	Sun,
	Tag,
	TrendingDown,
	TrendingUp,
	X,
} from "lucide";

// Add new data-lucide names here so only the viewer's icons enter the bundle.
const VIEWER_ICONS = {
	Activity,
	AlertTriangle,
	Archive,
	BookOpen,
	CheckCircle,
	CircleArrowUp,
	CircleHelp,
	CopyCheck,
	Filter,
	HelpCircle,
	Inbox,
	Layers,
	Loader,
	MinusCircle,
	Moon,
	Package,
	Pencil,
	Percent,
	Settings,
	ShieldCheck,
	Sun,
	Tag,
	TrendingDown,
	TrendingUp,
	X,
};

export function initializeViewerIcons(): void {
	const runtime = {
		createIcons: () => createIcons({ icons: VIEWER_ICONS }),
	};
	// Preserve the renderer interface used by dynamically mounted tab content.
	(globalThis as typeof globalThis & { lucide?: typeof runtime }).lucide = runtime;
	runtime.createIcons();
}
