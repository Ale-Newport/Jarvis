import type { SourcesCard as SourcesCardType } from "../../api/types";
import { domainOf } from "../../lib/format";
import { openExternal } from "../../lib/tauri";

export function SourcesCard({ card }: { card: SourcesCardType }) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">Sources</div>
      <div className="flex flex-wrap gap-1.5">
        {card.items.map((s, i) => (
          <button
            key={`${s.url}-${i}`}
            type="button"
            title={`${s.title}\n${s.url}`}
            onClick={() => void openExternal(s.url)}
            className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-3 pl-1 text-[12px] text-fg-2 shadow-sm transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-fg"
          >
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10.5px] font-semibold text-accent tabular-nums">
              {i + 1}
            </span>
            <span className="truncate">{domainOf(s.url) || s.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
