import { ExternalLink, File as FileIcon, FolderOpen } from "lucide-react";
import { api } from "../../api/client";
import type { FilesCard as FilesCardType } from "../../api/types";
import { formatBytes } from "../../lib/format";
import { openExternal } from "../../lib/tauri";
import { useApp } from "../../store";
import { Button } from "../ui/Button";
import { CardShell } from "./CardShell";

export function FilesCard({ card }: { card: FilesCardType }) {
  const notifyError = useApp((s) => s.notifyError);
  const reveal = async (path: string) => {
    try {
      await api.openPath(path);
    } catch (e) {
      notifyError(e, "Couldn't reveal the file");
    }
  };
  return (
    <CardShell title="Downloaded files" icon={<FolderOpen size={14} />} count={card.items.length}>
      <ul className="divide-y divide-line">
        {card.items.map((f, i) => (
          <li key={`${f.path}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-2">
              <FileIcon size={16} />
            </span>
            <span className="min-w-0 flex-1 basis-[170px]">
              <span className="block truncate text-[13.5px] font-medium">{f.name}</span>
              <span className="selectable block truncate font-mono text-[11.5px] text-fg-3" title={f.path}>
                {f.size != null ? `${formatBytes(f.size)} · ` : ""}
                {f.path}
              </span>
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              {f.url && (
                <Button variant="ghost" size="sm" title="Open the source page" onClick={() => void openExternal(f.url!)} icon={<ExternalLink size={13} />}>
                  Source
                </Button>
              )}
              <Button size="sm" onClick={() => void reveal(f.path)} icon={<FolderOpen size={13} />}>
                Reveal in Finder
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}
