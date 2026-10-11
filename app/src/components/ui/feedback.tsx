import type { ReactNode } from "react";
import { cx } from "./cx";

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg className={cx("anim-spin shrink-0", className)} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function ProgressBar({ value, indeterminate, className }: { value?: number; indeterminate?: boolean; className?: string }) {
  const pct = Math.max(0, Math.min(1, value ?? 0)) * 100;
  return (
    <div
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={cx("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}
    >
      {indeterminate ? (
        <div className="skeleton h-full w-full" style={{ background: "linear-gradient(90deg, var(--surface-3) 25%, var(--accent) 50%, var(--surface-3) 75%)", backgroundSize: "300% 100%" }} />
      ) : (
        <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-2",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
};

export function Chip({ tone = "neutral", icon, children, className, title }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium tabular-nums", toneClass[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

const dotColor: Record<string, string> = {
  ok: "bg-ok",
  done: "bg-ok",
  connected: "bg-ok",
  running: "bg-accent anim-pulse",
  connecting: "bg-warn anim-pulse",
  awaiting_permission: "bg-warn anim-pulse",
  queued: "bg-fg-3",
  paused: "bg-warn",
  waiting_user: "bg-warn anim-pulse",
  partial: "bg-warn",
  warn: "bg-warn",
  failed: "bg-danger",
  error: "bg-danger",
  cancelled: "bg-fg-3",
  skipped: "bg-fg-3",
  disconnected: "bg-fg-3",
  pending: "bg-fg-3",
};

export function StatusDot({ status, className }: { status: string; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-2 shrink-0 rounded-full", dotColor[status] ?? "bg-fg-3", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded-[5px] border border-line-strong bg-surface-2 px-1 py-px font-sans text-[11px] font-medium text-fg-2">
      {children}
    </kbd>
  );
}
