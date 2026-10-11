import { ExternalLink, Link2 } from "lucide-react";
import type { LinksCard as LinksCardType } from "../../api/types";
import { domainOf } from "../../lib/format";
import { openExternal } from "../../lib/tauri";
import { CardShell } from "./CardShell";

export function LinksCard({ card }: { card: LinksCardType }) {
  return (
    <CardShell title={card.title ?? "Links"} icon={<Link2 size={14} />} count={card.items.length}>
      <ul className="divide-y divide-line">
        {card.items.map((it, i) => {
          const domain = domainOf(it.url);
          return (
            <li key={`${it.url}-${i}`}>
              <button
                type="button"
                onClick={() => void openExternal(it.url)}
                title={it.url}
                className="group flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2"
              >
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[11px] font-semibold text-accent uppercase">
                  {(domain[0] ?? "•").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-fg">{it.title || domain}</span>
                  <span className="block truncate text-[12px] text-fg-3">{domain}</span>
                  {it.snippet && <span className="clamp-2 mt-0.5 block text-[12.5px] leading-snug text-fg-2">{it.snippet}</span>}
                </span>
                <ExternalLink size={13} className="mt-1 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
}
