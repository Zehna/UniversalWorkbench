import { useEffect, useRef, type KeyboardEvent } from "react";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm(): void;
  onCancel(): void;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  return [...candidates].filter(
    (element) => !element.hasAttribute("disabled"),
  );
}

/**
 * Destructive-action confirmation dialog: alertdialog semantics, initial
 * focus on the confirm action, Tab focus trap, Escape to cancel, and focus
 * restoration on unmount.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Focus the safe default (Cancel, the last action): Enter alone must
    // never confirm a destructive action.
    const elements = dialog.current
      ? focusableElements(dialog.current)
      : [];
    elements[elements.length - 1]?.focus();
    return () => {
      previousFocus.current?.focus?.();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab" || !dialog.current) return;
    const elements = focusableElements(dialog.current);
    if (elements.length === 0) return;
    const first = elements[0]!;
    const last = elements[elements.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={dialog}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      aria-describedby="confirm-dialog-description"
      onKeyDown={onKeyDown}
    >
      <p id="confirm-dialog-description">{description}</p>
      <button type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>{" "}
      <button type="button" onClick={onCancel}>
        {cancelLabel}
      </button>
    </div>
  );
}
