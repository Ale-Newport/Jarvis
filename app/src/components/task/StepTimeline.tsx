import { Check, CircleAlert, Minus } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { Step } from "../../api/types";
import { formatDuration } from "../../lib/format";
import { stepElapsedMs } from "../../lib/task";
import { Spinner } from "../ui/feedback";
import { cx } from "../ui/cx";
import { StepIcon } from "./stepIcons";

const StepRow = memo(function StepRow({ step, now }: { step: Step; now: number }) {
  const elapsed = stepElapsedMs(step, now);
  const failed = step.status === "error";
  return (
    <li className="flex gap-2.5 py-1.5">
      <span
        className={cx(
          "mt-px flex size-[22px] shrink-0 items-center justify-center rounded-md",
          step.status === "running" && "bg-accent-soft text-accent",
          step.status === "ok" && "bg-surface-2 text-fg-2",
          step.status === "error" && "bg-danger-soft text-danger",
          step.status === "skipped" && "bg-surface-2 text-fg-3",
        )}
      >
        <StepIcon kind={step.kind} size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cx("truncate text-[13px]", failed ? "font-medium text-danger" : step.status === "skipped" ? "text-fg-3" : "text-fg")}>{step.title}</span>
          {step.detail && <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3" title={step.detail}>{step.detail}</span>}
        </div>
        {failed && step.error && <div className="mt-0.5 text-[12px] leading-snug text-danger">{step.error}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11.5px] text-fg-3 tabular-nums">
        {elapsed != null && <span>{formatDuration(elapsed)}</span>}
        <span className="flex size-4 items-center justify-center">
          {step.status === "running" && <Spinner size={12} className="text-accent" />}
          {step.status === "ok" && <Check size={13} className="text-ok" />}
          {step.status === "error" && <CircleAlert size={13} className="text-danger" />}
          {step.status === "skipped" && <Minus size={13} />}
        </span>
      </div>
    </li>
  );
});

export function StepTimeline({ steps, now, follow, maxHeight = 220 }: { steps: Step[]; now: number; follow: boolean; maxHeight?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [scrolled, setScrolled] = useState(false);

  // while the task runs keep the newest step in view; finished tasks start at the top
  useEffect(() => {
    const el = box.current;
    if (el && follow && stick.current) el.scrollTop = el.scrollHeight;
  }, [steps.length, steps[steps.length - 1]?.status, follow]);

  if (steps.length === 0) return <div className="py-2 text-[12.5px] text-fg-3">No steps yet.</div>;
  return (
    <div
      ref={box}
      className="-mx-1 overflow-y-auto px-1"
      style={{
        maxHeight,
        // soft fade where earlier steps scroll out of view
        maskImage: scrolled ? "linear-gradient(to bottom, transparent, #000 14px)" : undefined,
        WebkitMaskImage: scrolled ? "linear-gradient(to bottom, transparent, #000 14px)" : undefined,
      }}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        setScrolled((p) => (p === el.scrollTop > 2 ? p : el.scrollTop > 2));
      }}
    >
      <ol>
        {steps.map((s) => (
          <StepRow key={s.id} step={s} now={now} />
        ))}
      </ol>
    </div>
  );
}
