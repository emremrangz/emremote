import * as DM from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import type { ReactNode } from "react";

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({ children, align = "end" }: { children: ReactNode; align?: "start" | "end" | "center" }) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-[190px] rounded-lg border border-border bg-surface p-1 shadow-pop animate-scale-in"
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  icon,
  danger,
  disabled,
  shortcut,
}: {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <DM.Item
      disabled={disabled}
      onSelect={onSelect}
      className={clsx(
        "flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        danger ? "text-danger data-[highlighted]:bg-danger/10" : "data-[highlighted]:bg-surface-2",
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center text-muted">{icon}</span>}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-2xs text-subtle">{shortcut}</span>}
    </DM.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2.5 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">{children}</DM.Label>;
}

export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-border" />;
}

export function MenuCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DM.CheckboxItem
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      onSelect={(e) => e.preventDefault()}
      className="flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2"
    >
      <span className={clsx("flex h-4 w-4 items-center justify-center rounded border", checked ? "border-primary bg-primary text-primary-fg" : "border-border-strong")}>
        {checked && (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2.5 6.5l2.2 2.2 4.8-5" />
          </svg>
        )}
      </span>
      {children}
    </DM.CheckboxItem>
  );
}

export function MenuRadio<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
}) {
  return (
    <DM.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
      {options.map((o) => (
        <DM.RadioItem
          key={o.value}
          value={o.value}
          onSelect={(e) => e.preventDefault()}
          className="flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2"
        >
          <span className="flex h-4 w-4 items-center justify-center">
            <span className={clsx("h-2 w-2 rounded-full", value === o.value ? "bg-fg" : "bg-transparent")} />
          </span>
          {o.label}
        </DM.RadioItem>
      ))}
    </DM.RadioGroup>
  );
}
