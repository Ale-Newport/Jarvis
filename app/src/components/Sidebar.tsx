import { Check, ChevronDown, PanelLeftClose, Pencil, Plus, Settings, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, Task } from "../api/types";
import { groupConversations, relativeTime } from "../lib/format";
import { isTauri } from "../lib/tauri";
import { useApp } from "../store";
import { useUi } from "../store/ui";
import { ChromePill } from "./ChromePill";
import { IconButton } from "./ui/Button";
import { ContextMenu } from "./ui/ContextMenu";
import { cx } from "./ui/cx";
import { Kbd, StatusDot } from "./ui/feedback";

export const SIDEBAR_WIDTH = 272;

function ConversationRow({ conv, active, onOpen }: { conv: Conversation; active: boolean; onOpen: () => void }) {
  const renameConversation = useApp((s) => s.renameConversation);
  const deleteConversation = useApp((s) => s.deleteConversation);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(conv.title);
      input.current?.focus();
      input.current?.select();
    }
  }, [editing, conv.title]);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== conv.title) void renameConversation(conv.id, draft);
  };

  const running = conv.last_task_status === "running" || conv.last_task_status === "waiting_user" || conv.last_task_status === "paused";

  if (confirming) {
    return (
      <div className="flex h-8 items-center gap-1 rounded-lg bg-danger-soft px-2.5 text-[13px] text-danger">
        <span className="flex-1 truncate">Delete this chat?</span>
        <IconButton label="Confirm delete" tone="danger" className="size-6" onClick={() => void deleteConversation(conv.id)}>
          <Check size={14} />
        </IconButton>
        <IconButton label="Keep" className="size-6" onClick={() => setConfirming(false)}>
          <X size={14} />
        </IconButton>
      </div>
    );
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-active={active}
        onClick={() => !editing && onOpen()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !editing) onOpen();
          if (e.key === "F2") setEditing(true);
        }}
        onDoubleClick={() => setEditing(true)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={conv.title}
        className={cx(
          "group flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors",
          active ? "bg-accent-soft font-medium text-fg" : "text-fg-2 hover:bg-surface-3/60 hover:text-fg",
        )}
      >
        {editing ? (
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-6 min-w-0 flex-1 rounded-md border border-accent bg-bg px-1.5 text-[13px] text-fg"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{conv.title || "Untitled"}</span>
        )}
        {!editing && running && <StatusDot status={conv.last_task_status!} />}
        {!editing && (
          <IconButton
            label="Delete chat"
            tone="danger"
            className="size-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
          >
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", icon: <Pencil size={13} />, onSelect: () => setEditing(true) },
            { label: "Delete", icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => setConfirming(true) },
          ]}
        />
      )}
    </>
  );
}

function RecentTasks() {
  const taskOrder = useApp((s) => s.taskOrder);
  const tasks = useApp((s) => s.tasks);
  const openConversation = useApp((s) => s.openConversation);
  const [open, setOpen] = useState(true);
  const list = useMemo(
    () =>
      taskOrder
        .map((id) => tasks[id])
        .filter((t): t is Task => !!t)
        .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
        .slice(0, 6),
    [taskOrder, tasks],
  );
  if (list.length === 0) return null;
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-3 uppercase transition-colors hover:text-fg-2"
      >
        <ChevronDown size={12} className={cx("transition-transform", !open && "-rotate-90")} />
        Recent tasks
      </button>
      {open && (
        <ul>
          {list.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => void openConversation(t.conversation_id)}
                title={`${t.goal}\n${t.status}`}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-fg-2 transition-colors hover:bg-surface-3/60 hover:text-fg"
              >
                <StatusDot status={t.status} />
                <span className="min-w-0 flex-1 truncate">{t.goal}</span>
                <span className="shrink-0 text-[11px] text-fg-3">{relativeTime(t.started_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function useOrderedConversations(): Conversation[] {
  const conversations = useApp((s) => s.conversations);
  return useMemo(() => groupConversations(conversations).flatMap((g) => g.items), [conversations]);
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const conversations = useApp((s) => s.conversations);
  const activeId = useApp((s) => s.activeId);
  const newChat = useApp((s) => s.newChat);
  const openConversation = useApp((s) => s.openConversation);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const openSettings = useUi((s) => s.openSettings);
  const groups = useMemo(() => groupConversations(conversations), [conversations]);

  return (
    <div className="flex h-full flex-col" style={{ width: SIDEBAR_WIDTH }}>
      {/* title-bar strip: leaves room for the traffic lights, doubles as drag region */}
      <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end px-2.5">
        <IconButton label="Hide sidebar (⌘B)" onClick={() => setSidebarOpen(false)}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>

      <div className="px-2.5 pb-2">
        <button
          type="button"
          onClick={() => {
            newChat();
            onNavigate?.();
          }}
          className="flex h-9 w-full items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 text-[13.5px] font-medium shadow-sm transition-colors hover:bg-surface-2"
        >
          <Plus size={16} className="text-accent" />
          New chat
          <span className="ml-auto flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>N</Kbd>
          </span>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3" aria-label="Conversations">
        {groups.length === 0 && <div className="px-2.5 py-6 text-center text-[12.5px] text-fg-3">Your conversations will appear here.</div>}
        {groups.map((g) => (
          <div key={g.label} className="mt-2 first:mt-0">
            <div className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">{g.label}</div>
            {g.items.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onOpen={() => {
                  void openConversation(c.id);
                  onNavigate?.();
                }}
              />
            ))}
          </div>
        ))}
        <RecentTasks />
      </nav>

      <div className="shrink-0 space-y-0.5 border-t border-line p-2.5">
        <ChromePill />
        <button
          type="button"
          onClick={() => openSettings()}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-fg-2 transition-colors hover:bg-surface-3/70 hover:text-fg"
        >
          <Settings size={15} />
          Settings
          <span className="ml-auto flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>,</Kbd>
          </span>
        </button>
        {!isTauri && <div className="px-2.5 pt-1 text-[10.5px] text-fg-3">Browser dev mode</div>}
      </div>
    </div>
  );
}
