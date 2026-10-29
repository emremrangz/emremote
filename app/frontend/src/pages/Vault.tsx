import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Eye,
  FileKey2,
  Folder,
  HeartPulse,
  History,
  Inbox,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  StickyNote,
  Trash2,
  Unlock,
  Users,
  X,
} from "lucide-react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { PageHeader, EmptyState, ErrorState, Badge, CopyButton, copyText } from "@/components/ui/misc";
import { PageLoader } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { MenuContent, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CredentialFormDialog } from "@/components/CredentialForm";
import { useToast } from "@/components/ui/Toast";
import { ApiError, del, errorMessage, get, post, put } from "@/lib/api";
import { useAccess } from "@/lib/auth";
import { keys, useInvalidateInventory, useTeams, useUsers, useVault, useVaultRequests } from "@/hooks/queries";
import { durationLabel, fieldLabels, kindLabels, strengthLabels, timeLeft } from "@/lib/vault";
import { dateTime as formatDateTime, relativeTime as formatRelative } from "@/lib/format";
import type { VaultEntry, VaultEntryDetail, VaultGrant, VaultHealth, VaultKind, VaultRequest, VaultReveal } from "@/lib/types";

type Tab = "entries" | "requests" | "health";

const kindIcons: Record<VaultKind, typeof KeyRound> = { login: KeyRound, ssh_key: FileKey2, api_token: KeyRound, note: StickyNote };

/** Re-renders every few seconds so countdowns move. */
function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

function TabButton({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
        active ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
      )}
    >
      {children}
      {!!count && (
        <span className="rounded-full bg-warning/15 px-1.5 text-2xs font-semibold text-warning" aria-label={`${count} waiting`}>
          {count}
        </span>
      )}
    </button>
  );
}

function StrengthMeter({ value }: { value: number | null }) {
  if (value === null) return null;
  const tone = value <= 1 ? "bg-danger" : value === 2 ? "bg-warning" : "bg-success";
  return (
    <span className="inline-flex items-center gap-1" title={`Password strength: ${strengthLabels[value]}`}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={clsx("h-1.5 w-2.5 rounded-sm", i < value ? tone : "bg-surface-3")} />
      ))}
    </span>
  );
}

function PolicyBadges({ e, now }: { e: VaultEntry; now: number }) {
  const { user } = useAccess();
  const mine = e.checkout?.user_id === user?.id;
  return (
    <>
      {e.owner_id !== null && <Badge>Private</Badge>}
      {e.reveal_policy === "never" && (
        <Badge title="The secret is never shown; it is only used to connect">
          <Lock className="h-3 w-3" /> Connect only
        </Badge>
      )}
      {e.access_policy === "exclusive" && <Badge tone="accent">Check-out</Badge>}
      {e.access_policy === "approval" && <Badge tone="accent">Approval</Badge>}
      {e.checkout && (
        <Badge tone={e.checkout.break_glass ? "danger" : mine ? "success" : "warning"} title={`Reason: ${e.checkout.reason}`}>
          {e.checkout.break_glass && <ShieldAlert className="h-3 w-3" />}
          {mine ? "Checked out by you" : `Checked out by ${e.checkout.username}`} · {timeLeft(e.checkout.expires_at, now)}
        </Badge>
      )}
      {e.my_request?.status === "pending" && <Badge tone="warning">Request waiting</Badge>}
      {e.my_request?.status === "approved" && <Badge tone="success">Approved</Badge>}
      {e.rotation_status === "failed" && (
        <Badge tone="danger" title={e.rotation_error}>
          Rotation failed
        </Badge>
      )}
      {e.pending_requests > 0 && <Badge tone="warning">{e.pending_requests} request(s)</Badge>}
    </>
  );
}

// ---- Reveal ----

function RevealDialog({ entry, onClose, versionId }: { entry: VaultEntry | null; onClose: () => void; versionId?: string }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<VaultReveal | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(30);
  const needsReason = entry?.owner_id === null;
  useEffect(() => {
    if (!entry) {
      setReason("");
      setResult(null);
      setError("");
    }
  }, [entry]);
  // Hide the values again after 30 seconds.
  useEffect(() => {
    if (!result) return;
    setLeft(30);
    const t = window.setInterval(() => setLeft((n) => n - 1), 1000);
    return () => window.clearInterval(t);
  }, [result]);
  useEffect(() => {
    if (result && left <= 0) onClose();
  }, [left, result, onClose]);
  const reveal = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await post<VaultReveal>(`/api/vault/${entry!.id}/reveal`, { reason, purpose: "show", version_id: versionId ?? "" }));
    } catch (e) {
      setError(e instanceof ApiError && e.fields.reason ? e.fields.reason : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!entry}
      onOpenChange={(o) => !o && onClose()}
      title={versionId ? `Old value of ${entry?.name ?? ""}` : `Show ${entry?.name ?? ""}`}
      description={result ? `Hidden again in ${left} s. This was written to the activity log.` : "Showing a secret is written to the activity log, with your reason."}
      footer={
        result ? (
          <Button onClick={onClose}>Hide now</Button>
        ) : (
          <>
            {error && <p className="mr-auto text-sm text-danger">{error}</p>}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={reveal} loading={busy} disabled={needsReason && reason.trim().length < 4} icon={<Eye className="h-3.5 w-3.5" />}>
              Show
            </Button>
          </>
        )
      }
    >
      {!result ? (
        <Field label="Reason" optional={!needsReason}>
          <input
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. INC-1042 switch maintenance"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && (!needsReason || reason.trim().length >= 4) && reveal()}
          />
        </Field>
      ) : (
        <div className="space-y-3">
          {entry?.username && <SecretRow label="Username" value={entry.username} plain />}
          {Object.entries(result.fields).map(([k, v]) => (
            <SecretRow key={k} label={fieldLabels[k] ?? k} value={v!} multiline={k === "private_key" || k === "note" || k === "token"} />
          ))}
          {result.totp_code && (
            <div>
              <p className="label">One-time code</p>
              <div className="flex items-center gap-3">
                <span className="font-mono text-2xl tracking-[0.3em]">{result.totp_code}</span>
                <CopyButton value={result.totp_code} label="Copy the code" />
                <span className="text-xs text-subtle">valid for about {result.totp_seconds_left} s</span>
              </div>
            </div>
          )}
          {Object.keys(result.fields).length === 0 && !result.totp_code && <p className="text-sm text-muted">Nothing is stored.</p>}
        </div>
      )}
    </Dialog>
  );
}

function SecretRow({ label, value, multiline, plain }: { label: string; value: string; multiline?: boolean; plain?: boolean }) {
  return (
    <div>
      <p className="label">{label}</p>
      <div className="flex items-start gap-2">
        {multiline ? (
          <pre className="max-h-48 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs">{value}</pre>
        ) : (
          <code className={clsx("flex-1 break-all rounded-md border border-border bg-surface-2 px-3 py-2 text-sm", !plain && "font-mono")}>{value}</code>
        )}
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} className="mt-1.5" />
      </div>
    </div>
  );
}

// ---- Quick copy ----

/** The secret a row's copy button copies, by kind (SSH keys and notes are shown, not copied from the list). */
const quickField: Partial<Record<VaultKind, "password" | "token">> = { login: "password", api_token: "token" };

/** Where an entry is used: the addresses of its connections' devices, else the host of its web address. */
function entryAddresses(e: VaultEntry): string[] {
  if (e.addresses?.length) return e.addresses;
  try {
    return e.url ? [new URL(e.url).hostname] : [];
  } catch {
    return [];
  }
}

function QuickCopy({ label, title, onCopy, className }: { label: ReactNode; title: string; onCopy: () => Promise<boolean>; className?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const run = async () => {
    setState("busy");
    const ok = await onCopy().catch(() => false);
    setState(ok ? "done" : "idle");
    if (ok) window.setTimeout(() => setState("idle"), 1200);
  };
  return (
    <button
      type="button"
      onClick={run}
      disabled={state === "busy"}
      title={title}
      aria-label={title}
      className={clsx(
        "inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-xs text-muted transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-60",
        className,
      )}
    >
      {state === "done" ? <Check className="h-3 w-3 shrink-0 text-success" /> : <Copy className="h-3 w-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  );
}

function CopyReasonDialog({
  entry,
  initialReason,
  onCopy,
  onClose,
}: {
  entry: VaultEntry | null;
  initialReason: string;
  onCopy: (e: VaultEntry, reason: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (entry) {
      setReason(initialReason);
      setError("");
    }
  }, [entry, initialReason]);
  const ok = reason.trim().length >= 4;
  const what = fieldLabels[quickField[entry?.kind ?? "login"] ?? "password"]?.toLowerCase();
  const run = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError("");
    try {
      if (await onCopy(entry!, reason.trim())) onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.fields.reason ? e.fields.reason : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!entry}
      onOpenChange={(o) => !o && onClose()}
      title={`Copy the ${what} of ${entry?.name ?? ""}`}
      description="Copying a secret is written to the activity log, with your reason."
      footer={
        <>
          {error && <p className="mr-auto text-sm text-danger">{error}</p>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} loading={busy} disabled={!ok} icon={<Copy className="h-3.5 w-3.5" />}>
            Copy
          </Button>
        </>
      }
    >
      <Field label="Reason">
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder="e.g. INC-1042 switch maintenance"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
      </Field>
    </Dialog>
  );
}

// ---- Check-out and requests ----

function CheckoutDialog({ entry, mode, onClose }: { entry: VaultEntry | null; mode: "checkout" | "request" | "breakglass"; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateInventory();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const usesApproval = mode === "checkout" && entry?.my_request?.status === "approved";
  useEffect(() => {
    if (entry) {
      setReason("");
      setMinutes(Math.min(60, entry.max_checkout_minutes));
      setError("");
    }
  }, [entry]);
  const choices = useMemo(() => [5, 15, 30, 60, 120, 240, 480, 1440].filter((m) => m <= (entry?.max_checkout_minutes ?? 60)), [entry]);
  const minReason = mode === "breakglass" ? 10 : usesApproval ? 0 : 4;
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (mode === "request") {
        await post(`/api/vault/${entry!.id}/requests`, { reason, minutes });
        toast.success("Request sent. An administrator has to approve it.");
      } else {
        await post(`/api/vault/${entry!.id}/checkout`, { reason, minutes: usesApproval ? 0 : minutes, break_glass: mode === "breakglass" });
        toast.success(`${entry!.name} is checked out to you.`);
      }
      await invalidate();
      qc.invalidateQueries({ queryKey: keys.vaultRequests });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && (e.fields.reason || e.fields.minutes) ? e.fields.reason || e.fields.minutes : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const title = { checkout: "Check out", request: "Request access to", breakglass: "Break-glass access to" }[mode];
  return (
    <Dialog
      open={!!entry}
      onOpenChange={(o) => !o && onClose()}
      title={`${title} ${entry?.name ?? ""}`}
      description={
        mode === "breakglass"
          ? "Emergency access without approval. Administrators see it flagged in the activity log; use it only when nobody can approve in time."
          : mode === "request"
            ? "An administrator approves or rejects the request. Once approved you can check the entry out."
            : "Only you can use the entry until you check it in or the time runs out. Your remote sessions that use it end at check-in."
      }
      footer={
        <>
          {error && <p className="mr-auto text-sm text-danger">{error}</p>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={mode === "breakglass" ? "danger" : "primary"} onClick={submit} loading={busy} disabled={reason.trim().length < minReason}>
            {mode === "request" ? "Send request" : "Check out"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {usesApproval && entry?.my_request && (
          <p className="rounded-md border border-success/25 bg-success/10 px-3 py-2 text-sm">
            Approved by {entry.my_request.decided_by_name} for {durationLabel(entry.my_request.minutes)}.
            {entry.my_request.decision_note && ` "${entry.my_request.decision_note}"`}
          </p>
        )}
        <Field label="Reason" optional={usesApproval} hint={mode === "breakglass" ? "At least 10 characters: what is broken and why it cannot wait." : undefined}>
          <input
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={mode === "breakglass" ? "e.g. Core switch down, on-call admin not reachable" : "e.g. INC-1042 firmware update"}
            autoFocus
          />
        </Field>
        {!usesApproval && (
          <Field label="For how long">
            <Select className="input" value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
              {choices.map((m) => (
                <option key={m} value={m}>
                  {durationLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

// ---- Details: history, check-outs, sharing, rotation ----

function DetailsDialog({ entryId, onClose, onRevealVersion }: { entryId: string | null; onClose: () => void; onRevealVersion: (e: VaultEntry, vid: string) => void }) {
  const { isAdmin } = useAccess();
  const toast = useToast();
  const invalidate = useInvalidateInventory();
  const detail = useQuery({
    queryKey: ["vault", entryId, "detail"],
    queryFn: () => get<VaultEntryDetail>(`/api/vault/${entryId}`),
    enabled: !!entryId,
  });
  const [rotating, setRotating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const e = detail.data?.entry;
  const rotate = async () => {
    setRotating(true);
    try {
      const r = await post<{ status: string }>(`/api/vault/${e!.id}/rotate`);
      toast.success(r.status === "ok" ? "Password changed and confirmed." : "Password changed; signing in with it could not be confirmed.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRotating(false);
      await detail.refetch();
      await invalidate();
    }
  };
  return (
    <Dialog open={!!entryId} onOpenChange={(o) => !o && onClose()} size="lg" title={e ? e.name : "Vault entry"} description={e?.description || undefined}>
      {detail.isLoading || !e ? (
        <PageLoader />
      ) : (
        <div className="space-y-6">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Info label="Kind">{kindLabels[e.kind]}</Info>
            {e.username && <Info label="Username">{e.domain ? `${e.domain}\\${e.username}` : e.username}</Info>}
            {e.folder && <Info label="Folder">{e.folder}</Info>}
            {e.url && (
              <Info label="Web address">
                <a href={e.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                  {e.url}
                </a>
              </Info>
            )}
            <Info label="Stored">{e.secret_fields.length ? e.secret_fields.map((f) => fieldLabels[f] ?? f).join(", ") : "nothing"}</Info>
            <Info label="Last changed">{e.secret_changed_at ? formatRelative(e.secret_changed_at) : "unknown"}</Info>
            <Info label="Used by">{e.usage_count} connection(s)</Info>
            {e.password_strength !== null && <Info label="Strength">{strengthLabels[e.password_strength]}</Info>}
          </dl>

          {e.access === "manage" && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <RefreshCw className="h-4 w-4" /> Password changes
              </h3>
              {detail.data?.rotation_connection ? (
                <div className="space-y-2 text-sm">
                  <p className="text-muted">
                    Changed over <span className="text-fg">{detail.data.rotation_connection.name}</span>
                    {e.rotation_interval_days ? `, every ${e.rotation_interval_days} days` : ", on request"}
                    {e.rotate_after_checkin && " and after every check-in"}.
                  </p>
                  {e.rotated_at && (
                    <p className="text-xs text-subtle">
                      Last change {formatRelative(e.rotated_at)}
                      {e.rotation_status === "unverified" && " (signing in with the new password could not be confirmed)"}
                    </p>
                  )}
                  {e.rotation_status === "failed" && <p className="text-xs text-danger">Last attempt failed: {e.rotation_error}</p>}
                  <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={rotating} onClick={rotate} disabled={!!e.checkout}>
                    Change password now
                  </Button>
                  {e.checkout && <p className="text-xs text-subtle">Not while the entry is checked out.</p>}
                </div>
              ) : (
                <p className="text-sm text-muted">Not set up. Edit the entry and choose the SSH connection to change the password over.</p>
              )}
            </section>
          )}

          {e.access === "manage" && e.owner_id === null && isAdmin && <SharingEditor entry={e} onSaved={() => detail.refetch()} />}

          {detail.data?.versions && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <History className="h-4 w-4" /> History
              </h3>
              {detail.data.versions.length === 0 ? (
                <p className="text-sm text-muted">No earlier values yet. The history starts with the next change.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {detail.data.versions.map((v, i) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        {formatDateTime(v.created_at)}{" "}
                        <span className="text-subtle">
                          · {v.source === "attempt" ? "rotation attempt (outcome unknown)" : v.source} {v.actor_name && `by ${v.actor_name}`}
                        </span>
                      </span>
                      {i === 0 && v.source !== "attempt" && <Badge tone="success">Current</Badge>}
                      {e.reveal_policy === "allowed" && (
                        <Button size="sm" variant="ghost" onClick={() => onRevealVersion(e, v.id)}>
                          Show
                        </Button>
                      )}
                      {(i > 0 || v.source === "attempt") && (
                        <Button size="sm" variant="ghost" onClick={() => setRestoring(v.id)}>
                          Make current
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {detail.data?.checkouts && detail.data.checkouts.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <Clock className="h-4 w-4" /> Check-outs
              </h3>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {detail.data.checkouts.map((k) => (
                  <li key={k.id} className="px-3 py-2 text-sm">
                    <span className="font-medium">{k.username}</span> <span className="text-subtle">{formatDateTime(k.started_at)}</span>
                    {k.break_glass && (
                      <Badge tone="danger" className="ml-2">
                        Break-glass
                      </Badge>
                    )}
                    <p className="text-xs text-muted">
                      {k.reason} ·{" "}
                      {k.checked_in_at
                        ? `checked in ${formatRelative(k.checked_in_at)}${k.checked_in_by === "expired" ? " (time ran out)" : k.checked_in_by !== k.username ? ` by ${k.checked_in_by}` : ""}`
                        : `until ${formatDateTime(k.expires_at)}`}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(o) => !o && setRestoring(null)}
        title="Make this value current?"
        confirmLabel="Make current"
        danger={false}
        onConfirm={async () => {
          await post(`/api/vault/${e!.id}/versions/${restoring}/restore`);
          await detail.refetch();
          await invalidate();
        }}
      >
        <p>Connections that use this entry sign in with the older value from now on. The target computer is not changed.</p>
      </ConfirmDialog>
    </Dialog>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

function SharingEditor({ entry, onSaved }: { entry: VaultEntry; onSaved: () => void }) {
  const users = useUsers();
  const teams = useTeams();
  const toast = useToast();
  const [grants, setGrants] = useState<VaultGrant[]>(entry.grants ?? []);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setGrants(entry.grants ?? []), [entry]);
  const members = (users.data ?? []).filter((u) => u.role !== "admin");
  const taken = new Set(grants.map((g) => g.user_id ?? g.team_id));
  const add = () => {
    if (!pick) return;
    const [kind, id] = pick.split(":");
    const name = kind === "u" ? members.find((u) => u.id === id)?.username : teams.data?.find((t) => t.id === id)?.name;
    setGrants([...grants, { user_id: kind === "u" ? id : null, team_id: kind === "t" ? id : null, name: name ?? "", level: "use" }]);
    setPick("");
  };
  const save = async () => {
    setBusy(true);
    try {
      await put(`/api/vault/${entry.id}/grants`, { grants: grants.map(({ user_id, team_id, level }) => ({ user_id, team_id, level, name: "" })) });
      toast.success("Sharing saved.");
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Users className="h-4 w-4" /> Shared with
      </h3>
      <p className="mb-3 text-xs text-subtle">
        Administrators always have full access. "Use" lets people check the entry out and connect with it without seeing the secret; "Use and show" also
        shows and copies it.
      </p>
      {grants.length > 0 && (
        <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
          {grants.map((g, i) => (
            <li key={(g.user_id ?? g.team_id)!} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {g.team_id ? "Team " : ""}
                {g.name}
              </span>
              <Select
                className="input h-8 w-40"
                value={g.level}
                aria-label={`Access for ${g.name}`}
                onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, level: e.target.value as VaultGrant["level"] } : x)))}
              >
                <option value="use">Use</option>
                <option value="reveal">Use and show</option>
              </Select>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${g.name}`} onClick={() => setGrants(grants.filter((_, j) => j !== i))}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Select className="input h-8 min-w-[200px] flex-1" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a person or team">
          <option value="">Add a person or team…</option>
          {(teams.data ?? [])
            .filter((t) => !taken.has(t.id))
            .map((t) => (
              <option key={t.id} value={`t:${t.id}`}>
                Team {t.name}
              </option>
            ))}
          {members
            .filter((u) => !taken.has(u.id))
            .map((u) => (
              <option key={u.id} value={`u:${u.id}`}>
                {u.username}
              </option>
            ))}
        </Select>
        <Button size="sm" onClick={add} disabled={!pick}>
          Add
        </Button>
        <Button size="sm" variant="primary" onClick={save} loading={busy}>
          Save sharing
        </Button>
      </div>
    </section>
  );
}

// ---- Entries ----

function EntriesTab({ onEdit }: { onEdit: (e: VaultEntry) => void }) {
  const { user, can } = useAccess();
  const { data, isLoading, error, refetch } = useVault();
  const toast = useToast();
  const invalidate = useInvalidateInventory();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const folder = params.get("folder") ?? "";
  const [reveal, setReveal] = useState<{ entry: VaultEntry; versionId?: string } | null>(null);
  const [checkout, setCheckout] = useState<{ entry: VaultEntry; mode: "checkout" | "request" | "breakglass" } | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<VaultEntry | null>(null);
  const [copyAsk, setCopyAsk] = useState<VaultEntry | null>(null);
  // The last reason given for a copy is offered again (this page only), so a series of copies is quick.
  const [lastReason, setLastReason] = useState("");

  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of data ?? []) if (e.folder) counts.set(e.folder, (counts.get(e.folder) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter(
      (e) =>
        (!folder || e.folder === folder || e.folder.startsWith(folder + "/")) &&
        (!s || [e.name, e.username, e.folder, e.url, e.description, ...e.tags].some((x) => x.toLowerCase().includes(s))),
    );
  }, [data, q, folder]);

  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  const checkin = async (e: VaultEntry) => {
    try {
      await post(`/api/vault/${e.id}/checkin`);
      toast.success(`${e.name} is checked in.`);
      await invalidate();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const copied = async (value: string, what: string) => {
    await copyText(value);
    toast.success(`${what} copied.`);
    return true;
  };
  const copySecret = async (e: VaultEntry, reason: string) => {
    const field = quickField[e.kind]!;
    const r = await post<VaultReveal>(`/api/vault/${e.id}/reveal`, { reason, field, purpose: "copy" });
    const value = r.fields[field];
    if (!value) {
      toast.error(`No ${fieldLabels[field].toLowerCase()} is stored in ${e.name}.`);
      return false;
    }
    if (reason) setLastReason(reason);
    return copied(value, `${fieldLabels[field]} of ${e.name}`);
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <input className="input pl-8" placeholder="Search name, username, tag…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the vault" />
        </div>
        {folders.length > 0 && (
          <Select className="input w-56" value={folder} onChange={(e) => setParams(e.target.value ? { folder: e.target.value } : {}, { replace: true })} aria-label="Folder">
            <option value="">All folders</option>
            {folders.map(([f, n]) => (
              <option key={f} value={f}>
                {f} ({n})
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="card overflow-hidden">
        {list.length === 0 ? (
          <EmptyState icon={<KeyRound className="h-5 w-5" />} title={data!.length ? "Nothing matches" : "The vault is empty"}>
            {data!.length
              ? "Try another search or folder."
              : "Store sign-ins, SSH keys, API tokens and secure notes. Connections can use an entry to sign in without anyone seeing the password."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((e) => {
              const Icon = kindIcons[e.kind];
              const mine = e.checkout?.user_id === user?.id;
              const gated = e.access_policy !== "open";
              const needsApproval = e.access_policy === "approval" && e.access !== "manage";
              const canReveal = (e.access === "reveal" || e.access === "manage") && e.reveal_policy === "allowed" && (!gated || mine);
              const field = quickField[e.kind];
              const addresses = entryAddresses(e);
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                    <Icon className="h-4 w-4" />
                  </span>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setDetails(e.id)}>
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {e.name} <StrengthMeter value={e.password_strength} />
                    </p>
                    <p className="truncate text-xs text-subtle">
                      {[e.username && (e.domain ? `${e.domain}\\${e.username}` : e.username), e.folder && <span key="f"><Folder className="mb-0.5 mr-0.5 inline h-3 w-3" />{e.folder}</span>, kindLabels[e.kind]]
                        .filter(Boolean)
                        .reduce<ReactNode[]>((acc, x, i) => (i ? [...acc, " · ", x] : [x]), [])}
                      {e.tags.length > 0 && ` · ${e.tags.join(", ")}`}
                    </p>
                  </button>
                  <div className="flex flex-wrap items-center gap-1">
                    {e.username && <QuickCopy label="User" title={`Copy the username of ${e.name}`} onCopy={() => copied(e.username, `Username of ${e.name}`)} />}
                    {field && canReveal && e.secret_fields.includes(field) && (
                      <QuickCopy
                        label={fieldLabels[field]}
                        title={`Copy the ${fieldLabels[field].toLowerCase()} of ${e.name}`}
                        onCopy={async () => {
                          // Shared entries ask for a reason first; private ones copy at once.
                          if (e.owner_id === null) {
                            setCopyAsk(e);
                            return false;
                          }
                          return copySecret(e, "").catch((err) => {
                            toast.error(errorMessage(err));
                            return false;
                          });
                        }}
                      />
                    )}
                    {addresses.slice(0, 2).map((a) => (
                      <QuickCopy key={a} label={a} title={`Copy ${a}`} className="font-mono" onCopy={() => copied(a, a)} />
                    ))}
                    {addresses.length > 2 && (
                      <span className="text-2xs text-subtle" title={addresses.slice(2).join(", ")}>
                        +{addresses.length - 2}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PolicyBadges e={e} now={now} />
                  </div>
                  <div className="flex items-center gap-1">
                    {gated && !e.checkout && needsApproval && e.my_request?.status !== "approved" && e.my_request?.status !== "pending" && (
                      <Button size="sm" icon={<Inbox className="h-3.5 w-3.5" />} onClick={() => setCheckout({ entry: e, mode: "request" })}>
                        Request
                      </Button>
                    )}
                    {gated && !e.checkout && (!needsApproval || e.my_request?.status === "approved") && (
                      <Button size="sm" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => setCheckout({ entry: e, mode: "checkout" })}>
                        Check out
                      </Button>
                    )}
                    {gated && e.checkout && (mine || e.access === "manage") && (
                      <Button size="sm" icon={<LogIn className="h-3.5 w-3.5" />} onClick={() => checkin(e)}>
                        {mine ? "Check in" : "Force check-in"}
                      </Button>
                    )}
                    {canReveal && (
                      <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => setReveal({ entry: e })}>
                        Show
                      </Button>
                    )}
                    <DM.Root>
                      <DM.Trigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={`More for ${e.name}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DM.Trigger>
                      <MenuContent>
                        <MenuItem icon={<History className="h-3.5 w-3.5" />} onSelect={() => setDetails(e.id)}>
                          Details and history
                        </MenuItem>
                        {needsApproval && e.my_request && (
                          <MenuItem
                            icon={<X className="h-3.5 w-3.5" />}
                            onSelect={async () => {
                              await del(`/api/vault/requests/${e.my_request!.id}`).catch((err) => toast.error(errorMessage(err)));
                              await invalidate();
                            }}
                          >
                            Withdraw my request
                          </MenuItem>
                        )}
                        {needsApproval && e.break_glass && !e.checkout && (
                          <MenuItem icon={<ShieldAlert className="h-3.5 w-3.5" />} onSelect={() => setCheckout({ entry: e, mode: "breakglass" })}>
                            Break-glass access
                          </MenuItem>
                        )}
                        {e.access === "manage" && (e.owner_id === null || can("credentials.manage")) && (
                          <>
                            <MenuSeparator />
                            <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onSelect={() => onEdit(e)}>
                              Edit
                            </MenuItem>
                            <MenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onSelect={() => setDeleting(e)}>
                              Delete
                            </MenuItem>
                          </>
                        )}
                      </MenuContent>
                    </DM.Root>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <RevealDialog entry={reveal?.entry ?? null} versionId={reveal?.versionId} onClose={() => setReveal(null)} />
      <CopyReasonDialog entry={copyAsk} initialReason={lastReason} onCopy={copySecret} onClose={() => setCopyAsk(null)} />
      <CheckoutDialog entry={checkout?.entry ?? null} mode={checkout?.mode ?? "checkout"} onClose={() => setCheckout(null)} />
      <DetailsDialog entryId={details} onClose={() => setDetails(null)} onRevealVersion={(entry, versionId) => setReveal({ entry, versionId })} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        requireText={deleting?.name}
        onConfirm={async () => {
          await del(`/api/credentials/${deleting!.id}`);
          await invalidate();
        }}
      >
        <p>
          The secret and its whole history are deleted.{" "}
          {deleting?.usage_count ? `${deleting.usage_count} connection(s) use this entry; they will ask for a password when connecting.` : "No connections use it."}
        </p>
      </ConfirmDialog>
    </>
  );
}

// ---- Requests ----

function RequestsTab() {
  const { isAdmin, user } = useAccess();
  const { data, isLoading, error, refetch } = useVaultRequests();
  const invalidate = useInvalidateInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const decide = async (r: VaultRequest, approve: boolean) => {
    try {
      await post(`/api/vault/requests/${r.id}/${approve ? "approve" : "reject"}`, { note: notes[r.id] ?? "" });
      toast.success(approve ? `Approved for ${r.username}.` : "Rejected.");
      qc.invalidateQueries({ queryKey: keys.vaultRequests });
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const tone = { pending: "warning", approved: "success", used: "neutral", rejected: "danger", cancelled: "neutral", expired: "neutral" } as const;
  return (
    <div className="card overflow-hidden">
      {data!.length === 0 ? (
        <EmptyState icon={<Inbox className="h-5 w-5" />} title="No requests">
          {isAdmin ? "Requests for entries that need approval show up here." : "When an entry needs approval, request it from the Entries tab."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {data!.map((r) => (
            <li key={r.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{r.credential_name}</span>
                <span className="text-subtle">
                  {r.user_id === user?.id ? "you" : r.username} · {durationLabel(r.minutes)} · {formatRelative(r.created_at)}
                </span>
                <Badge tone={tone[r.status]}>{r.status}</Badge>
              </div>
              <p className="text-sm text-muted">"{r.reason}"</p>
              {r.decided_by_name && (
                <p className="text-xs text-subtle">
                  {r.status === "rejected" ? "Rejected" : "Approved"} by {r.decided_by_name}
                  {r.decision_note && `: "${r.decision_note}"`}
                  {r.status === "approved" && r.valid_until && ` · check out before ${formatDateTime(r.valid_until)}`}
                </p>
              )}
              {isAdmin && r.status === "pending" && r.user_id !== user?.id && (
                <div className="flex flex-wrap gap-2">
                  <input
                    className="input h-8 min-w-[200px] flex-1"
                    placeholder="Note to the requester (optional)"
                    value={notes[r.id] ?? ""}
                    onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                    aria-label="Note"
                  />
                  <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} onClick={() => decide(r, true)}>
                    Approve
                  </Button>
                  <Button size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide(r, false)}>
                    Reject
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Health ----

function HealthTab() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["vault", "health"], queryFn: () => get<VaultHealth>("/api/vault/health") });
  const vault = useVault();
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const h = data!;
  const name = (id: string) => vault.data?.find((e) => e.id === id)?.name ?? id;
  const groups: { title: string; hint: string; ids: string[]; tone: "danger" | "warning" }[] = [
    { title: "Weak passwords", hint: "Short or predictable. Generate a new one.", ids: h.weak, tone: "danger" },
    { title: "Rotation failed", hint: "The last automatic change did not work; see the entry's details.", ids: h.rotation_failed, tone: "danger" },
    { title: "Overdue", hint: "Older than the change interval set on the entry.", ids: h.overdue, tone: "warning" },
    { title: "Not changed for a year", hint: "No interval is set and the secret is over a year old.", ids: h.old, tone: "warning" },
    { title: "Nothing stored", hint: "The entry has no secret.", ids: h.no_secret, tone: "warning" },
  ];
  const scoreTone = h.score >= 80 ? "text-success" : h.score >= 50 ? "text-warning" : "text-danger";
  return (
    <div className="grid gap-4">
      <div className="card flex items-center gap-6 p-5">
        <div className={clsx("text-4xl font-semibold tabular-nums", scoreTone)}>{h.score}</div>
        <div>
          <p className="text-sm font-medium">Vault health score</p>
          <p className="text-sm text-muted">
            {h.total} entr{h.total === 1 ? "y" : "ies"} you manage. Passwords are compared on the server, in memory only.
          </p>
        </div>
      </div>
      {h.reused.length > 0 && (
        <div className="card p-5">
          <p className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-danger" /> Reused passwords
          </p>
          <p className="mb-3 text-xs text-subtle">These entries share the same password. One leak opens all of them.</p>
          <ul className="space-y-1 text-sm">
            {h.reused.map((ids) => (
              <li key={ids.join()}>{ids.map(name).join(", ")}</li>
            ))}
          </ul>
        </div>
      )}
      {groups
        .filter((g) => g.ids.length)
        .map((g) => (
          <div key={g.title} className="card p-5">
            <p className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className={clsx("h-4 w-4", g.tone === "danger" ? "text-danger" : "text-warning")} /> {g.title}
            </p>
            <p className="mb-3 text-xs text-subtle">{g.hint}</p>
            <p className="text-sm">{g.ids.map(name).join(", ")}</p>
          </div>
        ))}
      {h.total > 0 && h.reused.length === 0 && groups.every((g) => !g.ids.length) && (
        <div className="card flex items-center gap-3 p-5 text-sm">
          <Unlock className="h-4 w-4 text-success" /> No problems found.
        </div>
      )}
    </div>
  );
}

// ---- Page ----

export default function VaultPage() {
  const { isAdmin, can } = useAccess();
  const vault = useVault();
  const requests = useVaultRequests();
  const [params, setParams] = useSearchParams();
  const tab = (["entries", "requests", "health"].includes(params.get("tab") ?? "") ? params.get("tab") : "entries") as Tab;
  const [form, setForm] = useState<{ open: boolean; entry?: VaultEntry }>({ open: false });
  const pending = (requests.data ?? []).filter((r) => r.status === "pending").length;
  const manages = (vault.data ?? []).some((e) => e.access === "manage");
  const canCreate = isAdmin || can("credentials.manage");
  const go = (t: Tab) => setParams(t === "entries" ? {} : { tab: t }, { replace: true });
  return (
    <>
      <PageHeader
        title="Vault"
        description="Privileged sign-ins, keys, tokens and notes. Every view, copy, check-out and change is in the activity log."
        actions={
          canCreate && (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>
              New entry
            </Button>
          )
        }
      />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Vault sections">
        <TabButton active={tab === "entries"} onClick={() => go("entries")}>
          <KeyRound className="h-3.5 w-3.5" /> Entries
        </TabButton>
        <TabButton active={tab === "requests"} onClick={() => go("requests")} count={isAdmin ? pending : undefined}>
          <Inbox className="h-3.5 w-3.5" /> Requests
        </TabButton>
        {manages && (
          <TabButton active={tab === "health"} onClick={() => go("health")}>
            <HeartPulse className="h-3.5 w-3.5" /> Health
          </TabButton>
        )}
      </div>
      <div role="tabpanel">
        {tab === "entries" && <EntriesTab onEdit={(entry) => setForm({ open: true, entry })} />}
        {tab === "requests" && <RequestsTab />}
        {tab === "health" && <HealthTab />}
      </div>
      <CredentialFormDialog open={form.open} onOpenChange={(o) => setForm((s) => ({ ...s, open: o }))} credential={form.entry} />
    </>
  );
}
