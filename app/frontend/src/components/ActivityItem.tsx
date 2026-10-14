import clsx from "clsx";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { AuditEvent } from "@/lib/types";
import { AUDIT_ACTION_LABELS } from "@/lib/constants";
import { bytes as bytesLabel, dateTime, duration, relativeTime } from "@/lib/format";

export function describe(e: AuditEvent): string {
  const d = e.details ?? {};
  const parts: string[] = [];
  if (typeof d.reason === "string") parts.push(d.reason);
  if (Array.isArray(d.changed) && d.changed.length) parts.push(`changed: ${(d.changed as string[]).join(", ")}`);
  if (typeof d.duration_s === "number") parts.push(`duration ${duration(d.duration_s)}`);
  if (typeof d.closed_by === "string") parts.push(`closed by ${d.closed_by}`);
  if (typeof d.gateway_error === "string") parts.push(`gateway: ${d.gateway_error}`);
  if (typeof d.target === "string") parts.push(String(d.target));
  if (typeof d.path === "string") parts.push(String(d.path) + (typeof d.new_path === "string" ? ` → ${d.new_path}` : ""));
  if (typeof d.bytes === "number") parts.push(bytesLabel(d.bytes));
  if (typeof d.protocol === "string" && !e.action.startsWith("session.end")) parts.push(String(d.protocol).toUpperCase());
  return parts.join(" · ");
}

export function ActivityItem({ e, compact }: { e: AuditEvent; compact?: boolean }) {
  const label = AUDIT_ACTION_LABELS[e.action] ?? e.action;
  return (
    <li className="flex gap-3 py-2.5">
      {e.success ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success/80" />
      ) : (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className={clsx("font-medium", !e.success && "text-danger")}>
            {label}
            {!e.success && " (failed)"}
          </span>
          {e.target_name && <span className="text-muted"> · {e.target_name}</span>}
        </p>
        {!compact && describe(e) && <p className="mt-0.5 truncate text-xs text-subtle">{describe(e)}</p>}
      </div>
      <time className="shrink-0 text-xs text-subtle" dateTime={e.occurred_at} title={dateTime(e.occurred_at)}>
        {relativeTime(e.occurred_at)}
      </time>
    </li>
  );
}
