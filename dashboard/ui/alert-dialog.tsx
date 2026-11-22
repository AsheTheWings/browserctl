import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Button } from './button.tsx';
import { cn } from './utils.ts';

interface AlertDialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
}

const Context = createContext<AlertDialogContextValue | null>(null);

function useAlertDialog(): AlertDialogContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('AlertDialog components must be used within AlertDialog.');
  return value;
}

export function AlertDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Context.Provider value={{ open, onOpenChange, titleId: `${id}-title`, descriptionId: `${id}-description` }}>
      {children}
    </Context.Provider>
  );
}

export function AlertDialogContent({
  className,
  children,
  ...props
}: ComponentProps<'dialog'>) {
  const { open, onOpenChange, titleId, descriptionId } = useAlertDialog();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const cancel = dialogRef.current?.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]');
    cancel?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-slot="alert-dialog-content"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onOpenChange(false);
      }}
      className={cn(
        'fixed inset-0 z-50 m-auto w-[calc(100vw-2rem)] max-w-md overflow-hidden rounded-xl border bg-card p-0 text-card-foreground shadow-lg outline-none backdrop:bg-black/55',
        className,
      )}
      {...props}
    >
      {children}
    </dialog>
  );
}

export function AlertDialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('space-y-1.5 px-5 pt-5 pb-4 text-left', className)}
      {...props}
    />
  );
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<'h2'>) {
  const { titleId } = useAlertDialog();
  return (
    <h2
      id={titleId}
      data-slot="alert-dialog-title"
      className={cn('text-base font-semibold tracking-tight text-foreground', className)}
      {...props}
    />
  );
}

export function AlertDialogDescription({ className, ...props }: ComponentProps<'p'>) {
  const { descriptionId } = useAlertDialog();
  return (
    <p
      id={descriptionId}
      data-slot="alert-dialog-description"
      className={cn('text-sm leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex flex-wrap items-center justify-end gap-2 border-t bg-secondary/45 px-5 py-3', className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  onClick,
  ...props
}: ComponentProps<typeof Button>) {
  const { onOpenChange } = useAlertDialog();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-slot="alert-dialog-cancel"
      className={className}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onOpenChange(false);
      }}
      {...props}
    />
  );
}

export function AlertDialogAction({
  className,
  variant = 'destructive',
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      data-slot="alert-dialog-action"
      className={className}
      {...props}
    />
  );
}
