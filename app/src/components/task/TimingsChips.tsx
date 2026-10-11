import { Brain, Cpu, Globe, Timer, Zap } from "lucide-react";
import type { Timings } from "../../api/types";
import { formatDuration } from "../../lib/format";
import { Chip } from "../ui/feedback";

export function TimingsChips({ timings }: { timings: Timings }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Task timings">
      <Chip tone="accent" icon={<Timer size={11} />} title="Total wall-clock time">Total {formatDuration(timings.total_ms)}</Chip>
      <Chip icon={<Brain size={11} />} title="Planning (text model)">Planning {formatDuration(timings.planning_ms)}</Chip>
      <Chip icon={<Zap size={11} />} title="Laya decision model">Laya {formatDuration(timings.laya_ms)}</Chip>
      <Chip icon={<Cpu size={11} />} title="Browser operations">Browser {formatDuration(timings.browser_ms)}</Chip>
      <Chip icon={<Globe size={11} />} title="Waiting for pages to load">Page load {formatDuration(timings.page_load_ms)}</Chip>
      <Chip title="Text-model calls">{timings.llm_calls} LLM {timings.llm_calls === 1 ? "call" : "calls"}</Chip>
      <Chip title="Laya calls">{timings.laya_calls} Laya {timings.laya_calls === 1 ? "call" : "calls"}</Chip>
    </div>
  );
}
