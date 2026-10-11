import { Sparkles } from "lucide-react";
import { memo } from "react";
import type { UiMessage } from "../store/reducer";
import { CardList } from "./cards/CardRenderer";
import { Markdown } from "./Markdown";
import { CopyButton } from "./ui/CopyButton";
import { cx } from "./ui/cx";

export function Avatar() {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-white shadow-sm"
      style={{ background: "linear-gradient(135deg, #8a8ffb, #4b45df)" }}
    >
      <Sparkles size={14} strokeWidth={2.2} />
    </span>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1.5" aria-label="Jarvis is writing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="anim-pulse size-1.5 rounded-full bg-fg-3" style={{ animationDelay: `${i * 0.18}s` }} />
      ))}
    </span>
  );
}

export const MessageBubble = memo(function MessageBubble({ message }: { message: UiMessage }) {
  if (message.role === "user") {
    return (
      <div className="group flex justify-end gap-1.5" data-role="user">
        <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={message.text} label="Copy message" size={13} />
        </div>
        <div
          className={cx(
            "selectable max-w-[82%] rounded-[20px] rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-[1.5] whitespace-pre-wrap text-accent-fg shadow-sm",
            message.pending && "opacity-70",
          )}
          style={{ overflowWrap: "anywhere" }}
        >
          {message.text}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return <div className="selectable mx-auto max-w-[80%] text-center text-[12.5px] text-fg-3">{message.text}</div>;
  }

  const hasText = message.text.trim().length > 0;
  return (
    <div className="group flex gap-3" data-role="assistant">
      <Avatar />
      <div className="min-w-0 flex-1">
        {(hasText || message.streaming) && (
          <div className="rounded-[20px] rounded-tl-md border border-line bg-surface px-4 py-3 shadow-sm">{hasText ? <Markdown text={message.text} /> : <TypingDots />}</div>
        )}
        {message.cards.length > 0 && <CardList cards={message.cards} />}
        {/* fixed-height footer: no layout shift when the actions appear or streaming ends */}
        <div className="mt-1 flex h-7 items-center gap-1 pl-1">
          {message.streaming ? (
            <span className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
              <span className="anim-pulse size-1.5 rounded-full bg-accent" /> Writing…
            </span>
          ) : (
            hasText && (
              <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <CopyButton text={message.text} label="Copy answer" />
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
});
