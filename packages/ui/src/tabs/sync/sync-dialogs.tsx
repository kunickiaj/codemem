import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { RadixDialog } from "../../components/primitives/radix-dialog";

type DialogTone = "default" | "danger";

type ConfirmDialogRequest = {
	kind: "confirm";
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
		const primary = document.querySelector<HTMLElement>(
			'#syncDialog [data-sync-primary-action="true"]',
		);
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
				<button
					className="modal-close"
					onClick={() => resolveCurrentDialog(request.kind === "confirm" ? false : null)}
					type="button"
				>
					close
				</button>
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
						onClick={() => resolveCurrentDialog(request.kind === "confirm" ? false : null)}
						type="button"
					>
						{cancelLabel}
					</button>
					{request.kind !== "duplicate-person" ? (
						<button
							autoFocus
							className={`settings-button ${dialogToneClassName(request.kind === "confirm" ? request.tone : undefined)}`}
							data-sync-primary-action="true"
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

	return step === "choice" ? (
		<div className="sync-dialog-stack">
			<div className="sync-dialog-choice-list" role="list">
				<button
					autoFocus
					className="settings-button"
					data-sync-primary-action="true"
					onClick={() => setStep("merge")}
					type="button"
				>
					These are both me
				</button>
				<button
					className="settings-button"
					onClick={() => resolveCurrentDialog({ action: "different-people" })}
					type="button"
				>
					These are different people
				</button>
				<button
					className="settings-button"
					onClick={() => resolveCurrentDialog({ action: "cancel" })}
					type="button"
				>
					Decide later
				</button>
			</div>
		</div>
	) : (
		<div className="sync-dialog-stack">
			<div className="small" id={descriptionId}>
				Choose which person should remain after combining these duplicates.
			</div>
			<div
				className="sync-dialog-radio-list"
				role="radiogroup"
				aria-describedby={descriptionId}
				aria-label="Person to keep after combining duplicates"
			>
				{request.actors.map((actor) => (
					<label className="sync-dialog-radio-option" key={actor.actorId}>
						<input
							autoFocus={primaryActorId === actor.actorId}
							checked={primaryActorId === actor.actorId}
							data-sync-primary-action={primaryActorId === actor.actorId ? "true" : undefined}
							name="syncDuplicatePrimaryActor"
							onChange={() => setPrimaryActorId(actor.actorId)}
							type="radio"
							value={actor.actorId}
						/>
						<span>
							{actor.label}
							{actor.isLocal ? " (You)" : ""}
						</span>
					</label>
				))}
			</div>
			<div className="field">
				<label className="small" htmlFor="syncDuplicateSecondaryActor">
					Person to combine into the selected record
				</label>
				<select
					className="sync-dialog-input"
					data-sync-primary-action="true"
					id="syncDuplicateSecondaryActor"
					value={secondary?.actorId || ""}
					onChange={(event) => setSecondaryActorId(event.currentTarget.value)}
				>
					{mergeCandidates.map((actor) => (
						<option key={actor.actorId} value={actor.actorId}>
							{actor.label}
							{actor.isLocal ? " (You)" : ""}
						</option>
					))}
				</select>
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
