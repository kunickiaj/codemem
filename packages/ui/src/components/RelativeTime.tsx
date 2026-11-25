import { formatRelativeTime, formatTimestamp } from "../lib/format";

/** A one-line relative time. The exact time stays available on hover and to assistive tech. */
export function RelativeTime({ value }: { value: string }) {
	return (
		<time dateTime={value} title={formatTimestamp(value)}>
			{formatRelativeTime(value)}
		</time>
	);
}
