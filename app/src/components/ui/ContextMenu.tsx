import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; separatorBefore?: boolean };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  // keep the menu inside the viewport
  const left = Math.min(x, window.innerWidth - 196);
  const top = Math.min(y, window.innerHeight - (items.length * 30 + 16));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="anim-pop fixed z-[60] w-[188px] rounded-xl bg-surface p-1 shadow-md"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <div key={it.label}>
          {it.separatorBefore && <div className="my-1 h-px bg-line" />}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className={cx(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
              it.danger ? "text-danger hover:bg-danger-soft" : "text-fg hover:bg-accent hover:text-accent-fg",
            )}
          >
            {it.icon}
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
