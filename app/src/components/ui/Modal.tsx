import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { cx } from "./cx";

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  bare,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  /** no header / padding: the child lays itself out */
  bare?: boolean;
  dismissable?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose, dismissable]);

  if (!open) return null;
  return createPortal(
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0" style={{ background: "var(--scrim)" }} onMouseDown={() => dismissable && onClose()} />
      <div
        ref={panel}
        tabIndex={-1}
        className={cx("anim-pop relative flex max-h-full flex-col overflow-hidden rounded-2xl bg-bg shadow-lg", className)}
      >
        {!bare && title && (
          <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {dismissable && (
              <IconButton label="Close" onClick={onClose}>
                <X size={16} />
              </IconButton>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
