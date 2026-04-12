import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { DialogCloseButton } from "../../components/primitives/dialog-close-button";
import { RadixDialog } from "../../components/primitives/radix-dialog";
import { RadixRadioGroup } from "../../components/primitives/radix-radio-group";
import { RadixSelect } from "../../components/primitives/radix-select";

type DialogTone = "default" | "danger";

type ConfirmDialogRequest = {
	kind: "confirm";
	autoFocusAction?: "cancel" | "confirm";
	cancelLabel?: string;
	confirmLabel?: string;
	description: string;
	tone?: DialogTone;
	title: string;
};

type InputDialogRequest = {
	kind: "input";
	cancelLabel?: string;
	confirmLabel?: string;
	description: string;
	initialValue?: string;
	placeholder?: string;
	title: string;
	validate?: (value: string) => string | null;
};

export type DuplicatePersonActorOption = {
	actorId: string;
	isLocal?: boolean;
	label: string;
};

type DuplicatePersonDialogResult =
	| { action: "cancel" }
	| { action: "different-people" }
	| { action: "merge"; primaryActorId: string; secondaryActorId: string };

type DuplicatePersonDialogRequest = {
	actors: DuplicatePersonActorOption[];
	kind: "duplicate-person";
	summary: string;
	title: string;
};

type SyncDialogRequest = ConfirmDialogRequest | InputDialogRequest | DuplicatePersonDialogRequest;
type SyncDialogResult = boolean | string | null | DuplicatePersonDialogResult;

let dialogMount: HTMLElement | null = null;
let currentRequest: SyncDialogRequest | null = null;
let resolveDialog: ((value: SyncDialogResult) => void) | null = null;
let setHostRequest: ((request: SyncDialogRequest | null) => void) | null = null;

function fallbackResult(request: SyncDialogRequest | null): SyncDialogResult {
	if (!request) return null;
	if (request.kind === "confirm") return false;
	if (request.kind === "input") return null;
	return { action: "cancel" };
}

function ensureDialogAvailable(requestKind: SyncDialogRequest["kind"]): boolean {
	if (!currentRequest || !resolveDialog) return true;
	console.warn(
		`Ignored sync ${requestKind} dialog request because another sync dialog is already open.`,
	);
	return false;
}

function setRequest(nextRequest: SyncDialogRequest | null) {
	currentRequest = nextRequest;
	setHostRequest?.(nextRequest);
}

function resolveCurrentDialog(value: SyncDialogResult) {
	const resolver = resolveDialog;
	resolveDialog = null;
	setRequest(null);
	resolver?.(value);
}

function dialogToneClassName(tone: DialogTone | undefined) {
	return tone === "danger" ? "sync-dialog-confirm danger" : "sync-dialog-confirm";
}

function SyncDialogHost() {
	const [request, setDialogState] = useState<SyncDialogRequest | null>(currentRequest);

	useEffect(() => {
		setHostRequest = setDialogState;
		return () => {
			if (setHostRequest === setDialogState) setHostRequest = null;
		};
	}, []);

	const open = Boolean(request);
	const titleId = useMemo(() => `sync-dialog-title-${request?.kind || "none"}`, [request?.kind]);
	const descriptionId = useMemo(
		() => `sync-dialog-description-${request?.kind || "none"}`,
		[request?.kind],
	);

	if (!request) return null;

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen) return;
		resolveCurrentDialog(request?.kind === "confirm" ? false : null);
	};

	const handleOpenAutoFocus = (event: Event) => {
		const legacyPrimary = document.querySelector<HTMLElement>(
			'#syncDialog [data-sync-primary-action="true"]',
		);
		if (request?.kind === "input" && legacyPrimary) {
			event.preventDefault();
			legacyPrimary.focus();
			return;
		}
		const preferredAction =
			request?.kind === "confirm" ? (request.autoFocusAction ?? "confirm") : "confirm";
		const selector =
			preferredAction === "cancel"
				? '#syncDialog [data-sync-dialog-action="cancel"]'
				: '#syncDialog [data-sync-dialog-action="confirm"]';
		const primary = document.querySelector<HTMLElement>(selector);
		if (!primary) return;
		event.preventDefault();
		primary.focus();
	};

	const body = request ? (
		<SyncDialogBody descriptionId={descriptionId} request={request} titleId={titleId} />
	) : null;

	return (
		<RadixDialog
			ariaDescribedby={descriptionId}
			ariaLabelledby={titleId}
			contentClassName="modal"
			contentId="syncDialog"
			onOpenAutoFocus={handleOpenAutoFocus}
			onOpenChange={handleOpenChange}
			open={open}
			overlayClassName="modal-backdrop"
			overlayId="syncDialogBackdrop"
		>
			{body}
		</RadixDialog>
	);
}

function SyncDialogBody({
	descriptionId,
	request,
	titleId,
}: {
	descriptionId: string;
	request: SyncDialogRequest;
	titleId: string;
}) {
	const [inputValue, setInputValue] = useState(
		request.kind === "input" ? request.initialValue || "" : "",
	);
	const [errorText, setErrorText] = useState<string | null>(null);
	const supportsLabels = request.kind !== "duplicate-person";
	const inputErrorId = "syncDialogInputError";

	useEffect(() => {
		if (request.kind === "input") {
			setInputValue(request.initialValue || "");
			setErrorText(null);
		}
	}, [request]);

	const cancelLabel = supportsLabels ? request.cancelLabel || "Cancel" : "Cancel";
	const confirmLabel = supportsLabels
		? request.confirmLabel || (request.kind === "confirm" ? "Confirm" : "Save")
		: "Confirm";

	const submit = () => {
		if (request.kind === "confirm") {
			resolveCurrentDialog(true);
			return;
		}
		if (request.kind === "duplicate-person") return;
		const trimmed = inputValue.trim();
		const validation = request.validate?.(trimmed) || null;
		if (validation) {
			setErrorText(validation);
			return;
		}
		resolveCurrentDialog(trimmed);
	};

	return (
		<div className="modal-card sync-dialog-card">
			<div className="modal-header">
				<h2 id={titleId}>{request.title}</h2>
				<DialogCloseButton
					ariaLabel={`Close ${request.title}`}
					onClick={() => resolveCurrentDialog(request.kind === "confirm" ? false : null)}
				/>
			</div>
			<div className="modal-body">
				{request.kind !== "duplicate-person" ? (
					<div className="small" id={descriptionId}>
						{request.description}
					</div>
				) : null}
				{request.kind === "duplicate-person" ? (
					<div className="small" id={descriptionId}>
						{request.summary}
					</div>
				) : null}
				{request.kind === "input" ? (
					<div className="field">
						<input
							aria-describedby={errorText ? `${descriptionId} ${inputErrorId}` : descriptionId}
							autoFocus
							className={errorText ? "sync-dialog-input sync-field-error" : "sync-dialog-input"}
							data-sync-primary-action="true"
							onInput={(event) => {
								setInputValue(event.currentTarget.value);
								if (errorText) setErrorText(null);
							}}
							onKeyDown={(event) => {
								if (event.key !== "Enter") return;
								event.preventDefault();
								submit();
							}}
							placeholder={request.placeholder}
							type="text"
							value={inputValue}
						/>
						{errorText ? (
							<div className="sync-field-hint" id={inputErrorId}>
								{errorText}
							</div>
						) : null}
					</div>
				) : null}
				{request.kind === "duplicate-person" ? (
					<DuplicatePersonDialogContent descriptionId={descriptionId} request={request} />
				) : null}
			</div>
			<div className="modal-footer">
				<div className="small" />
				<div className="sync-dialog-actions">
					<button
						className="settings-button"
						data-sync-dialog-action="cancel"
						onClick={() => resolveCurrentDialog(request.kind === "confirm" ? false : null)}
						type="button"
					>
						{cancelLabel}
					</button>
					{request.kind !== "duplicate-person" ? (
						<button
							autoFocus
							className={`settings-button ${dialogToneClassName(request.kind === "confirm" ? request.tone : undefined)}`}
							data-sync-dialog-action="confirm"
							onClick={submit}
							type="button"
						>
							{confirmLabel}
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}

function DuplicatePersonDialogContent({
	descriptionId,
	request,
}: {
	descriptionId: string;
	request: DuplicatePersonDialogRequest;
}) {
	const [step, setStep] = useState<"choice" | "merge">("choice");
	const defaultPrimary =
		request.actors.find((actor) => actor.isLocal)?.actorId || request.actors[0]?.actorId || "";
	const [primaryActorId, setPrimaryActorId] = useState(defaultPrimary);
	const [secondaryActorId, setSecondaryActorId] = useState("");

	useEffect(() => {
		setStep("choice");
		const nextPrimaryActorId =
			request.actors.find((actor) => actor.isLocal)?.actorId || request.actors[0]?.actorId || "";
		const nextSecondaryActorId =
			request.actors.find((actor) => actor.actorId !== nextPrimaryActorId)?.actorId || "";
		setPrimaryActorId(nextPrimaryActorId);
		setSecondaryActorId(nextSecondaryActorId);
	}, [request]);

	const primary =
		request.actors.find((actor) => actor.actorId === primaryActorId) || request.actors[0];
	const mergeCandidates = request.actors.filter((actor) => actor.actorId !== primaryActorId);
	const secondary =
		mergeCandidates.find((actor) => actor.actorId === secondaryActorId) || mergeCandidates[0];
	const primaryOptions = request.actors.map((actor) => ({
		label: (
			<>
				{actor.label}
				{actor.isLocal ? " (You)" : ""}
			</>
		),
		value: actor.actorId,
	}));
	const mergeOptions = mergeCandidates.map((actor) => ({
		label: `${actor.label}${actor.isLocal ? " (You)" : ""}`,
		value: actor.actorId,
	}));

	return step === "choice" ? (
		<div className="sync-dialog-stack">
			<ul className="sync-dialog-choice-list">
				<li>
					<button
						autoFocus
						className="settings-button"
						data-sync-primary-action="true"
						onClick={() => setStep("merge")}
						type="button"
					>
						These are both me
					</button>
				</li>
				<li>
					<button
						className="settings-button"
						onClick={() => resolveCurrentDialog({ action: "different-people" })}
						type="button"
					>
						These are different people
					</button>
				</li>
				<li>
					<button
						className="settings-button"
						onClick={() => resolveCurrentDialog({ action: "cancel" })}
						type="button"
					>
						Decide later
					</button>
				</li>
			</ul>
		</div>
	) : (
		<div className="sync-dialog-stack">
			<div className="small" id={descriptionId}>
				Choose which person should remain after combining these duplicates.
			</div>
			<RadixRadioGroup
				ariaDescribedby={descriptionId}
				ariaLabel="Person to keep after combining duplicates"
				autoFocusValue={primaryActorId}
				indicatorClassName="sync-dialog-radio-indicator"
				itemClassName="sync-dialog-radio-option"
				itemLabelClassName="sync-dialog-radio-label"
				name="syncDuplicatePrimaryActor"
				onValueChange={setPrimaryActorId}
				options={primaryOptions}
				rootClassName="sync-dialog-radio-list"
				value={primaryActorId}
			/>
			<div className="field">
				<label className="small" htmlFor="syncDuplicateSecondaryActor">
					Person to combine into the selected record
				</label>
				<RadixSelect
					ariaLabel="Person to combine into the selected record"
					contentClassName="sync-radix-select-content sync-actor-select-content"
					disabled={mergeOptions.length === 0}
					id="syncDuplicateSecondaryActor"
					itemClassName="sync-radix-select-item"
					onValueChange={setSecondaryActorId}
					options={mergeOptions}
					placeholder="No merge target available"
					triggerClassName="sync-radix-select-trigger sync-dialog-input"
					value={secondary?.actorId || ""}
					viewportClassName="sync-radix-select-viewport"
				/>
			</div>
			<div className="sync-dialog-actions">
				<button className="settings-button" onClick={() => setStep("choice")} type="button">
					Back
				</button>
				<button
					className="settings-button"
					disabled={!primary?.actorId || !secondary?.actorId}
					onClick={() => {
						if (!primary?.actorId || !secondary?.actorId) return;
						resolveCurrentDialog({
							action: "merge",
							primaryActorId: primary.actorId,
							secondaryActorId: secondary.actorId,
						});
					}}
					type="button"
				>
					Combine people
				</button>
			</div>
		</div>
	);
}

export function ensureSyncDialogHost() {
	if (dialogMount?.isConnected) return;
	dialogMount = document.getElementById("syncDialogMount") as HTMLElement | null;
	if (!dialogMount) {
		dialogMount = document.createElement("div");
		dialogMount.id = "syncDialogMount";
		document.body.appendChild(dialogMount);
	}
	render(<SyncDialogHost />, dialogMount);
}

export function openSyncConfirmDialog(
	request: Omit<ConfirmDialogRequest, "kind">,
): Promise<boolean> {
	ensureSyncDialogHost();
	if (!ensureDialogAvailable("confirm")) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		resolveDialog = (value) => resolve(Boolean(value));
		setRequest({ kind: "confirm", ...request });
	});
}

export function openSyncInputDialog(
	request: Omit<InputDialogRequest, "kind">,
): Promise<string | null> {
	ensureSyncDialogHost();
	if (!ensureDialogAvailable("input")) return Promise.resolve(null);
	return new Promise<string | null>((resolve) => {
		resolveDialog = (value) => resolve(typeof value === "string" ? value : null);
		setRequest({ kind: "input", ...request });
	});
}

export function openDuplicatePersonDialog(
	request: Omit<DuplicatePersonDialogRequest, "kind">,
): Promise<DuplicatePersonDialogResult> {
	ensureSyncDialogHost();
	if (!ensureDialogAvailable("duplicate-person")) {
		return Promise.resolve(
			fallbackResult({ kind: "duplicate-person", ...request }) as DuplicatePersonDialogResult,
		);
	}
	return new Promise<DuplicatePersonDialogResult>((resolve) => {
		resolveDialog = (value) =>
			resolve((value as DuplicatePersonDialogResult) || { action: "cancel" });
		setRequest({ kind: "duplicate-person", ...request });
	});
}
