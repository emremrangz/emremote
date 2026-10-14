import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Select } from "@/components/ui/Select";
import { useInfiniteQuery } from "@tanstack/react-query";
import { RotateCw, Terminal } from "lucide-react";
import type { Connection, Device } from "@/lib/types";
import { errorMessage, post } from "@/lib/api";
import { useSSHAccess } from "@/hooks/useSSHAccess";
import { fetchAudit } from "@/hooks/queries";
import { SSHAccessGate } from "./SSHAccessGate";
import { SystemPanel } from "./SystemPanel";
import { FileBrowser } from "./FileBrowser";
import { CopyButton } from "./ui/misc";
import { Button } from "./ui/Button";
import { ActivityItem } from "./ActivityItem";
import { PageLoader, Spinner } from "./ui/Spinner";

type AutoState = "checking" | "closed" | "auth_failed" | "needs_credentials" | "error";

const WINDOWS_ENABLE_SSH =
  "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Set-Service -Name sshd -StartupType Automatic; Start-Service sshd";

/** System overview and file browser for a device, through one of its SSH methods. */
export function DeviceSSHWorkspace({
  view,
  device,
  connections,
  onVerifyHostKey,
  onAddSSH,
}: {
  view: "system" | "files";
  device: Device;
  connections: Connection[];
  onVerifyHostKey: (c: Connection) => void;
  onAddSSH: () => void;
}) {
  const sshConnections = connections.filter((c) => c.protocol === "ssh");
  const [selectedId, setSelectedId] = useState(sshConnections[0]?.id);
  const conn = sshConnections.find((c) => c.id === selectedId) ?? sshConnections[0];
  if (!conn) return <NoSSH view={view} device={device} connections={connections} onAddSSH={onAddSSH} />;
  return (
    <div className="space-y-3">
      {sshConnections.length > 1 && (
        <Select className="input w-auto" value={conn.id} onChange={(e) => setSelectedId(e.target.value)} aria-label="SSH method">
          {sshConnections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} (:{c.port})
            </option>
          ))}
        </Select>
      )}
      <Inner key={conn.id} view={view} conn={conn} onVerifyHostKey={() => onVerifyHostKey(conn)} />
    </div>
  );
}

/**
 * The device has no SSH method yet. Try to discover the built-in SSH server
 * (Windows OpenSSH, Linux sshd) and use the RDP/VNC sign-in automatically;
 * otherwise explain how to enable it and offer the RDP transfer drive.
 */
function NoSSH({ view, device, connections, onAddSSH }: { view: "system" | "files"; device: Device; connections: Connection[]; onAddSSH: () => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState<AutoState>("checking");
  const [detail, setDetail] = useState("");
  const hasRDP = connections.some((c) => c.protocol === "rdp");
  const canAuto = connections.some((c) => c.protocol === "rdp" || c.protocol === "vnc");

  const detect = async () => {
    setState("checking");
    try {
      const r = await post<{ status: string; username?: string }>(`/api/devices/${device.id}/ssh-auto`);
      if (r.status === "created" || r.status === "exists") {
        await qc.invalidateQueries({ queryKey: ["devices", device.id] });
        await qc.invalidateQueries({ queryKey: ["devices"] });
        return;
      }
      setDetail(r.username ?? "");
      setState(r.status as AutoState);
    } catch (e) {
      setDetail(errorMessage(e));
      setState("error");
    }
  };
  useEffect(() => {
    if (canAuto) detect();
    else setState("needs_credentials");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  if (state === "checking")
    return (
      <div className="card flex items-center justify-center gap-3 py-14 text-[13px] text-muted">
        <Spinner /> Looking for the device's built-in SSH server…
      </div>
    );

  const windows = device.os === "windows";
  const explanation = (
    <div className="card px-5 py-4">
      <div className="flex flex-wrap items-start gap-4">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          <Terminal className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 text-[13px]">
          <h3 className="text-sm font-semibold">
            {state === "auth_failed"
              ? "SSH is running, but the saved sign-in did not work over SSH"
              : view === "system"
                ? "System information comes from the computer's built-in SSH server"
                : "Full disk access uses the computer's built-in SSH server"}
          </h3>
          <p className="mt-1 text-muted">
            {state === "auth_failed" ? (
              <>
                emremote tried <span className="font-mono">{detail}</span> with the password saved for {hasRDP ? "RDP" : "this device"}. Add an SSH
                method with the right account.
              </>
            ) : windows ? (
              <>
                RDP itself cannot report CPU, memory or disks, or open the file system. Windows has an OpenSSH server built in (it is part of
                Windows, not an agent). Turn it on once in an <b className="font-medium text-fg">administrator PowerShell</b>, then click{" "}
                <i>Check again</i>. emremote then uses your RDP sign-in automatically.
              </>
            ) : (
              <>Enable the SSH server on this computer (port 22), then click <i>Check again</i>, or add an SSH method if it uses another port or account.</>
            )}
          </p>
          {windows && state !== "auth_failed" && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2 font-mono text-xs">
              <span className="min-w-0 flex-1 break-all">{WINDOWS_ENABLE_SSH}</span>
              <CopyButton value={WINDOWS_ENABLE_SSH} label="Copy command" />
            </div>
          )}
          {state === "error" && <p className="mt-2 text-xs text-danger">{detail}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={detect} disabled={!canAuto}>
              Check again
            </Button>
            <Button size="sm" onClick={onAddSSH}>
              Add SSH method manually
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  if (view === "system") return explanation;
  return (
    <div className="space-y-4">
      {hasRDP && (
        <section className="card overflow-hidden">
          <header className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">RDP transfer drive</h3>
            <p className="text-xs text-subtle">
              Works without any setup. Inside an RDP session this folder appears in File Explorer as the drive <b className="font-medium text-muted">emremote</b>{" "}
              (This PC → Redirected drives). Copy files there in Windows to download them here, or upload here to open them in Windows.
            </p>
          </header>
          <FileBrowser base={`/api/devices/${device.id}/transfer`} />
        </section>
      )}
      {explanation}
    </div>
  );
}

function Inner({ view, conn, onVerifyHostKey }: { view: "system" | "files"; conn: Connection; onVerifyHostKey: () => void }) {
  const { state, open, expired } = useSSHAccess(conn.id);
  const gate = (content: (id: string, username: string) => JSX.Element) => (
    <SSHAccessGate state={state} onSubmitCredentials={open} onRetry={() => open()} onVerifyHostKey={onVerifyHostKey} defaultUsername={conn.username}>
      {content}
    </SSHAccessGate>
  );
  if (view === "system")
    return state.status === "ready" ? (
      <SystemPanel accessId={state.id} username={state.username} onExpired={expired} />
    ) : (
      <div className="card">{gate(() => <></>)}</div>
    );
  return <div className="card overflow-hidden">{gate((id) => <FileBrowser base={`/api/ssh-access/${id}/files`} onExpired={expired} />)}</div>;
}

export function DeviceActivity({ deviceId }: { deviceId: string }) {
  const q = useInfiniteQuery({
    queryKey: ["audit", "device", deviceId],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ device_id: deviceId, limit: "30" });
      if (pageParam) p.set("cursor", String(pageParam));
      return fetchAudit(p);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  if (q.isLoading) return <PageLoader />;
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <section className="card">
      <header className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold">Activity for this device</h2>
        <p className="text-xs text-subtle">Sessions, file transfers and configuration changes.</p>
      </header>
      {events.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-subtle">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border px-5">
          {events.map((e) => (
            <ActivityItem key={e.id} e={e} />
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="flex justify-center border-t border-border p-3">
          <Button size="sm" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      )}
    </section>
  );
}
