import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";

const KEY = "emremote-file-button";
// Where the button sits, as a fraction of the window, so it stays on screen at any size.
function load(): { x: number; y: number } {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (typeof p.x === "number" && typeof p.y === "number") return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
  } catch {
    /* ignore */
  }
  return { x: 0.975, y: 0.5 };
}

const SIZE = 44;

/**
 * A small round button floating over the remote screen (separate from the toolbar and
 * draggable). Clicking it runs onOpen; dragging moves it.
 */
export function FloatingFileButton({ onOpen, title }: { onOpen: () => void; title: string }) {
  const [pos, setPos] = useState(load);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number; moved: boolean; sx: number; sy: number } | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bump((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rect = () => wrap.current?.getBoundingClientRect() ?? ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } as DOMRect);
  const place = (p: { x: number; y: number }) => {
    const r = rect();
    const left = Math.min(Math.max(p.x * r.width - SIZE / 2, 6), Math.max(6, r.width - SIZE - 6));
    const top = Math.min(Math.max(p.y * r.height - SIZE / 2, 6), Math.max(6, r.height - SIZE - 6));
    return { left, top };
  };
  const { left, top } = place(pos);

  const onDown = (e: React.PointerEvent) => {
    const r = rect();
    drag.current = { dx: e.clientX - r.left - left, dy: e.clientY - r.top - top, moved: false, sx: e.clientX, sy: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
    d.moved = true;
    const r = rect();
    setPos({ x: (e.clientX - r.left - d.dx + SIZE / 2) / r.width, y: (e.clientY - r.top - d.dy + SIZE / 2) / r.height });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      try {
        localStorage.setItem(KEY, JSON.stringify(pos));
      } catch {
        /* ignore */
      }
    } else onOpen();
  };

  return (
    <div ref={wrap} data-no-capture className="pointer-events-none absolute inset-0 z-20">
      <button
        type="button"
        title={title}
        aria-label={title}
        onMouseDown={(e) => e.preventDefault()} // keep the keyboard on the remote screen
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        style={{ left, top, width: SIZE, height: SIZE, touchAction: "none" }}
        className="pointer-events-auto absolute flex cursor-grab items-center justify-center rounded-full border border-white/15 bg-[#111317]/90 text-white/80 shadow-[0_8px_24px_rgb(0_0_0/0.5)] backdrop-blur transition-colors hover:border-white/30 hover:bg-[#1a1d23] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 active:cursor-grabbing"
      >
        <FolderOpen className="h-5 w-5" />
      </button>
    </div>
  );
}
