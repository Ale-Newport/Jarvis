import {
  AppWindow,
  Ban,
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  EyeOff,
  Globe,
  Hand,
  Pause,
  Play,
  RotateCcw,
  Square,
  TriangleAlert,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import type { Task } from "../../api/types";
import { useNow } from "../../hooks/useNow";
import { formatClock, formatDuration, shortUrl } from "../../lib/format";
import { STATUS_LABEL, canRetry, taskElapsedMs } from "../../lib/task";
import { useApp } from "../../store";
import { isActiveTask } from "../../store/reducer";
import { Button, IconButton } from "../ui/Button";
import { Spinner } from "../ui/feedback";
import { cx } from "../ui/cx";
import { ScreenshotPreview } from "./ScreenshotPreview";
import { StepTimeline } from "./StepTimeline";
import { TimingsChips } from "./TimingsChips";
import { WaitingBanner } from "./WaitingBanner";

function StatusGlyph({ task }: { task: Task }) {
  switch (task.status) {
    case "running":
    case "queued":
      return <Spinner size={16} className="text-accent" />;
    case "paused":
      return <Pause size={16} className="text-warn" />;
    case "waiting_user":
      return <Hand size={16} className="text-warn" />;
    case "done":
      return <CircleCheck size={16} className="text-ok" />;
    case "partial":
      return <TriangleAlert size={16} className="text-warn" />;
    case "failed":
      return <CircleX size={16} className="text-danger" />;
    case "cancelled":
      return <Ban size={16} className="text-fg-3" />;
  }
}

function headline(task: Task): ReactNode {
  if (task.status === "running" || task.status === "queued") return task.current?.title || STATUS_LABEL[task.status] + "…";
  if (task.status === "paused") return "Paused";
  if (task.status === "waiting_user") return task.waiting?.kind === "confirm" ? "Waiting for your approval" : "Waiting for you";
  return STATUS_LABEL[task.status];
}

export const TaskPanel = memo(function TaskPanel({ taskId, latest }: { taskId: string; latest: boolean }) {
  const task = useApp((s) => s.tasks[taskId]);
  const screenshots = useApp((s) => s.settings?.agent.screenshots ?? "on_demand");
  const chromeConnected = useApp((s) => s.chrome?.state === "connected");
  const pauseTask = useApp((s) => s.pauseTask);
  const resumeTask = useApp((s) => s.resumeTask);
  const cancelTask = useApp((s) => s.cancelTask);
  const retryTask = useApp((s) => s.retryTask);
  const chromeFocus = useApp((s) => s.chromeFocus);
  const busyElsewhere = useApp((s) => Object.values(s.tasks).some((t) => t.id !== taskId && isActiveTask(t)));

  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [preview, setPreview] = useState(false);

  const active = !!task && isActiveTask(task);
  const ticking = !!task && (task.status === "running" || task.status === "waiting_user" || task.status === "queued");
  const now = useNow(ticking);

  if (!task) return null;

  const expanded = userOpen ?? (active || task.status === "failed" || task.status === "partial");
  const elapsed = taskElapsedMs(task, now);
  const stepCount = task.steps.length;
  const screenshotsOff = screenshots === "off";
  const url = task.current?.url ?? null;
  const showUrl = !!url && (active || expanded);
  const previewOn = preview && !screenshotsOff;

  return (
    <div className="anim-slide rounded-2xl border border-line bg-surface px-3.5 py-3 shadow-sm" data-task-status={task.status}>
      {/* header */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => setUserOpen(!expanded)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <StatusGlyph task={task} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cx("block truncate text-[13.5px] font-medium", task.status === "failed" && "text-danger")}>{headline(task)}</span>
          </span>
          <span className="shrink-0 text-[12px] text-fg-3 tabular-nums">
            {active ? <span className="font-mono">{formatClock(elapsed)}</span> : <>{stepCount} {stepCount === 1 ? "step" : "steps"} · {formatDuration(elapsed)}</>}
          </span>
          <ChevronDown size={15} className={cx("shrink-0 text-fg-3 transition-transform duration-200", expanded && "rotate-180")} />
        </button>
      </div>

      {/* url + controls */}
      {(showUrl || active || canRetry(task.status)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 pl-[30px]">
          {showUrl ? (
            <button
              type="button"
              onClick={() => void chromeFocus()}
              title={`${task.current?.page_title ?? url}\n${url} — click to show this tab in Chrome`}
              className="group flex min-w-0 flex-1 basis-40 items-center gap-1.5 text-left text-[12px] text-fg-3 transition-colors hover:text-accent"
            >
              <Globe size={12} className="shrink-0" />
              <span className="truncate">{shortUrl(url!, 80)}</span>
            </button>
          ) : (
            <span className="flex-1" />
          )}
          <div className="flex shrink-0 items-center gap-1">
            {active && (
              <>
                <IconButton
                  label={screenshotsOff ? "Live preview is off in Settings → Agent" : previewOn ? "Hide live preview" : "Show live preview"}
                  active={previewOn}
                  disabled={screenshotsOff}
                  onClick={() => setPreview((p) => !p)}
                >
                  {previewOn ? <EyeOff size={14} /> : <Eye size={14} />}
                </IconButton>
                <IconButton label="Open current browser tab" disabled={!chromeConnected} onClick={() => void chromeFocus()}>
                  <AppWindow size={14} />
                </IconButton>
                {task.status === "paused" ? (
                  <Button size="sm" variant="secondary" icon={<Play size={12} />} onClick={() => void resumeTask(task.id)}>
                    Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" icon={<Pause size={12} />} disabled={task.status === "waiting_user" || task.status === "queued"} onClick={() => void pauseTask(task.id)}>
                    Pause
                  </Button>
                )}
                <Button size="sm" variant="danger-soft" icon={<Square size={11} fill="currentColor" />} title="Cancel (⌘.)" onClick={() => void cancelTask(task.id)}>
                  Cancel
                </Button>
              </>
            )}
            {canRetry(task.status) && (
              <Button size="sm" variant="secondary" icon={<RotateCcw size={12} />} disabled={busyElsewhere} onClick={() => void retryTask(task.id)}>
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      {task.error && (task.status === "failed" || task.status === "partial" || task.status === "cancelled") && (
        <div className="selectable mt-2 ml-[30px] text-[12.5px] leading-snug text-danger">{task.error}</div>
      )}

      <WaitingBanner task={task} />

      {expanded && (
        <div className="mt-2.5 border-t border-line pt-1.5">
          <StepTimeline steps={task.steps} now={now} follow={active} />
        </div>
      )}

      {previewOn && active && <ScreenshotPreview taskId={task.id} poll />}

      {task.timings && (expanded || latest) && (
        <div className="mt-2.5 border-t border-line pt-2.5">
          <TimingsChips timings={task.timings} />
        </div>
      )}

      {task.status === "queued" && !task.current && (
        <div className="mt-1 flex items-center gap-1.5 pl-[30px] text-[12px] text-fg-3">
          <Clock size={12} /> Waiting to start…
        </div>
      )}
    </div>
  );
});
