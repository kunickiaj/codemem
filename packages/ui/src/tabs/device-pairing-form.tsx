import { useEffect, useRef, useState } from "preact/hooks";
import { importCoordinatorInvite, inspectCoordinatorInvite } from "../lib/api/sync";
import { friendlyError } from "../lib/form";
import { takePendingPairingCode } from "../lib/pairing-handoff";

type PairingReview = { deviceId: string; fingerprint: string; addresses: string[] };

export interface DevicePairingApi {
	/** Reads a pasted code. Returns the device it belongs to, or null when it is not a pairing code. */
	review: (code: string) => Promise<PairingReview | null>;
	save: (code: string) => Promise<void>;
}

export const defaultDevicePairingApi: DevicePairingApi = {
	review: async (code) => {
		const inspected = await inspectCoordinatorInvite(code);
		if (inspected.kind !== "pair") return null;
		return {
			deviceId: inspected.device_id,
			fingerprint: inspected.fingerprint,
			addresses: inspected.addresses,
		};
	},
	save: async (code) => {
		await importCoordinatorInvite(code, undefined, "pair");
	},
};

type Message = { text: string; tone: "success" | "warning" };

const NOT_A_PAIRING_CODE =
	"This is not a device pairing code. Accept Team and Project invitations in Sharing → Invitations.";
const SAVED = "Pairing saved on this device. Team and Project access is unchanged.";

type Review = { code: string; device: PairingReview };

function submitLabel(busy: boolean, reviewed: boolean): string {
	if (busy) return "Working…";
	return reviewed ? "Save pairing" : "Review pairing";
}

function usePairingFlow(api: DevicePairingApi, onPaired?: () => unknown) {
	const [code, setCode] = useState("");
	const [review, setReview] = useState<Review | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<Message | null>(null);
	const revision = useRef(0);
	const reviewed = review !== null && review.code === code.trim();

	function edit(value: string) {
		revision.current += 1;
		setCode(value);
		setReview(null);
		setMessage(null);
	}
	async function save(value: string) {
		await api.save(value);
		setCode("");
		setReview(null);
		setMessage({ text: SAVED, tone: "success" });
		await Promise.resolve()
			.then(() => onPaired?.())
			.catch(() => undefined);
	}
	async function inspect(value: string, current: number) {
		const device = await api.review(value);
		if (current !== revision.current) return;
		if (device) setReview({ code: value, device });
		else setMessage({ text: NOT_A_PAIRING_CODE, tone: "warning" });
	}
	async function run(emptyField: () => void) {
		const value = code.trim();
		if (busy) return;
		if (!value) {
			setMessage({ text: "Paste a device pairing code.", tone: "warning" });
			emptyField();
			return;
		}
		const current = revision.current;
		const saving = reviewed;
		setBusy(true);
		setMessage(null);
		try {
			if (saving) await save(value);
			else await inspect(value, current);
		} catch (error) {
			if (current !== revision.current) return;
			const fallback = saving
				? "Could not save the pairing. Check that the code is complete and current, then try again."
				: "Could not review this code. Check the pasted text and try again.";
			setMessage({ text: friendlyError(error, fallback), tone: "warning" });
		} finally {
			setBusy(false);
		}
	}
	return { busy, code, edit, message, review, reviewed, run, setCode };
}

/** Accepts a device pairing code: review the device it names, then save the pairing. */
export function DevicePairingForm({
	api = defaultDevicePairingApi,
	onPaired,
}: {
	api?: DevicePairingApi;
	/** Refreshes Devices after the pairing is saved. */
	onPaired?: () => unknown;
}) {
	const flow = usePairingFlow(api, onPaired);
	const field = useRef<HTMLTextAreaElement>(null);
	const { setCode } = flow;
	useEffect(() => {
		const handed = takePendingPairingCode();
		if (handed) setCode(handed);
		field.current?.focus();
	}, [setCode]);
	const run = () => void flow.run(() => field.current?.focus());
	return (
		<form
			className="devices-pairing-form"
			onSubmit={(event) => {
				event.preventDefault();
				run();
			}}
		>
			<label className="sr-only" htmlFor="devices-pairing-code">
				Pairing code
			</label>
			<textarea
				className="feed-search"
				id="devices-pairing-code"
				onInput={(event) => flow.edit(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						run();
					}
				}}
				placeholder="Pairing code"
				ref={field}
				rows={2}
				value={flow.code}
			/>
			{flow.reviewed && flow.review ? <PairingReviewDetails device={flow.review.device} /> : null}
			<button className="settings-button" disabled={flow.busy} type="submit">
				{submitLabel(flow.busy, flow.reviewed)}
			</button>
			<p
				aria-live="polite"
				className="devices-pairing-form-status"
				data-tone={flow.message?.tone}
				role="status"
			>
				{flow.message?.text ?? ""}
			</p>
		</form>
	);
}

function PairingReviewDetails({ device }: { device: PairingReview }) {
	return (
		<section aria-labelledby="devices-pairing-review-heading" className="devices-pairing-review">
			<h4 id="devices-pairing-review-heading">Review device pairing</h4>
			<p className="small">
				Check these details with the other device. Accept only a device you trust.
			</p>
			<dl>
				<dt>Device ID</dt>
				<dd>{device.deviceId}</dd>
				<dt>Fingerprint</dt>
				<dd>{device.fingerprint}</dd>
				<dt>Addresses</dt>
				<dd className="devices-pairing-addresses">
					{device.addresses.length ? device.addresses.join("\n") : "No addresses"}
				</dd>
			</dl>
		</section>
	);
}
