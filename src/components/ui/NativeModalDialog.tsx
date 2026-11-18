"use client";

import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

interface NativeModalDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}

/**
 * Native <dialog> modal component adhering strictly to modern-web-guidance `dialog`:
 * - Uses native `<dialog>` opened with `.showModal()` (no redundant `role="dialog"` or `aria-modal`).
 * - Labels dialog with `aria-labelledby` pointing to its heading.
 * - Uses `closedby="any"` with pointerdown/pointerup bounding-box fallback for browsers lacking `closedBy`.
 * - Resets `dialog.returnValue = ''` on close so stale return values never leak.
 */
export function NativeModalDialog({
  open,
  onClose,
  title,
  description,
  children,
}: NativeModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = "";
      onClose();
    };

    dialog.addEventListener("close", handleClose);

    // Fallback for browsers where `closedBy` is not yet supported on HTMLDialogElement.prototype
    let cleanupFallback: (() => void) | undefined;
    if (
      typeof HTMLDialogElement !== "undefined" &&
      !("closedBy" in HTMLDialogElement.prototype)
    ) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent) => {
        const r = dialog.getBoundingClientRect();
        return (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        );
      };
      const onPointerDown = (e: PointerEvent) => {
        pressedOutside = isOutside(e);
      };
      const onPointerUp = (e: PointerEvent) => {
        if (pressedOutside && isOutside(e)) {
          dialog.close();
        }
      };
      dialog.addEventListener("pointerdown", onPointerDown);
      dialog.addEventListener("pointerup", onPointerUp);
      cleanupFallback = () => {
        dialog.removeEventListener("pointerdown", onPointerDown);
        dialog.removeEventListener("pointerup", onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener("close", handleClose);
      cleanupFallback?.();
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      {...({ closedby: "any" } as React.DialogHTMLAttributes<HTMLDialogElement>)}
      className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl"
    >
      <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 id={titleId} className="text-lg font-bold text-slate-900">
            {title}
          </h2>
          {description && (
            <p id={descId} className="mt-1 text-sm text-slate-600">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close modal"
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div className="p-6">{children}</div>
    </dialog>
  );
}
