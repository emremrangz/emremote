import clsx from "clsx";
import { useId, type ReactNode, cloneElement, isValidElement, type ReactElement } from "react";

export function Field({
  label,
  hint,
  error,
  children,
  className,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  optional?: boolean;
}) {
  const id = useId();
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<any>, {
        id: (children as ReactElement<any>).props.id ?? id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": error || hint ? `${id}-desc` : undefined,
      })
    : children;
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {optional && <span className="ml-1 font-normal text-subtle">(optional)</span>}
      </label>
      {child}
      {(error || hint) && (
        <p id={`${id}-desc`} className={clsx("mt-1.5 text-xs", error ? "text-danger" : "text-subtle")}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-subtle">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
          checked ? "border-primary bg-primary" : "border-border-strong bg-surface-3",
        )}
      >
        <span
          className={clsx(
            "inline-block h-3.5 w-3.5 rounded-full shadow transition-transform",
            checked ? "translate-x-[18px] bg-primary-fg" : "translate-x-[2px] bg-white dark:bg-muted",
          )}
        />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-[5px] font-medium transition-colors",
            size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-xs",
            value === o.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
