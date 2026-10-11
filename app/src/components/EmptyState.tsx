import { Newspaper, Plane, Images, Table2, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { greeting } from "../lib/format";
import { useApp } from "../store";
import { useUi } from "../store/ui";

const EXAMPLES = [
  { icon: Plane, text: "Find the cheapest direct flights from Madrid to Lisbon next Friday" },
  { icon: Images, text: "Show me 8 great photos of mid-century desk lamps" },
  { icon: Table2, text: "Compare the top 3 noise-cancelling headphones under $300 in a table" },
  { icon: Newspaper, text: "Open Hacker News and summarize the top 5 stories" },
];

export function EmptyState() {
  const setDraft = useUi((s) => s.setDraft);
  const focusComposer = useUi((s) => s.focusComposer);
  const chromeState = useApp((s) => s.chrome?.state);
  const hello = useMemo(() => greeting(), []);

  return (
    <div className="anim-fade mx-auto flex min-h-full max-w-[640px] flex-col items-center justify-center px-5 py-10 text-center">
      <span
        className="mb-5 flex size-14 items-center justify-center rounded-2xl text-white shadow-md"
        style={{ background: "linear-gradient(135deg, #8a8ffb, #4b45df)" }}
      >
        <Sparkles size={26} strokeWidth={2} />
      </span>
      <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{hello}.</h1>
      <p className="mt-1.5 text-[16px] text-fg-2">What should I do in Chrome for you?</p>

      <div className="mt-8 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
        {EXAMPLES.map(({ icon: Icon, text }) => (
          <button
            key={text}
            type="button"
            onClick={() => {
              setDraft(text);
              focusComposer();
            }}
            className="group flex items-start gap-3 rounded-2xl border border-line bg-surface p-3.5 text-left shadow-sm transition-all duration-150 hover:-translate-y-px hover:border-line-strong hover:shadow-md"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Icon size={16} />
            </span>
            <span className="text-[13.5px] leading-snug text-fg-2 transition-colors group-hover:text-fg">{text}</span>
          </button>
        ))}
      </div>

      <p className="mt-8 max-w-[460px] text-[12.5px] leading-relaxed text-fg-3">
        Jarvis runs on your Mac and drives your real Google Chrome
        {chromeState && chromeState !== "connected" ? " — it will connect when you send your first task" : ""}. Follow-up messages keep the context of the page it's on.
      </p>
    </div>
  );
}
