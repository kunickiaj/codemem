import { useRef, useState } from "preact/hooks";
import { ActionMenu } from "../components/primitives/action-menu";
import { AutocompleteInput } from "../components/primitives/autocomplete-input";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog, RadixDialogTitle } from "../components/primitives/radix-dialog";
import { Tooltip, TooltipProvider } from "../components/primitives/tooltip";
import { LONG_LABEL } from "./inputs";

function DialogExample() {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	return (
		<>
			<button
				ref={trigger}
				type="button"
				data-testid="gallery-dialog-trigger"
				onClick={() => setOpen(true)}
			>
				Open fixture dialog
			</button>
			<DialogCloseButton ariaLabel="Disabled close example" disabled onClick={() => {}} />
			<RadixDialog
				open={open}
				onOpenChange={setOpen}
				contentId="gallery-dialog"
				overlayId="gallery-dialog-overlay"
				contentClassName="modal"
				overlayClassName="modal-backdrop"
				ariaLabelledby="gallery-dialog-title"
				ariaDescribedby="gallery-dialog-description"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					trigger.current?.focus();
				}}
			>
				<div className="modal-card">
					<div className="modal-header">
						<RadixDialogTitle id="gallery-dialog-title">Synthetic dialog</RadixDialogTitle>
						<DialogCloseButton ariaLabel="Close fixture dialog" onClick={() => setOpen(false)} />
					</div>
					<div className="modal-body">
						<p id="gallery-dialog-description">This dialog changes only local fixture state.</p>
					</div>
					<div className="modal-footer">
						<button type="button" className="settings-save" onClick={() => setOpen(false)}>
							Finish fixture
						</button>
					</div>
				</div>
			</RadixDialog>
		</>
	);
}

function AutocompleteExamples() {
	const [value, setValue] = useState("");
	return (
		<>
			<label className="field" htmlFor="gallery-autocomplete">
				Autocomplete: type or press Arrow Down
				<AutocompleteInput
					id="gallery-autocomplete"
					data-testid="gallery-autocomplete"
					value={value}
					onValueChange={setValue}
					suggestions={["Alpha fixture", "Beta fixture", LONG_LABEL]}
					placeholder="Find a synthetic label"
				/>
			</label>
			<label className="field" htmlFor="gallery-autocomplete-disabled">
				Disabled autocomplete
				<AutocompleteInput
					id="gallery-autocomplete-disabled"
					disabled
					value="Unavailable fixture"
					onValueChange={() => {}}
					suggestions={[]}
				/>
			</label>
		</>
	);
}

function MenuExample() {
	const [result, setResult] = useState("No action selected");
	return (
		<div className="gallery-row">
			<ActionMenu
				label="Fixture actions"
				triggerId="gallery-action-menu"
				actions={[
					{ label: "Select fixture", onSelect: () => setResult("Fixture selected") },
					{ label: LONG_LABEL, onSelect: () => setResult("Long action selected") },
					{ label: "Unavailable action", disabled: true, onSelect: () => {} },
					{
						label: "Remove fixture",
						danger: true,
						onSelect: () => setResult("Fixture removed locally"),
					},
				]}
			/>
			<output data-testid="gallery-menu-result">{result}</output>
		</div>
	);
}

export function OverlayExamples() {
	return (
		<>
			<TooltipProvider delayDuration={0}>
				<Tooltip label="Synthetic tooltip content">
					<button type="button" data-testid="gallery-tooltip-trigger">
						Hover or focus for tooltip
					</button>
				</Tooltip>
				<Tooltip disabled label="Disabled tooltip">
					<button type="button" disabled>
						Disabled tooltip trigger
					</button>
				</Tooltip>
			</TooltipProvider>
			<MenuExample />
			<DialogExample />
			<AutocompleteExamples />
		</>
	);
}
