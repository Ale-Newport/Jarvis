import { Check, Hand, KeyRound, ShieldAlert, ShieldQuestion, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Task, WaitingKind } from "../../api/types";
import { useApp } from "../../store";
import { Button } from "../ui/Button";

const KIND_LABEL: Record<string, string> = {
  purchase: "Purchase",
  payment: "Payment",
  destructive: "Destructive action",
  account: "Account change",
  send: "Sending a message",
  sensitive: "Sensitive action",
};

const ICON: Record<WaitingKind, ReactNode> = {
  confirm: <ShieldQuestion size={17} />,
  captcha: <ShieldAlert size={17} />,
  login: <KeyRound size={17} />,
  manual: <Hand size={17} />,
};

const HEADLINE: Record<WaitingKind, string> = {
  confirm: "Needs your approval",
  captcha: "Verification needed",
  login: "Sign-in needed",
  manual: "Your turn",
};

export function WaitingBanner({ task }: { task: Task }) {
  const waiting = task.waiting;
  const confirm = useApp((s) => s.confirms[task.id]);
  const confirmTask = useApp((s) => s.confirmTask);
  const resumeTask = useApp((s) => s.resumeTask);
  const chromeFocus = useApp((s) => s.chromeFocus);
  if (!waiting) return null;
  const isConfirm = waiting.kind === "confirm";

  return (
    <div role="alert" className="anim-pop mt-2.5 rounded-xl border border-warn/30 bg-warn-soft p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-warn">{ICON[waiting.kind]}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">
            {HEADLINE[waiting.kind]}
            {isConfirm && confirm?.kind && <span className="ml-1.5 font-normal text-fg-2">· {KIND_LABEL[confirm.kind] ?? confirm.kind}</span>}
          </div>
          <div className="selectable mt-0.5 text-[13px] leading-snug text-fg">{waiting.message}</div>
          {waiting.detail && <div className="selectable mt-1 text-[12.5px] leading-snug break-words text-fg-2">{waiting.detail}</div>}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap justify-end gap-2">
        {isConfirm ? (
          <>
            <Button size="sm" variant="secondary" icon={<X size={13} />} onClick={() => void confirmTask(task, false)}>
              Deny
            </Button>
            <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => void confirmTask(task, true)}>
              Approve
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => void chromeFocus()}>
              Show browser tab
            </Button>
            <Button size="sm" variant="primary" onClick={() => void resumeTask(task.id)}>
              I've finished — Resume
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
