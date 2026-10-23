import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, Play, Trash2, Video } from "lucide-react";
import { PageHeader, EmptyState, ErrorState } from "@/components/ui/misc";
import { PageLoader } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { ProtocolBadge } from "@/components/Status";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RecordingPlayer } from "@/components/RecordingPlayer";
import { RecordingExport } from "@/components/RecordingExport";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";
import { canExportVideo } from "@/lib/recordingExport";
import { useToast } from "@/components/ui/Toast";
import { useAccess } from "@/lib/auth";
import { del, get } from "@/lib/api";
import { bytes, dateTime, duration } from "@/lib/format";
import type { Protocol, Recording } from "@/lib/types";

const PAGE = 50;

export default function RecordingsPage() {
  const { isAdmin } = useAccess();
  const toast = useToast();
  const qc = useQueryClient();
  const [protocol, setProtocol] = useState("");
  const [page, setPage] = useState(0);
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [removing, setRemoving] = useState<Recording | null>(null);
  const [exporting, setExporting] = useState<Recording | null>(null);
  const q = useQuery({
    queryKey: ["recordings", protocol, page],
    queryFn: () => get<{ items: Recording[]; total: number }>(`/api/recordings?limit=${PAGE}&offset=${page * PAGE}${protocol ? `&protocol=${protocol}` : ""}`),
    refetchInterval: 15000,
  });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { items, total } = q.data;
  return (
    <>
      <PageHeader
        title="Recordings"
        description={isAdmin ? "Recorded remote sessions of everyone. Recording is set up in Settings." : "Recordings of your own sessions."}
        actions={
          <Select className="input w-40" value={protocol} onChange={(e) => { setProtocol(e.target.value); setPage(0); }} aria-label="Protocol">
            <option value="">All protocols</option>
            {["ssh", "rdp", "vnc", "telnet"].map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </Select>
        }
      />
      <div className="card overflow-hidden">
        {items.length === 0 ? (
          <EmptyState icon={<Video className="h-5 w-5" />} title="No recordings yet">
            {isAdmin ? "Turn on session recording in Settings; sessions started afterwards appear here." : "When recording is on, your sessions appear here."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-border text-left text-xs text-subtle">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Started</th>
                  <th className="px-4 py-2.5 font-medium">Device</th>
                  <th className="px-4 py-2.5 font-medium">Protocol</th>
                  {isAdmin && <th className="px-4 py-2.5 font-medium">User</th>}
                  <th className="px-4 py-2.5 font-medium">Length</th>
                  <th className="px-4 py-2.5 font-medium">Size</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap px-4 py-2.5">{dateTime(r.started_at)}</td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{r.device_name}</span> <span className="text-subtle">/ {r.connection_name}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <ProtocolBadge protocol={r.protocol as Protocol} />
                    </td>
                    {isAdmin && <td className="px-4 py-2.5">{r.username}</td>}
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {r.ended_at ? duration(Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)) : <span className="text-danger">Recording now</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">{r.ended_at ? bytes(r.size_bytes) : "-"}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} onClick={() => setPlaying(r)}>
                          Play
                        </Button>
                        <Menu>
                          <MenuTrigger asChild>
                            <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} aria-label="Download the recording">
                              <ChevronDown className="h-3 w-3 opacity-70" />
                            </Button>
                          </MenuTrigger>
                          <MenuContent>
                            {canExportVideo() && r.ended_at && <MenuItem onSelect={() => setExporting(r)}>Video (MP4)</MenuItem>}
                            <MenuItem onSelect={() => window.location.assign(`/api/recordings/${r.id}/file?download=1`)}>Raw recording (.guac)</MenuItem>
                          </MenuContent>
                        </Menu>
                        {isAdmin && r.ended_at && (
                          <Button size="icon-sm" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label="Delete the recording" onClick={() => setRemoving(r)} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE && (
          <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted">
            <span>
              {page * PAGE + 1} to {Math.min(total, (page + 1) * PAGE)} of {total}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Newer
              </Button>
              <Button size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>
                Older
              </Button>
            </div>
          </div>
        )}
      </div>
      <RecordingPlayer recording={playing} onClose={() => setPlaying(null)} />
      <RecordingExport recording={exporting} onClose={() => setExporting(null)} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Delete this recording?"
        confirmLabel="Delete"
        onConfirm={async () => {
          await del(`/api/recordings/${removing!.id}`);
          qc.invalidateQueries({ queryKey: ["recordings"] });
          toast.success("Recording deleted.");
        }}
      >
        {removing && `${removing.device_name}, ${dateTime(removing.started_at)}. The file is removed from the server and cannot be restored.`}
      </ConfirmDialog>
    </>
  );
}
