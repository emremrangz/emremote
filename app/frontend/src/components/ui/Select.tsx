import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import clsx from "clsx";
import { Children, Fragment, isValidElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";

// A drop-in replacement for <Select> whose list looks like the app's menus
// (the browser's own list cannot be styled). It takes <option> children and
// calls onChange with an event-like object, so call sites read e.target.value.

interface Opt {
  value: string;
  label: ReactNode;
  disabled: boolean;
}

function collect(children: ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
    if (el.type === Fragment) collect(el.props.children, out);
    else if (el.type === "option") {
      const label = el.props.children;
      const text = Children.toArray(label).join("");
      out.push({ value: el.props.value !== undefined ? String(el.props.value) : text, label, disabled: !!el.props.disabled });
    }
  });
  return out;
}

export function Select({
  value,
  onChange,
  children,
  className,
  disabled,
  autoFocus,
  id,
  ...rest
}: {
  value: string | number;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const opts = collect(children);
  const current = opts.find((o) => o.value === String(value));
  const pick = (v: string) => onChange?.({ target: { value: v }, currentTarget: { value: v } } as unknown as ChangeEvent<HTMLSelectElement>);
  return (
    <DM.Root>
      <DM.Trigger
        id={id}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={rest["aria-label"]}
        className={clsx(className, "group flex items-center justify-between gap-2 text-left data-[state=open]:border-accent/70 data-[state=open]:ring-[3px] data-[state=open]:ring-accent/15")}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? " "}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-subtle transition-transform group-data-[state=open]:rotate-180" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] min-w-[max(8rem,var(--radix-dropdown-menu-trigger-width))] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-pop animate-scale-in"
        >
          <DM.RadioGroup value={String(value)} onValueChange={pick}>
            {opts.map((o) => (
              <DM.RadioItem
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <DM.ItemIndicator>
                  <Check className="h-3.5 w-3.5 text-muted" />
                </DM.ItemIndicator>
              </DM.RadioItem>
            ))}
          </DM.RadioGroup>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
