import * as Tabs from "@radix-ui/react-tabs";
import type { ComponentChildren } from "preact";

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
	return (
		<Tabs.Root onValueChange={onValueChange} value={value}>
			<Tabs.List aria-label={ariaLabel} className={listClassName}>
				{tabs.map((tab) => (
					<Tabs.Trigger
						className={triggerClassName}
						disabled={tab.disabled}
						id={tab.id}
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
	);
}

export function RadixTabsContent({
	children,
	className,
	forceMount = false,
	value,
}: RadixTabsContentProps) {
	return (
		<Tabs.Content className={className} forceMount={forceMount ? true : undefined} value={value}>
			{children}
		</Tabs.Content>
	);
}
