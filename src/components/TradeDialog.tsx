"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface TradeDialogProps {
  /** id of the element that names the dialog (aria-labelledby). */
  labelId: string;
  /** id of the element that explains the dialog (aria-describedby). */
  descriptionId?: string;
  /**
   * Close request from Escape or a click on the backdrop (the dialog's own
   * buttons call it directly). The caller decides whether closing is allowed,
   * e.g. it ignores the request while a request is in flight.
   */
  onClose: () => void;
  /**
   * Element focused when the dialog opens and whenever `focusKey` changes
   * (e.g. the non-destructive button first, the close button once a request
   * succeeded).
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  focusKey?: unknown;
  children: React.ReactNode;
}

/**
 * Shared shell of the viewer trade dialogs (accept confirmation / cancel
 * confirmation, #1754 item 5).
 *
 * Accessibility follows the repository's dialog conventions (role="dialog" +
 * aria-modal + Escape, focus returned to the trigger by the caller, see
 * CardManager's zoom dialog) and adds an explicit focus trap: Tab/Shift+Tab
 * wrap inside the dialog. A custom element is used instead of the native
 * <dialog> (PackCompletionRewards) because the initial focus target and the
 * "no close while submitting" rule must be enforced deterministically.
 *
 * Initial focus is the caller's non-destructive button: accepting a trade and
 * cancelling an offer are both irreversible, so an Enter key press right after
 * opening the dialog must not perform them.
 */
export default function TradeDialog({
  labelId,
  descriptionId,
  onClose,
  initialFocusRef,
  focusKey,
  children,
}: TradeDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Keep the latest close request for the document listener without re-binding
  // it (it must stay bound for the dialog's whole life).
  const latestCloseRef = useRef(onClose);
  useEffect(() => {
    latestCloseRef.current = onClose;
  });

  useEffect(() => {
    initialFocusRef?.current?.focus();
    // `focusKey` re-runs this for a phase change; the ref object identity is
    // stable, so a plain re-render never steals focus back.
  }, [initialFocusRef, focusKey]);

  useEffect(() => {
    // Lock background scrolling while the modal is open (restored on close).
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    // Listen on the document (not the dialog element): while submitting every
    // button is disabled, focus may fall back to <body>, and Tab must still be
    // trapped.
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        latestCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const outside = !dialog.contains(active) || active === dialog;
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={(event) => {
        // Only the backdrop itself closes the dialog.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl bg-gray-800 p-5 text-white shadow-xl focus:outline-none sm:p-6"
      >
        {children}
      </div>
    </div>
  );
}
