import { ArrowUpRight, Table2 } from "lucide-react";
import type { TableCard as TableCardType } from "../../api/types";
import { openExternal } from "../../lib/tauri";
import { CardShell } from "./CardShell";

export function TableCard({ card }: { card: TableCardType }) {
  const hasLinks = card.rows.some((r) => r.url);
  return (
    <CardShell title={card.title ?? "Table"} icon={<Table2 size={14} />} count={card.rows.length}>
      <div className="selectable overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">
              {card.columns.map((c, i) => (
                <th key={`${c}-${i}`} className="px-3.5 py-2 font-semibold whitespace-nowrap">
                  {c}
                </th>
              ))}
              {hasLinks && <th className="w-8" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {card.rows.map((r, ri) => (
              <tr key={ri} className="transition-colors hover:bg-surface-2/70">
                {card.columns.map((_, ci) => (
                  <td key={ci} className={ci === 0 ? "px-3.5 py-2 font-medium" : "px-3.5 py-2 text-fg-2"}>
                    {r.cells[ci] ?? ""}
                  </td>
                ))}
                {hasLinks && (
                  <td className="pr-2 text-right">
                    {r.url && (
                      <button
                        type="button"
                        title={r.url}
                        aria-label="Open link"
                        onClick={() => void openExternal(r.url!)}
                        className="inline-flex size-6 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-surface-3 hover:text-accent"
                      >
                        <ArrowUpRight size={14} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {card.note && <div className="border-t border-line px-3.5 py-2 text-[12px] text-fg-3">{card.note}</div>}
    </CardShell>
  );
}
