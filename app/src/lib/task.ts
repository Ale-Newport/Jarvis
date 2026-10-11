import type { Step, Task, TaskStatus } from "../api/types";

export function taskElapsedMs(task: Task, now: number): number {
  const started = task.started_at ? Date.parse(task.started_at) : NaN;
  switch (task.status) {
    case "running":
    case "waiting_user":
    case "queued":
      return Number.isFinite(started) ? Math.max(task.elapsed_ms, now - started) : task.elapsed_ms;
    case "paused":
      return task.elapsed_ms || (Number.isFinite(started) ? now - started : 0);
    default: {
      if (task.elapsed_ms > 0) return task.elapsed_ms;
      const finished = task.finished_at ? Date.parse(task.finished_at) : NaN;
      return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
    }
  }
}

export function stepElapsedMs(step: Step, now: number): number | null {
  if (step.elapsed_ms != null) return step.elapsed_ms;
  if (step.status !== "running") return null;
  const t = Date.parse(step.started_at);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  paused: "Paused",
  waiting_user: "Waiting for you",
  done: "Done",
  partial: "Partly done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const canRetry = (s: TaskStatus): boolean => s === "failed" || s === "cancelled" || s === "partial";
