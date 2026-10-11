import { ArrowDown, Keyboard, PanelLeft } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { isTauri } from "../lib/tauri";
import { selectActiveMessages, useApp } from "../store";
import { useUi } from "../store/ui";
import { ChromePill } from "./ChromePill";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";
import { TaskPanel } from "./task/TaskPanel";
import { IconButton } from "./ui/Button";
import { cx } from "./ui/cx";

function TopBar() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const narrow = useUi((s) => s.narrow);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen);
  const title = useApp((s) => (s.activeId ? s.conversations.find((c) => c.id === s.activeId)?.title : null));
  const showToggle = !sidebarOpen || narrow;
  return (
    <header
      data-tauri-drag-region
      className={cx("flex h-[52px] shrink-0 items-center gap-2 border-b border-transparent pr-3", showToggle && isTauri && !narrow ? "pl-[84px]" : "pl-4")}
    >
      {showToggle && (
        <IconButton label="Show sidebar (⌘B)" onClick={() => setSidebarOpen(true)}>
          <PanelLeft size={16} />
        </IconButton>
      )}
      <h1 data-tauri-drag-region className="pointer-events-none min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">
        {title ?? "New chat"}
      </h1>
      {!sidebarOpen && !narrow && <ChromePill compact />}
      <IconButton label="Keyboard shortcuts (⌘/)" onClick={() => setShortcutsOpen(true)}>
        <Keyboard size={16} />
      </IconButton>
    </header>
  );
}

type Item = { kind: "msg"; id: string; index: number } | { kind: "task"; id: string };

export function ChatView() {
  const activeId = useApp((s) => s.activeId);
  const messages = useApp(selectActiveMessages);
  const loading = useApp((s) => s.conversationLoading);
  // [taskId, messageId, taskId, messageId, ...] for the active conversation, oldest first
  const taskPairs = useApp(
    useShallow((s) => {
      if (!s.activeId) return [] as string[];
      const list = Object.values(s.tasks).filter((t) => t.conversation_id === s.activeId);
      list.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "") || a.id.localeCompare(b.id));
      return list.flatMap((t) => [t.id, t.message_id]);
    }),
  );

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);

  const items = useMemo<Item[]>(() => {
    const byMessage = new Map<string, string>();
    const ids: string[] = [];
    for (let i = 0; i < taskPairs.length; i += 2) {
      byMessage.set(taskPairs[i + 1]!, taskPairs[i]!);
      ids.push(taskPairs[i]!);
    }
    const idSet = new Set(ids);
    const used = new Set<string>();
    const out: Item[] = [];
    (messages ?? []).forEach((m, index) => {
      out.push({ kind: "msg", id: m.id, index });
      if (m.role === "user") {
        const tid = byMessage.get(m.id) ?? (m.task_id && idSet.has(m.task_id) ? m.task_id : undefined);
        if (tid && !used.has(tid)) {
          used.add(tid);
          out.push({ kind: "task", id: tid });
        }
      }
    });
    for (const id of ids) if (!used.has(id)) out.push({ kind: "task", id });
    return out;
  }, [messages, taskPairs]);

  const latestTaskId = taskPairs.length ? taskPairs[taskPairs.length - 2] : undefined;

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // follow growth (streaming text, new steps, images loading) only while the user is at the bottom
  useEffect(() => {
    const target = content.current;
    if (!target) return;
    const ro = new ResizeObserver(() => {
      if (stuck.current) toBottom();
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [toBottom]);

  // switching conversations: start at the bottom
  useLayoutEffect(() => {
    stuck.current = true;
    setAway(false);
    toBottom();
  }, [activeId, toBottom]);

  const empty = !loading && items.length === 0;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-bg">
      <TopBar />
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable", overflowAnchor: "none" }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          stuck.current = near;
          setAway((prev) => (prev === !near ? prev : !near));
        }}
      >
        <div ref={content} className="mx-auto w-full max-w-[760px] px-5 pt-2 pb-6">
          {empty && <EmptyState />}
          {loading && items.length === 0 && (
            <div className="space-y-4 pt-4">
              <div className="skeleton ml-auto h-10 w-2/5 rounded-2xl" />
              <div className="skeleton h-24 w-4/5 rounded-2xl" />
            </div>
          )}
          <div className="space-y-5">
            {items.map((it) =>
              it.kind === "msg" ? (
                <MessageBubble key={it.id} message={messages![it.index]!} />
              ) : (
                <TaskPanel key={`task-${it.id}`} taskId={it.id} latest={it.id === latestTaskId} />
              ),
            )}
          </div>
        </div>
      </div>
      {away && (
        <button
          type="button"
          onClick={() => {
            stuck.current = true;
            toBottom(true);
          }}
          className="anim-pop absolute bottom-[104px] left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-surface px-3 text-[12.5px] font-medium shadow-md transition-colors hover:bg-surface-2"
        >
          <ArrowDown size={14} /> Latest
        </button>
      )}
      <Composer
        onSent={() => {
          stuck.current = true;
          toBottom();
        }}
      />
    </div>
  );
}
