import { useEffect, type RefObject } from "react";

/** Calls `onDismiss` on outside mousedown or Escape while `active`. `refs` are all the "inside" elements. */
export function useDismiss(refs: RefObject<HTMLElement | null>[], active: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (refs.every((r) => !r.current || !r.current.contains(t))) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onDismiss, ...refs]);
}
