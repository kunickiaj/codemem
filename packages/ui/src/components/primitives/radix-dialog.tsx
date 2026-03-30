import * as Dialog from '@radix-ui/react-dialog';
import type { ComponentChildren, ComponentProps } from 'preact';
import { render } from 'preact';

type DialogContentProps = ComponentProps<typeof Dialog.Content>;

export type RadixDialogProps = {
  ariaDescribedby?: string;
  ariaLabelledby?: string;
  children?: ComponentChildren;
  contentClassName?: string;
  contentId: string;
  modal?: boolean;
  onCloseAutoFocus?: DialogContentProps['onCloseAutoFocus'];
  onEscapeKeyDown?: DialogContentProps['onEscapeKeyDown'];
  onInteractOutside?: DialogContentProps['onInteractOutside'];
  onOpenAutoFocus?: DialogContentProps['onOpenAutoFocus'];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  overlayClassName?: string;
  overlayId: string;
  slotId?: string;
};

export function RadixDialog({
  ariaDescribedby,
  ariaLabelledby,
  children,
  contentClassName,
  contentId,
  modal = true,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onInteractOutside,
  onOpenAutoFocus,
  onOpenChange,
  open,
  overlayClassName,
  overlayId,
  slotId,
}: RadixDialogProps) {
  return (
    <Dialog.Root modal={modal} open={open} onOpenChange={onOpenChange}>
      {open ? (
        <Dialog.Portal>
          <Dialog.Overlay asChild>
            <div className={overlayClassName} id={overlayId} />
          </Dialog.Overlay>
          <Dialog.Content
            aria-describedby={ariaDescribedby}
            aria-labelledby={ariaLabelledby}
            asChild
            onCloseAutoFocus={onCloseAutoFocus}
            onEscapeKeyDown={onEscapeKeyDown}
            onInteractOutside={onInteractOutside}
            onOpenAutoFocus={onOpenAutoFocus}
          >
            <div
              className={contentClassName}
              id={contentId}
              onClick={(event) => {
                if (event.target !== event.currentTarget) return;
                onOpenChange(false);
              }}
              tabIndex={-1}
            >
              {children ?? (slotId ? <div id={slotId} /> : null)}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}

export function renderRadixDialog(mount: HTMLElement, props: RadixDialogProps) {
  render(<RadixDialog {...props} />, mount);
}
