/* Project-scope picker — selected projects show as removable chips;
 * a Radix Popover trigger opens a search-filterable project list for
 * adding more. Typing a name that doesn't match any existing project
 * turns the last list row into `+ Create "foo"` so free-text entry
 * folds into the same surface. Used by any include/exclude scope list
 * (peer sharing scope, coordinator-admin group scope defaults). */

import * as Popover from "@radix-ui/react-popover";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

export interface ProjectScopePickerProps {
	values: string[];
	onValuesChange: (next: string[]) => void;
	availableProjects: string[];
	placeholder?: string;
	emptyLabel?: string;
	disabled?: boolean;
	"aria-labelledby"?: string;
}

function normalize(value: string): string {
	return value.trim();
}

export function ProjectScopePicker({
	values,
	onValuesChange,
	availableProjects,
	placeholder,
	emptyLabel,
	disabled,
	"aria-labelledby": ariaLabelledby,
}: ProjectScopePickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Stable, de-duplicated, sorted pool of known + already-selected projects.
	// Already-selected values stay in the list so users can uncheck them
	// without hunting through the chip row above.
	const allKnown = useMemo(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const item of [...availableProjects, ...values]) {
			const trimmed = normalize(item);
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			out.push(trimmed);
		}
		return out.sort((a, b) => a.localeCompare(b));
	}, [availableProjects, values]);

	const trimmedQuery = normalize(query);
	const loweredQuery = trimmedQuery.toLowerCase();
	const filtered = useMemo(() => {
		if (!loweredQuery) return allKnown;
		return allKnown.filter((project) => project.toLowerCase().includes(loweredQuery));
	}, [allKnown, loweredQuery]);

	const exactMatchExists = trimmedQuery
		? allKnown.some((project) => project.toLowerCase() === loweredQuery)
		: false;
	const showCreateRow = Boolean(trimmedQuery) && !exactMatchExists;
	const rowCount = filtered.length + (showCreateRow ? 1 : 0);

	useEffect(() => {
		if (activeIndex >= rowCount) {
			setActiveIndex(Math.max(0, rowCount - 1));
		}
	}, [rowCount, activeIndex]);

	useEffect(() => {
		if (!open) return;
		// Radix focuses the content root by default; shift focus to the
		// search input on the next tick so typing-to-filter works.
		const raf = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(raf);
	}, [open]);

	const toggleProject = (project: string) => {
		const exists = values.includes(project);
		if (exists) {
			onValuesChange(values.filter((value) => value !== project));
		} else {
			onValuesChange(Array.from(new Set([...values, project])));
		}
	};

	const createProject = (project: string) => {
		const trimmed = normalize(project);
		if (!trimmed) return;
		onValuesChange(Array.from(new Set([...values, trimmed])));
		setQuery("");
		setActiveIndex(0);
	};

	const activateRow = (index: number) => {
		if (index < filtered.length) {
			const project = filtered[index];
			if (project) toggleProject(project);
			return;
		}
		if (showCreateRow) createProject(trimmedQuery);
	};

	const handleSearchKeyDown: JSX.KeyboardEventHandler<HTMLInputElement> = (event) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex((prev) => Math.min(rowCount - 1, prev + 1));
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((prev) => Math.max(0, prev - 1));
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			activateRow(activeIndex);
			return;
		}
	};

	const removeValue = (value: string) => {
		onValuesChange(values.filter((existing) => existing !== value));
	};

	return (
		<div class="project-scope-picker">
			<ul aria-labelledby={ariaLabelledby} class="project-scope-picker-selected">
				{values.length === 0 ? (
					<li class="project-scope-picker-selected-empty">
						{emptyLabel || "No projects selected."}
					</li>
				) : (
					values.map((value) => (
						<li class="project-scope-picker-selected-chip" key={value}>
							<span>{value}</span>
							{!disabled ? (
								<button
									aria-label={`Remove ${value}`}
									class="project-scope-picker-selected-remove"
									onClick={() => removeValue(value)}
									type="button"
								>
									×
								</button>
							) : null}
						</li>
					))
				)}
			</ul>
			<Popover.Root
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) {
						setQuery("");
						setActiveIndex(0);
					}
				}}
				open={open}
			>
				<Popover.Trigger asChild>
					<button
						class="project-scope-picker-trigger settings-button"
						disabled={disabled}
						type="button"
					>
						<span aria-hidden="true">+</span>
						<span>{placeholder || "Add project"}</span>
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content align="start" class="project-scope-picker-popover" sideOffset={6}>
						<input
							aria-label="Search projects"
							class="project-scope-picker-search"
							onInput={(event) => {
								setQuery(event.currentTarget.value);
								setActiveIndex(0);
							}}
							onKeyDown={handleSearchKeyDown}
							placeholder="Search or create…"
							ref={inputRef}
							type="text"
							value={query}
						/>
						<div class="project-scope-picker-results" role="listbox">
							{filtered.length === 0 && !showCreateRow ? (
								<div class="project-scope-picker-empty-row">
									No projects yet. Type a name to create one.
								</div>
							) : null}
							{filtered.map((project, index) => {
								const selected = values.includes(project);
								const active = index === activeIndex;
								return (
									<button
										aria-selected={selected}
										class={
											active
												? "project-scope-picker-row project-scope-picker-row--active"
												: "project-scope-picker-row"
										}
										key={project}
										onClick={() => {
											setActiveIndex(index);
											toggleProject(project);
										}}
										onMouseEnter={() => setActiveIndex(index)}
										role="option"
										type="button"
									>
										<span class="project-scope-picker-row-check" aria-hidden="true">
											{selected ? "✓" : ""}
										</span>
										<span class="project-scope-picker-row-label">{project}</span>
									</button>
								);
							})}
							{showCreateRow ? (
								<button
									aria-selected={false}
									class={
										activeIndex === filtered.length
											? "project-scope-picker-row project-scope-picker-row--create project-scope-picker-row--active"
											: "project-scope-picker-row project-scope-picker-row--create"
									}
									onClick={() => createProject(trimmedQuery)}
									onMouseEnter={() => setActiveIndex(filtered.length)}
									role="option"
									type="button"
								>
									<span class="project-scope-picker-row-check" aria-hidden="true">
										+
									</span>
									<span class="project-scope-picker-row-label">{`Create "${trimmedQuery}"`}</span>
								</button>
							) : null}
						</div>
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}
