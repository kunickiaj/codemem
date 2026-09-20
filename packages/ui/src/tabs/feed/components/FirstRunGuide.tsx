import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import {
	completeFirstRunStep,
	dismissFirstRunGuide,
	FIRST_RUN_GUIDE_CHANGED_EVENT,
	FIRST_RUN_GUIDE_STORAGE_KEY,
	type FirstRunStep,
	readFirstRunGuideRecord,
	shouldShowFirstRunGuide,
} from "../data/first-run-guide";

type GuideStep = {
	id: FirstRunStep;
	label: string;
	actionLabel: string;
	action: () => void;
	actionAvailable?: boolean;
};

function clickElement(id: string): void {
	document.getElementById(id)?.click();
}

function focusElement(selector: string): void {
	const element = document.querySelector<HTMLElement>(selector);
	element?.focus();
}

function openHealth(): void {
	clickElement("tabBtn-health");
	queueMicrotask(() => focusElement("#healthSystemCard"));
}

function inspectFirstMemory(): void {
	const title = document.querySelector<HTMLButtonElement>(".feed-item button.feed-title");
	title?.click();
	title?.focus();
}

function openContextInspector(): void {
	const toggle = document.getElementById("contextInspectorToggle");
	if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
	queueMicrotask(() => focusElement("#contextInspectorPanel input.feed-search"));
}

function guideSteps(hasMemories: boolean): GuideStep[] {
	return [
		{
			id: "capture",
			label: "Capture a memory",
			actionLabel: "Check capture health",
			action: openHealth,
		},
		{
			id: "inspect",
			label: "Inspect its details",
			actionLabel: "Inspect first memory",
			action: inspectFirstMemory,
			actionAvailable: hasMemories,
		},
		{
			id: "find",
			label: "Find it again",
			actionLabel: "Open Context Inspector",
			action: openContextInspector,
		},
		{
			id: "scope",
			label: "Choose project scope",
			actionLabel: "Choose a project",
			action: () => focusElement("#projectFilter"),
		},
		{
			id: "settings-health",
			label: "Check settings or health",
			actionLabel: "Open Settings",
			action: () => clickElement("settingsButton"),
		},
	];
}

function GuideChecklist({
	completed,
	hasMemories,
	onAction,
}: {
	completed: Set<FirstRunStep>;
	hasMemories: boolean;
	onAction: (step: GuideStep) => void;
}) {
	return (
		<ol className="first-run-guide-list">
			{guideSteps(hasMemories).map((step) => {
				const isComplete = completed.has(step.id);
				return (
					<li className={isComplete ? "is-complete" : undefined} key={step.id}>
						<span className="first-run-guide-status">
							<span aria-hidden="true">{isComplete ? "✓" : "○"}</span>
							<span>
								<strong>{step.label}</strong>
								<span className="small">{isComplete ? "Completed" : "Pending"}</span>
							</span>
						</span>
						{!isComplete && step.actionAvailable !== false ? (
							<button className="settings-button" onClick={() => onAction(step)} type="button">
								{step.actionLabel}
							</button>
						) : null}
					</li>
				);
			})}
		</ol>
	);
}

export function FirstRunGuide({
	hasMemories,
	hasQueuedEvents,
}: {
	hasMemories: boolean;
	hasQueuedEvents: boolean;
}) {
	const [record, setRecord] = useState(readFirstRunGuideRecord);
	const [announcement, setAnnouncement] = useState("");
	const [hasInspectableMemory, setHasInspectableMemory] = useState(false);
	useLayoutEffect(() => {
		setHasInspectableMemory(document.querySelector(".feed-item button.feed-title") !== null);
	});

	useEffect(() => {
		const refresh = () => {
			const next = readFirstRunGuideRecord();
			setRecord(next);
			setAnnouncement(`${next.completed.length} of 5 getting started steps completed.`);
		};
		const refreshFromStorage = (event: StorageEvent) => {
			if (event.key === FIRST_RUN_GUIDE_STORAGE_KEY) refresh();
		};
		window.addEventListener(FIRST_RUN_GUIDE_CHANGED_EVENT, refresh);
		window.addEventListener("storage", refreshFromStorage);
		return () => {
			window.removeEventListener(FIRST_RUN_GUIDE_CHANGED_EVENT, refresh);
			window.removeEventListener("storage", refreshFromStorage);
		};
	}, []);

	useEffect(() => {
		if (hasMemories || hasQueuedEvents) completeFirstRunStep("capture");
	}, [hasMemories, hasQueuedEvents]);

	if (!shouldShowFirstRunGuide(record)) return null;

	const completed = new Set(record.completed);
	return (
		<section
			aria-labelledby="firstRunGuideTitle"
			className="first-run-guide"
			id="firstRunGuide"
			tabIndex={-1}
		>
			<div className="first-run-guide-header">
				<div>
					<h2 id="firstRunGuideTitle">Getting started</h2>
					<p>Confirm capture works, then learn where to inspect and find memories.</p>
				</div>
				<button
					aria-label="Dismiss getting started"
					className="settings-button"
					onClick={() => dismissFirstRunGuide()}
					type="button"
				>
					Dismiss
				</button>
			</div>
			<GuideChecklist
				completed={completed}
				hasMemories={hasInspectableMemory}
				onAction={(step) => {
					step.action();
					setAnnouncement(`Ready: ${step.actionLabel}.`);
				}}
			/>
			<div aria-live="polite" className="sr-only" role="status">
				{announcement}
			</div>
		</section>
	);
}
