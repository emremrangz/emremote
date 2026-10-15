import type { FormEvent, MouseEvent, ReactNode } from "react";
import clsx from "clsx";
import { Github } from "lucide-react";

/** The terminal window used by the sign-in and first-run screens. */
export function TerminalShell({
  title,
  heading,
  shaking,
  onShakeEnd,
  onSubmit,
  onBackgroundClick,
  children,
}: {
  /** Shown after "emremote@host:" in the title bar, e.g. "login". */
  title: string;
  /** Screen-reader heading. */
  heading: string;
  shaking?: boolean;
  onShakeEnd?: () => void;
  onSubmit: (e: FormEvent) => void;
  /** Clicking empty terminal space (use it to focus a field). */
  onBackgroundClick?: () => void;
  children: ReactNode;
}) {
  const host = window.location.host;
  const secure = window.location.protocol === "https:";
  return (
    <div className="login-bg relative flex min-h-full items-center justify-center px-4 py-12">
      <form
        onSubmit={onSubmit}
        noValidate
        className={clsx(
          "w-full max-w-[680px] overflow-hidden rounded-2xl border border-white/10 bg-[#0a0e13] shadow-[0_40px_100px_-24px_rgba(0,0,0,0.9),0_0_0_1px_rgba(126,231,135,0.05),0_0_80px_-30px_rgba(126,231,135,0.25)] animate-fade-in",
          shaking && "term-shake",
        )}
        onAnimationEnd={(e) => e.target === e.currentTarget && onShakeEnd?.()}
        onClick={(e: MouseEvent) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.term !== undefined) onBackgroundClick?.();
        }}
      >
        <h1 className="sr-only">{heading}</h1>
        <div className="flex items-center gap-2 border-b border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.02] px-4 py-2.5">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]" />
          <span className="flex-1 truncate px-3 text-center font-mono text-xs text-white/50">
            emremote@{host}: {title}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-white/40" title={secure ? "Encrypted connection (HTTPS)" : "Connection is not encrypted"}>
            <span className={clsx("h-1.5 w-1.5 rounded-full", secure ? "bg-[#7ee787]" : "bg-[#e3b341]")} />
            {secure ? "TLS" : "plain"}
          </span>
        </div>
        <div data-term className="term-screen cursor-text space-y-0.5 px-6 pb-6 pt-5 font-mono text-[13px] leading-6 text-[#c9d1d9]">
          {children}
        </div>
      </form>
      <a
        href="https://github.com/emremrangz/emremote"
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-4 right-4 flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 font-mono text-[11px] text-white/50 transition-colors hover:border-white/25 hover:text-white/80"
      >
        <Github className="h-3.5 w-3.5" /> GitHub
      </a>
    </div>
  );
}

/** "❯ label:" at the start of an input line. */
export function TermPrompt({ label }: { label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="text-[#7ee787]">❯</span>
      <span className="text-[#79c0ff]">{label}:</span>
    </span>
  );
}

export const TERM_FIELD =
  "min-w-0 flex-1 border-0 bg-transparent p-0 text-[#e6edf3] caret-[#7ee787] outline-none focus:ring-0 placeholder:text-white/20 disabled:opacity-60";
