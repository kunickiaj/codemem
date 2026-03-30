import * as Select from '@radix-ui/react-select';

const EMPTY_SENTINEL = '__codemem-empty-select__';

function encodeValue(value: string): string {
  return value === '' ? EMPTY_SENTINEL : value;
}

function decodeValue(value: string): string {
  return value === EMPTY_SENTINEL ? '' : value;
}

export type RadixSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type RadixSelectProps = {
  ariaLabel?: string;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  id?: string;
  itemClassName?: string;
  onValueChange: (value: string) => void;
  options: RadixSelectOption[];
  placeholder?: string;
  triggerClassName?: string;
  value: string;
  viewportClassName?: string;
};

export function RadixSelect({
  ariaLabel,
  className,
  contentClassName,
  disabled = false,
  id,
  itemClassName,
  onValueChange,
  options,
  placeholder,
  triggerClassName,
  value,
  viewportClassName,
}: RadixSelectProps) {
  const encodedValue = value ? encodeValue(value) : undefined;

  return (
    <Select.Root
      disabled={disabled}
      onValueChange={(nextValue) => onValueChange(decodeValue(nextValue))}
      value={encodedValue}
    >
      <Select.Trigger
        aria-label={ariaLabel ?? placeholder}
        className={triggerClassName ?? className}
        data-value={value}
        id={id}
        type="button"
      >
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="sync-radix-select-icon" aria-hidden="true">
          ▾
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={contentClassName} position="popper">
          <Select.Viewport className={viewportClassName}>
            {options.map((option) => (
              <Select.Item
                key={encodeValue(option.value)}
                className={itemClassName}
                disabled={option.disabled}
                value={encodeValue(option.value)}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="sync-radix-select-indicator">✓</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
