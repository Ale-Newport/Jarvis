import type { InputHTMLAttributes, ReactNode } from "react";
import { useEffect, useState } from "react";
import { cx } from "./cx";

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50",
        checked ? "bg-accent" : "bg-surface-3 border border-line-strong",
      )}
    >
      <span
        className={cx(
          "absolute top-[2px] size-[18px] rounded-full bg-white shadow-sm transition-[left] duration-200",
          checked ? "left-[18px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cx("inline-flex rounded-[9px] bg-surface-3 p-0.5", disabled && "opacity-50", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}
          className={cx(
            "rounded-[7px] px-3 py-1 text-[12.5px] font-medium transition-all duration-150",
            o.value === value ? "bg-surface text-fg shadow-sm" : "text-fg-2 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const inputBase =
  "h-8 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-3 transition-colors focus:border-accent disabled:opacity-60";

// full width unless the caller sets its own width utility
const fullWidthUnlessSized = (className?: string) => (/(^|\s)w-/.test(className ?? "") ? undefined : "w-full");

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input spellCheck={false} autoComplete="off" {...rest} className={cx(inputBase, fullWidthUnlessSized(className), className)} />;
}

/** Text input that only commits on blur / Enter (keeps typing responsive and avoids a PUT per keystroke). */
export function CommitInput({
  value,
  onCommit,
  className,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <TextInput
      {...rest}
      className={className}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setLocal(value);
        e.stopPropagation();
      }}
    />
  );
}

export function NumberInput({ value, onCommit, min, max, className, suffix }: { value: number; onCommit: (v: number) => void; min?: number; max?: number; className?: string; suffix?: string }) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(local));
    if (!Number.isFinite(n)) return setLocal(String(value));
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    setLocal(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <TextInput
        inputMode="numeric"
        className="w-20 text-right tabular-nums"
        value={local}
        onChange={(e) => setLocal(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      {suffix && <span className="text-[12.5px] text-fg-3">{suffix}</span>}
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange, className, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string; disabled?: boolean }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={cx(inputBase, fullWidthUnlessSized(className), "cursor-default appearance-none bg-[length:12px] bg-[position:right_9px_center] bg-no-repeat pr-7", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b8d98' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Settings row: label + help on the left, control on the right. */
export function Field({ label, help, children, stacked, className }: { label: ReactNode; help?: ReactNode; children?: ReactNode; stacked?: boolean; className?: string }) {
  return (
    <div className={cx("flex gap-4 py-3", stacked ? "flex-col" : "items-center justify-between", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-fg">{label}</div>
        {help && <div className="mt-0.5 text-[12.5px] leading-snug text-fg-3">{help}</div>}
      </div>
      {children != null && <div className={cx("shrink-0", stacked && "w-full")}>{children}</div>}
    </div>
  );
}

export function Section({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx("mb-6", className)}>
      {title && <h3 className="mb-1 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>}
      <div className="divide-y divide-line rounded-xl border border-line bg-surface px-4">{children}</div>
    </section>
  );
}
