import { useState, type ReactNode } from "react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { errorMessage } from "@/lib/api";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel = "Delete",
  onConfirm,
  danger = true,
  requireText,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown>;
  danger?: boolean;
  requireText?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [typed, setTyped] = useState("");
  const blocked = !!requireText && typed.trim() !== requireText;
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      await onConfirm();
      onOpenChange(false);
      setTyped("");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setErr("");
          setTyped("");
        }
        onOpenChange(o);
      }}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={run} loading={busy} disabled={blocked}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">{children}</div>
      {requireText && (
        <div className="mt-4">
          <label className="label">
            Type <span className="font-mono text-fg">{requireText}</span> to confirm
          </label>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </div>
      )}
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
    </Dialog>
  );
}
