import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import clsx from "clsx";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  message: string;
}

const Ctx = createContext<(kind: Kind, message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const push = useCallback((kind: Kind, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => dismiss(id), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => {
          const Icon = t.kind === "success" ? CheckCircle2 : t.kind === "error" ? AlertCircle : Info;
          return (
            <div
              key={t.id}
              role={t.kind === "error" ? "alert" : "status"}
              className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-sm shadow-pop animate-scale-in"
            >
              <Icon
                className={clsx(
                  "mt-0.5 h-4 w-4 shrink-0",
                  t.kind === "success" ? "text-success" : t.kind === "error" ? "text-danger" : "text-accent",
                )}
              />
              <p className="min-w-0 flex-1 break-words">{t.message}</p>
              <button onClick={() => dismiss(t.id)} className="text-subtle hover:text-fg" aria-label="Dismiss">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = useContext(Ctx);
  return {
    success: (m: string) => push("success", m),
    error: (m: string) => push("error", m),
    info: (m: string) => push("info", m),
  };
}
