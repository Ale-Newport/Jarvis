import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { useApp } from "../store";
import type { Notice } from "../store/reducer";
import { cx } from "./ui/cx";

const TTL = { info: 4500, warn: 7000, error: 9000 } as const;

function Toast({ notice }: { notice: Notice }) {
  const dismiss = useApp((s) => s.dismiss);
  useEffect(() => {
    const t = setTimeout(() => dismiss(notice.id), TTL[notice.level]);
    return () => clearTimeout(t);
  }, [notice.id, notice.level, dismiss]);
  const Icon = notice.level === "error" ? CircleAlert : notice.level === "warn" ? TriangleAlert : Info;
  return (
    <div
      role={notice.level === "error" ? "alert" : "status"}
      className="anim-slide pointer-events-auto flex w-full items-start gap-2.5 rounded-xl bg-surface px-3.5 py-3 shadow-lg"
    >
      <Icon size={16} className={cx("mt-0.5 shrink-0", notice.level === "error" ? "text-danger" : notice.level === "warn" ? "text-warn" : "text-accent")} />
      <div className="selectable min-w-0 flex-1 text-[13px] leading-snug break-words">{notice.message}</div>
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(notice.id)} className="shrink-0 text-fg-3 transition-colors hover:text-fg">
        <X size={14} />
      </button>
    </div>
  );
}

export function Toasts() {
  const notices = useApp((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </div>
  );
}
