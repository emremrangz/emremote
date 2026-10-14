import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import clsx from "clsx";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  bodyClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "2xl";
  bodyClassName?: string;
}) {
  const width = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl", "2xl": "max-w-5xl" }[size];
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] animate-fade-in" />
        <RD.Content
          className={clsx(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "rounded-2xl border border-border bg-surface shadow-pop animate-dialog-in focus:outline-none",
            width,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div className="min-w-0">
              <RD.Title className="text-base font-semibold tracking-[-0.005em]">{title}</RD.Title>
              {description ? (
                <RD.Description asChild><div className="mt-1.5 text-[13px] text-muted">{description}</div></RD.Description>
              ) : (
                <RD.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RD.Description>
              )}
            </div>
            <RD.Close className="-mr-1.5 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Close">
              <X className="h-4 w-4" />
            </RD.Close>
          </div>
          <div className={clsx("min-h-0 flex-1 overflow-y-auto", bodyClassName ?? "px-6 py-5")}>{children}</div>
          {footer && (
            <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-2xl border-t border-border bg-surface-2/40 px-6 py-3.5">{footer}</div>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
