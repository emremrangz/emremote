import clsx from "clsx";

/** What /api/about tells the sign-in screen. Everything is optional: the operator can hide the details. */
export interface About {
  version?: string;
  runtime?: string;
  os?: string;
  arch?: string;
  go?: string;
  uptime_s?: number;
}

// emremote's logo, a terminal window with a prompt. Plain ASCII on purpose: it lines up in any monospace font.
const LOGO = [
  ".------------------------------.",
  "| o o o                        |",
  "|------------------------------|",
  "|                              |",
  "|    \\\\                        |",
  "|     \\\\                       |",
  "|      \\\\                      |",
  "|      //         ########     |",
  "|     //                       |",
  "|    //                        |",
  "|                              |",
  "'------------------------------'",
].join("\n");

const PALETTE = ["#2d333b", "#ff7b72", "#7ee787", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#e6edf3"];

function uptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"}, ${h} hour${h === 1 ? "" : "s"}`;
  if (h > 0) return `${h} hour${h === 1 ? "" : "s"}, ${m} min`;
  return `${Math.max(m, 1)} min`;
}

function runtimeLabel(r?: string): string | undefined {
  if (r === "docker") return "Docker container";
  if (r === "podman") return "Podman container";
  if (r === "native") return "Native process";
  return r;
}

/** A neofetch-style header: the logo on the left, facts about this installation on the right. */
export function Neofetch({ about, host, secure }: { about: About | null; host: string; secure: boolean }) {
  const rows: [string, string | undefined][] = [
    ["App", about?.version ? `emremote ${about.version}` : undefined],
    ["Runtime", runtimeLabel(about?.runtime)],
    ["OS", about?.os],
    ["Arch", about?.arch],
    ["Go", about?.go],
    ["Uptime", about?.uptime_s !== undefined ? uptime(about.uptime_s) : undefined],
    ["Protocols", "RDP · VNC · SSH · Telnet"],
    ["Connection", secure ? "HTTPS (encrypted)" : "HTTP (not encrypted)"],
  ];
  return (
    <div data-term className="term-line mb-3 flex flex-col gap-x-8 gap-y-3 sm:flex-row sm:items-start" style={{ "--d": "0ms" } as React.CSSProperties}>
      <pre
        aria-hidden="true"
        className="hidden shrink-0 select-none bg-gradient-to-b from-[#7ee787] to-[#79c0ff] bg-clip-text text-[12px] leading-[1.15] text-transparent sm:block"
      >
        {LOGO}
      </pre>
      <div className="min-w-0 text-[13px] leading-[1.45]">
        <p>
          <span className="font-bold text-[#7ee787]">login</span>
          <span className="text-white/50">@</span>
          <span className="font-bold text-[#79c0ff]">{host}</span>
        </p>
        <p className="text-white/25">{"-".repeat(Math.min(host.length + 6, 34))}</p>
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <p key={k} className="flex gap-2">
              <span className={clsx("w-[5.5rem] shrink-0 font-bold", k === "Connection" && !secure ? "text-[#e3b341]" : "text-[#7ee787]")}>{k}</span>
              <span className="min-w-0 break-words text-[#c9d1d9]">{v}</span>
            </p>
          ))}
        <div className="mt-2 flex" aria-hidden="true">
          {PALETTE.map((c) => (
            <span key={c} className="h-3.5 w-6" style={{ background: c }} />
          ))}
        </div>
      </div>
    </div>
  );
}
