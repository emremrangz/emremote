import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field } from "./ui/Field";
import { Badge } from "./ui/misc";
import { useToast } from "./ui/Toast";
import { ApiError, errorMessage, get, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface Status {
  enabled: boolean;
  recovery_codes_left: number;
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const toast = useToast();
  const text = codes.join("\n");
  const save = () => {
    const url = URL.createObjectURL(new Blob([`emremote recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "emremote-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Keep these recovery codes somewhere safe. Each works once if you lose your phone. <b className="font-medium text-fg">They are shown only now.</b>
      </p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border bg-surface-2 p-3 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          size="sm"
          icon={<Copy className="h-3.5 w-3.5" />}
          onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Recovery codes copied"), () => toast.error("Could not copy"))}
        >
          Copy
        </Button>
        <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={save}>
          Download
        </Button>
      </div>
    </div>
  );
}

type Mode = null | "setup" | "disable" | "regenerate";

export function TwoFactorCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const status = useQuery({ queryKey: ["2fa"], queryFn: () => get<Status>("/api/auth/2fa") });
  const [mode, setMode] = useState<Mode>(null);
  const [step, setStep] = useState<"password" | "scan" | "codes">("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep("password");
    setPassword("");
    setCode("");
    setSecret("");
    setQr("");
    setCodes([]);
    setError("");
  };
  useEffect(reset, [mode]);

  const finish = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["2fa"] }), refresh()]);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError && e.fields.password ? e.fields.password : e instanceof ApiError && e.fields.code ? e.fields.code : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (mode === "setup" && step === "password") {
        const r = await post<{ secret: string; otpauth_uri: string }>("/api/auth/2fa/setup", { password });
        setSecret(r.secret);
        setQr(await QRCode.toDataURL(r.otpauth_uri, { margin: 1, width: 192, errorCorrectionLevel: "M" }));
        setStep("scan");
        setCode("");
      } else if (mode === "setup" && step === "scan") {
        const r = await post<{ recovery_codes: string[] }>("/api/auth/2fa/enable", { code });
        setCodes(r.recovery_codes);
        setStep("codes");
        await finish();
      } else if (mode === "disable") {
        await post("/api/auth/2fa/disable", { password, code });
        toast.success("Two-factor authentication is off");
        setMode(null);
        await finish();
      } else if (mode === "regenerate") {
        const r = await post<{ recovery_codes: string[] }>("/api/auth/2fa/recovery", { password, code });
        setCodes(r.recovery_codes);
        setStep("codes");
        await finish();
      }
    });
  };

  const enabled = status.data?.enabled;
  const title = mode === "setup" ? "Set up two-factor authentication" : mode === "disable" ? "Turn off two-factor authentication" : "New recovery codes";
  const showCodes = step === "codes";
  const needsPassword = (mode === "setup" && step === "password") || mode === "disable" || mode === "regenerate";
  const needsCode = (mode === "setup" && step === "scan") || mode === "disable" || mode === "regenerate";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-muted" />
            Authenticator app
            {status.data && (enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>)}
          </p>
          <p className="mt-1 text-xs text-subtle">
            {enabled
              ? `Signing in asks for a 6-digit code. ${status.data!.recovery_codes_left} recovery ${status.data!.recovery_codes_left === 1 ? "code" : "codes"} left.`
              : "Adds a 6-digit code from an app such as Google Authenticator, Aegis or 1Password to your password."}
          </p>
        </div>
        <div className="flex gap-2">
          {enabled ? (
            <>
              <Button onClick={() => setMode("regenerate")}>New recovery codes</Button>
              <Button variant="danger" onClick={() => setMode("disable")}>
                Turn off
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => setMode("setup")} disabled={!status.data}>
              Set up
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={mode !== null}
        onOpenChange={(o) => !o && setMode(null)}
        size="sm"
        title={title}
        footer={
          showCodes ? (
            <Button variant="primary" onClick={() => setMode(null)}>
              I saved the codes
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setMode(null)}>
                Cancel
              </Button>
              <Button variant={mode === "disable" ? "danger" : "primary"} type="submit" form="twofa-form" loading={busy}>
                {mode === "setup" && step === "password" ? "Continue" : mode === "setup" ? "Turn on" : mode === "disable" ? "Turn off" : "Create new codes"}
              </Button>
            </>
          )
        }
      >
        {showCodes ? (
          <RecoveryCodes codes={codes} />
        ) : (
          <form id="twofa-form" onSubmit={submit} noValidate className="space-y-4">
            {mode === "setup" && step === "scan" && (
              <div className="space-y-3">
                <p className="text-sm text-muted">Scan this code with your authenticator app, then enter the 6-digit code it shows.</p>
                <div className="flex justify-center rounded-lg bg-white p-2">{qr && <img src={qr} alt="QR code for your authenticator app" width={192} height={192} />}</div>
                <p className="text-xs text-subtle">
                  Cannot scan? Enter this key by hand: <span className="select-all break-all font-mono text-fg">{secret}</span>
                </p>
              </div>
            )}
            {needsPassword && (
              <Field label="Your password" hint={mode === "setup" ? "Confirms it is you." : undefined}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
              </Field>
            )}
            {needsCode && (
              <Field label={mode === "setup" ? "6-digit code" : "Code from your app, or a recovery code"}>
                <input className="input font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" spellCheck={false} autoFocus={mode === "setup"} />
              </Field>
            )}
            {error && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
          </form>
        )}
      </Dialog>
    </>
  );
}
