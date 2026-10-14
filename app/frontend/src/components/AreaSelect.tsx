import { useEffect, useRef, useState } from "react";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A full-window layer to drag a rectangle on; reports it in window coordinates. Esc cancels. */
export function AreaSelect({ onDone, onCancel }: { onDone: (r: Region) => void; onCancel: () => void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<Region | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const rect = (a: { x: number; y: number }, x: number, y: number): Region => ({ x: Math.min(a.x, x), y: Math.min(a.y, y), w: Math.abs(x - a.x), h: Math.abs(y - a.y) });

  return (
    <div
      data-no-capture
      className="fixed inset-0 z-[60] cursor-crosshair select-none bg-black/35"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY };
        setBox({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => start.current && setBox(rect(start.current, e.clientX, e.clientY))}
      onPointerUp={(e) => {
        const a = start.current;
        start.current = null;
        if (!a) return;
        const r = rect(a, e.clientX, e.clientY);
        if (r.w < 8 || r.h < 8) setBox(null);
        else onDone(r);
      }}
    >
      {box && box.w > 0 && (
        <div
          className="pointer-events-none absolute border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
          style={{ left: box.x, top: box.y, width: box.w, height: box.h, background: "rgba(255,255,255,0.04)" }}
        >
          <span className="absolute -bottom-6 left-0 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white">
            {Math.round(box.w)} × {Math.round(box.h)}
          </span>
        </div>
      )}
      <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-lg border border-white/15 bg-[#111317]/95 px-4 py-2 text-[13px] text-white shadow-lg">
        Drag over the part of the screen to capture. <kbd className="ml-2 rounded border border-white/25 px-1 text-[11px]">Esc</kbd> cancels.
      </div>
    </div>
  );
}
