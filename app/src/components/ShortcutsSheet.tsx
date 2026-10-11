import { useUi } from "../store/ui";
import { Modal } from "./ui/Modal";
import { Kbd } from "./ui/feedback";

const GROUPS: { title: string; rows: [string[], string][] }[] = [
  {
    title: "Chat",
    rows: [
      [["⌘", "N"], "New chat"],
      [["⌘", "K"], "Focus the composer"],
      [["⌘", "1…9"], "Jump to the n-th conversation"],
      [["↑"], "Recall previous prompt (empty composer)"],
      [["Esc"], "Leave the composer"],
    ],
  },
  {
    title: "Tasks",
    rows: [
      [["⌘", "."], "Cancel the running task"],
      [["⌘", "⇧", "C"], "Copy the last answer"],
    ],
  },
  {
    title: "Window",
    rows: [
      [["⌘", "B"], "Toggle sidebar"],
      [["⌘", ","], "Settings"],
      [["⌘", "/"], "This cheat sheet"],
    ],
  },
];

export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" className="w-[460px] max-w-full">
      <div className="space-y-5 overflow-y-auto px-5 py-4">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">{g.title}</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {g.rows.map(([keys, label]) => (
                <li key={label} className="flex items-center justify-between gap-4 px-3.5 py-2 text-[13px]">
                  <span>{label}</span>
                  <span className="flex gap-1">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
