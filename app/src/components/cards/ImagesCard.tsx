import { Check, Copy, ExternalLink, ImageOff, Images } from "lucide-react";
import { useState } from "react";
import type { ImagesCard as ImagesCardType } from "../../api/types";
import { copyText } from "../../lib/clipboard";
import { domainOf } from "../../lib/format";
import { openExternal } from "../../lib/tauri";
import { CardShell } from "./CardShell";

type Item = ImagesCardType["items"][number];

function Tile({ item }: { item: Item }) {
  const [broken, setBroken] = useState(false);
  const [copied, setCopied] = useState(false);
  const target = item.source_url ?? item.image_url;
  const copyUrl = item.image_url ?? item.source_url ?? (item.thumbnail_url && !item.thumbnail_url.startsWith("data:") ? item.thumbnail_url : null);
  const showImage = item.thumbnail_url && !broken;

  return (
    <div className="group relative overflow-hidden rounded-lg border border-line bg-surface-2">
      <button
        type="button"
        disabled={!target}
        onClick={() => target && void openExternal(target)}
        title={item.title}
        className="block aspect-[4/3] w-full disabled:cursor-default"
      >
        {showImage ? (
          <img
            src={item.thumbnail_url ?? undefined}
            alt={item.title}
            referrerPolicy="no-referrer"
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1 px-2 text-fg-3">
            <ImageOff size={20} />
            <span className="clamp-2 text-center text-[11px] leading-tight">{item.title}</span>
          </span>
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-end gap-1 p-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {copyUrl && (
          <button
            type="button"
            title="Copy image URL"
            aria-label="Copy image URL"
            onClick={async () => {
              if (await copyText(copyUrl)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }
            }}
            className="pointer-events-auto flex size-6 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur transition-colors hover:bg-black/75"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
        {item.source_url && (
          <button
            type="button"
            title="Open source page"
            aria-label="Open source page"
            onClick={() => void openExternal(item.source_url!)}
            className="pointer-events-auto flex size-6 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur transition-colors hover:bg-black/75"
          >
            <ExternalLink size={13} />
          </button>
        )}
      </div>
      <div className="px-2 py-1.5">
        <div className="truncate text-[12px] font-medium text-fg">{item.title}</div>
        <div className="truncate text-[11px] text-fg-3">{domainOf(item.source_url ?? item.image_url) || (item.width && item.height ? `${item.width}×${item.height}` : "")}</div>
      </div>
    </div>
  );
}

export function ImagesCard({ card }: { card: ImagesCardType }) {
  return (
    <CardShell title={card.title ?? "Images"} icon={<Images size={14} />} count={card.items.length}>
      <div className="grid grid-cols-2 gap-2 p-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {card.items.map((it, i) => (
          <Tile key={`${it.source_url ?? it.image_url ?? it.title}-${i}`} item={it} />
        ))}
      </div>
    </CardShell>
  );
}
