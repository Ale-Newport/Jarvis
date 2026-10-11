import type { ReactNode } from "react";

export function CardShell({ title, icon, count, children }: { title?: string; icon: ReactNode; count?: number; children: ReactNode }) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      {(title || count != null) && (
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2 text-[12.5px] font-semibold text-fg-2">
          <span className="text-fg-3">{icon}</span>
          <span className="truncate">{title}</span>
          {count != null && <span className="ml-auto font-normal text-fg-3 tabular-nums">{count}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
