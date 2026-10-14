import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "icon" | "icon-sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary/85 shadow-card",
  secondary: "bg-surface text-fg border border-border shadow-card hover:bg-surface-2 hover:border-border-strong",
  outline: "border border-border text-fg hover:bg-surface-2",
  ghost: "text-muted hover:text-fg hover:bg-surface-2",
  danger: "bg-danger text-white hover:bg-danger/90 shadow-card",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  icon: "h-9 w-9 justify-center",
  "icon-sm": "h-7 w-7 justify-center",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex shrink-0 select-none items-center rounded-md font-medium transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4" /> : icon}
      {children}
    </button>
  );
});
