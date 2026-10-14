import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Select } from "@/components/ui/Select";
import { ScrollText, Search } from "lucide-react";
import clsx from "clsx";
import { fetchAudit } from "@/hooks/queries";
import { PageHeader, EmptyState, ErrorState } from "@/components/ui/misc";
import { PageLoader } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { AUDIT_ACTION_LABELS } from "@/lib/constants";
import { dateTime } from "@/lib/format";
import { describe } from "@/components/ActivityItem";

const categories = [
  { value: "", label: "All events" },
  { value: "auth.", label: "Authentication" },
  { value: "session.", label: "Remote sessions" },
  { value: "file.", label: "File transfers" },
  { value: "device.", label: "Devices" },
  { value: "connection.", label: "Connections" },
  { value: "credential.", label: "Credentials" },
  { value: "group.", label: "Groups" },
];

export default function ActivityPage() {
  const [action, setAction] = useState("");
  const [failures, setFailures] = useState(false);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const params = (cursor?: number) => {
    const p = new URLSearchParams({ limit: "50" });
    if (action) p.set("action", action);
    if (failures) p.set("failures", "true");
    if (query) p.set("q", query);
    if (cursor) p.set("cursor", String(cursor));
    return p;
  };
  const data = useInfiniteQuery({
    queryKey: ["audit", action, failures, query],
    queryFn: ({ pageParam }) => fetchAudit(params(pageParam)),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_cursor || undefined,
    refetchInterval: 20_000,
  });
  const events = data.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <>
      <PageHeader title="Activity log" description="Security-relevant events, newest first. Secrets are never recorded." />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <form noValidate
            className="relative min-w-[200px] flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(q.trim());
            }}
          >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <input className="input pl-8" placeholder="Search target, user or IP (Enter)" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setQuery(q.trim())} aria-label="Search activity" />
          </form>
          <Select className="input w-auto" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Category">
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
          <div className="min-w-[160px]">
            <Switch checked={failures} onChange={setFailures} label="Failures only" />
          </div>
        </div>
        {data.isLoading ? (
          <PageLoader />
        ) : data.error ? (
          <div className="p-4">
            <ErrorState error={data.error} onRetry={data.refetch} />
          </div>
        ) : events.length === 0 ? (
          <EmptyState icon={<ScrollText className="h-5 w-5" />} title="No events" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-subtle">
                  <th className="py-2.5 pl-4 pr-4 font-medium">Time</th>
                  <th className="py-2.5 pr-4 font-medium">Event</th>
                  <th className="py-2.5 pr-4 font-medium">Target</th>
                  <th className="py-2.5 pr-4 font-medium">Details</th>
                  <th className="py-2.5 pr-4 font-medium">User</th>
                  <th className="py-2.5 pr-4 font-medium">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-surface-2/50">
                    <td className="whitespace-nowrap py-2.5 pl-4 pr-4 font-mono text-xs text-muted">{dateTime(e.occurred_at)}</td>
                    <td className="whitespace-nowrap py-2.5 pr-4">
                      <span className={clsx("inline-flex items-center gap-2", !e.success && "text-danger")}>
                        <span className={clsx("h-1.5 w-1.5 rounded-full", e.success ? "bg-success" : "bg-danger")} />
                        {AUDIT_ACTION_LABELS[e.action] ?? e.action}
                        {!e.success && <span className="text-xs">(failed)</span>}
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate py-2.5 pr-4" title={e.target_name}>
                      {e.target_name || <span className="text-subtle">-</span>}
                    </td>
                    <td className="max-w-[320px] py-2.5 pr-4 text-xs text-muted">{describe(e) || "-"}</td>
                    <td className="py-2.5 pr-4 text-xs">{e.actor_name || <span className="text-subtle">-</span>}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted">{e.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.hasNextPage && (
          <div className="flex justify-center border-t border-border p-3">
            <Button size="sm" onClick={() => data.fetchNextPage()} loading={data.isFetchingNextPage}>
              Load older events
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
