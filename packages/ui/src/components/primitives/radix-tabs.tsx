import * as Tabs from "@radix-ui/react-tabs";
import { type ComponentChildren, createContext } from "preact";
import { useContext } from "preact/hooks";

const TriggerIds = createContext<Record<string, string>>({});

export type RadixTabOption = {
	disabled?: boolean;
	id?: string;
	label: string;
	value: string;
};

type RadixTabsProps = {
	ariaLabel?: string;
	children?: ComponentChildren;
	listClassName?: string;
	onValueChange: (value: string) => void;
	onTriggerKeyDown?: (value: string) => void;
	onTriggerMouseDown?: (value: string) => void;
	tabs: RadixTabOption[];
	triggerClassName?: string;
	value: string;
};

type RadixTabsContentProps = {
	children?: ComponentChildren;
	className?: string;
	forceMount?: boolean;
	value: string;
};

export function RadixTabs({
	ariaLabel,
	children,
	listClassName,
	onTriggerKeyDown,
	onTriggerMouseDown,
	onValueChange,
	tabs,
	triggerClassName,
	value,
}: RadixTabsProps) {
	const triggerIds = Object.fromEntries(
		tabs.flatMap((tab) => (tab.id ? [[tab.value, tab.id] as const] : [])),
	);
	return (
		<TriggerIds.Provider value={triggerIds}>
			<Tabs.Root onValueChange={onValueChange} value={value}>
				<Tabs.List aria-label={ariaLabel} className={listClassName}>
					{tabs.map((tab) => (
						<Tabs.Trigger
							className={triggerClassName}
							disabled={tab.disabled}
							{...(tab.id ? { id: tab.id } : {})}
							key={tab.value}
							onKeyDownCapture={() => onTriggerKeyDown?.(tab.value)}
							onMouseDownCapture={() => onTriggerMouseDown?.(tab.value)}
							value={tab.value}
						>
							{tab.label}
						</Tabs.Trigger>
					))}
				</Tabs.List>
				{children}
			</Tabs.Root>
		</TriggerIds.Provider>
	);
}

export function RadixTabsContent({
	children,
	className,
	forceMount = false,
	value,
}: RadixTabsContentProps) {
	const triggerId = useContext(TriggerIds)[value];
	return (
		<Tabs.Content
			{...(triggerId ? { "aria-labelledby": triggerId } : {})}
			className={className}
			forceMount={forceMount ? true : undefined}
			value={value}
		>
			{children}
		</Tabs.Content>
	);
}
