import { ArrowUp, ShieldAlert, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp, selectBusyTaskId } from "../store";
import { isActiveTask } from "../store/reducer";
import { useUi } from "../store/ui";
import { cx } from "./ui/cx";
import { Kbd } from "./ui/feedback";

const MAX_HEIGHT = 200;

export function Composer({ onSent }: { onSent: () => void }) {
  const draft = useUi((s) => s.draft);
  const setDraft = useUi((s) => s.setDraft);
  const focusNonce = useUi((s) => s.focusNonce);
  const sendMessage = useApp((s) => s.sendMessage);
  const cancelTask = useApp((s) => s.cancelTask);
  const sending = useApp((s) => s.sending);
  const busyId = useApp(selectBusyTaskId);
  const busyConv = useApp((s) => (busyId ? s.tasks[busyId]?.conversation_id : null));
  const busyGoal = useApp((s) => (busyId ? s.tasks[busyId]?.goal : null));
  const activeId = useApp((s) => s.activeId);
  const openConversation = useApp((s) => s.openConversation);
  const hasFinishedTask = useApp((s) => !!s.activeId && Object.values(s.tasks).some((t) => t.conversation_id === s.activeId && !isActiveTask(t)));
  const conversations = useApp((s) => s.conversations);
  const remoteProvider = useApp((s) => (s.llm?.remote ? s.settings?.llm.provider ?? s.llm.provider : null));
  const openSettings = useUi((s) => s.openSettings);

  const ref = useRef<HTMLTextAreaElement>(null);
  const recall = useRef<{ index: number; stash: string } | null>(null);
  const [focused, setFocused] = useState(false);

  const busyHere = !!busyId && busyConv === activeId;
  const busyElsewhere = !!busyId && !busyHere;

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, []);

  useLayoutEffect(resize, [draft, resize]);

  useEffect(() => {
    if (focusNonce > 0) {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [focusNonce]);

  const history = useMemo(
    () => () => {
      const all = Object.values(useApp.getState().messages).flat().filter((m) => m.role === "user" && !m.pending);
      all.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const seen = new Set<string>();
      return all.map((m) => m.text).filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
    },
    [],
  );

  const submit = useCallback(async () => {
    const text = useUi.getState().draft;
    if (!text.trim() || sending) return;
    if (busyId) {
      useApp.getState().notify("warn", "Jarvis is working on a task. Cancel it with ⌘. or wait for it to finish.");
      return;
    }
    recall.current = null;
    setDraft("");
    onSent();
    const ok = await sendMessage(text);
    if (!ok && !useUi.getState().draft) setDraft(text); // give the text back when sending failed
  }, [sending, busyId, setDraft, sendMessage, onSent]);

  const placeholder = busyHere
    ? "Jarvis is working… you can draft your next message here."
    : hasFinishedTask
      ? "Ask a follow-up — e.g. “Now only show direct flights…”"
      : "Ask Jarvis to do something in Chrome…";

  const canSend = draft.trim().length > 0 && !sending && !busyId;

  return (
    <div className="shrink-0 px-5 pt-2 pb-4">
      <div className="mx-auto w-full max-w-[760px]">
        {remoteProvider && (
          <div className="mb-2 flex items-center gap-2 rounded-xl bg-warn-soft px-3.5 py-1.5 text-[12.5px] text-fg">
            <ShieldAlert size={14} className="shrink-0 text-warn" />
            <span className="min-w-0 flex-1 truncate">Your text model runs remotely ({remoteProvider}): prompts and page text leave this Mac.</span>
            <button type="button" className="shrink-0 font-medium text-accent hover:underline" onClick={() => openSettings("model")}>
              Details
            </button>
          </div>
        )}
        {busyElsewhere && busyConv && (
          <div className="anim-fade mb-2 flex items-center gap-2 rounded-xl bg-warn-soft px-3.5 py-2 text-[12.5px] text-fg">
            <span className="min-w-0 flex-1 truncate">
              A task is running in another chat{busyGoal ? `: “${busyGoal}”` : ""}.
            </span>
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => void openConversation(busyConv)}>
              View
            </button>
          </div>
        )}
        <div
          className={cx(
            "flex items-end gap-2 rounded-[22px] border bg-surface py-2 pr-2 pl-4 shadow-md transition-[border-color,box-shadow] duration-150",
            focused ? "border-accent/60 shadow-[0_0_0_3px_var(--accent-soft),var(--sh-md)]" : "border-line-strong",
          )}
        >
          <textarea
            ref={ref}
            rows={1}
            value={draft}
            placeholder={placeholder}
            aria-label="Message Jarvis"
            spellCheck
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              recall.current = null;
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              const el = e.currentTarget;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                el.blur();
              } else if (e.key === "ArrowUp" && !e.shiftKey && (draft === "" || recall.current) && el.selectionStart === 0 && el.selectionEnd === 0) {
                const items = history();
                if (items.length === 0) return;
                e.preventDefault();
                const next = recall.current ? Math.min(items.length - 1, recall.current.index + 1) : 0;
                recall.current = { index: next, stash: recall.current?.stash ?? draft };
                setDraft(items[next]!);
                requestAnimationFrame(() => el.setSelectionRange(0, 0));
              } else if (e.key === "ArrowDown" && recall.current && el.selectionStart === el.value.length) {
                e.preventDefault();
                const items = history();
                const idx = recall.current.index - 1;
                if (idx < 0) {
                  setDraft(recall.current.stash);
                  recall.current = null;
                } else {
                  recall.current = { ...recall.current, index: idx };
                  setDraft(items[idx] ?? "");
                }
              }
            }}
            className="max-h-[200px] min-h-[28px] flex-1 resize-none self-center bg-transparent py-1 text-[15px] leading-[1.5] text-fg placeholder:text-fg-3"
            style={{ height: 28 }}
          />
          {busyHere && busyId ? (
            <button
              type="button"
              title="Cancel task (⌘.)"
              aria-label="Cancel task"
              onClick={() => void cancelTask(busyId)}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-bg transition-opacity hover:opacity-80"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              title="Send (Enter)"
              aria-label="Send message"
              disabled={!canSend}
              onClick={() => void submit()}
              className={cx(
                "flex size-9 shrink-0 items-center justify-center rounded-full transition-all duration-150",
                canSend ? "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover" : "bg-surface-3 text-fg-3",
              )}
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex h-4 items-center justify-between px-3 text-[11.5px] text-fg-3">
          <span>
            <Kbd>↵</Kbd> send · <Kbd>⇧</Kbd>
            <Kbd>↵</Kbd> new line
            {conversations.length > 0 && <> · <Kbd>↑</Kbd> previous prompt</>}
          </span>
          <span className="hidden sm:inline">
            <Kbd>⌘</Kbd>
            <Kbd>/</Kbd> shortcuts
          </span>
        </div>
      </div>
    </div>
  );
}
