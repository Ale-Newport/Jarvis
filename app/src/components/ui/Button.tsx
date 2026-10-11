import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Spinner } from "./feedback";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-soft";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-sm",
  secondary: "bg-surface text-fg border border-line-strong hover:bg-surface-2 shadow-sm",
  ghost: "text-fg-2 hover:text-fg hover:bg-surface-2",
  danger: "bg-danger text-white hover:opacity-90 shadow-sm",
  "danger-soft": "bg-danger-soft text-danger hover:opacity-80",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12.5px] rounded-[7px]",
  md: "h-8 px-3.5 text-[13px] rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export function Button({ variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <Spinner size={13} /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  tone?: "default" | "danger";
}

export function IconButton({ label, active, tone = "default", className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={cx(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-40",
        tone === "danger" ? "text-fg-3 hover:bg-danger-soft hover:text-danger" : "text-fg-3 hover:bg-surface-2 hover:text-fg",
        active && "bg-surface-2 text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}
