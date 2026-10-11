import { ExternalLink } from "lucide-react";
import { README_URL } from "../../lib/links";
import { openExternal } from "../../lib/tauri";
import { useApp } from "../../store";
import { Avatar } from "../MessageBubble";
import { Button } from "../ui/Button";
import { Section } from "../ui/controls";

const CREDITS: { name: string; license: string; note: string }[] = [
  { name: "browser-use / jev-ultrafast", license: "MIT", note: "Ultra-fast browser automation primitives" },
  { name: "laya-ultrafast", license: "MIT", note: "Fast on-device decision loop" },
  { name: "browser-harness", license: "MIT", note: "Chrome DevTools Protocol harness" },
  { name: "laya-mlx", license: "Apache-2.0", note: "MLX runtime for Laya" },
  { name: "Laya", license: "Apache-2.0", note: "Typed browser-decision model" },
];

export function AboutSettings() {
  const status = useApp((s) => s.status);
  const chrome = useApp((s) => s.chrome);
  const rows: [string, string][] = [
    ["Jarvis engine", status?.version ?? "–"],
    ["Mac", status ? `${status.arch === "arm64" ? "Apple Silicon" : status.arch} · macOS ${status.macos}` : "–"],
    ["Google Chrome", chrome?.version ?? (chrome?.installed === false ? "not found" : "–")],
  ];
  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <Avatar />
        <div>
          <div className="text-[16px] font-semibold">Jarvis</div>
          <div className="text-[12.5px] text-fg-3">A local-first AI agent that drives your real Chrome.</div>
        </div>
        <Button className="ml-auto" icon={<ExternalLink size={13} />} onClick={() => void openExternal(README_URL)}>
          README
        </Button>
      </div>
      <Section title="Versions">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between py-2.5 text-[13px]">
            <span className="text-fg-2">{k}</span>
            <span className="selectable font-medium tabular-nums">{v}</span>
          </div>
        ))}
      </Section>
      <Section title="Credits and licenses">
        {CREDITS.map((c) => (
          <div key={c.name} className="flex items-center justify-between gap-4 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{c.name}</div>
              <div className="text-[12px] text-fg-3">{c.note}</div>
            </div>
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-medium text-fg-2">{c.license}</span>
          </div>
        ))}
      </Section>
      <p className="text-[12px] leading-relaxed text-fg-3">Jarvis itself is MIT licensed. Third-party components keep their own licenses. Full texts are in the project repository.</p>
    </>
  );
}
