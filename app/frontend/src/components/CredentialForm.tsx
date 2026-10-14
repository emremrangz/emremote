import { useEffect, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { ApiError, errorMessage, post, put } from "@/lib/api";
import type { Credential, SecretInput } from "@/lib/types";
import { useInvalidateInventory } from "@/hooks/queries";

export function CredentialFormDialog({
  open,
  onOpenChange,
  credential,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  credential?: Credential;
}) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [replace, setReplace] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateInventory();

  useEffect(() => {
    if (!open) return;
    setName(credential?.name ?? "");
    setUsername(credential?.username ?? "");
    setDomain(credential?.domain ?? "");
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setReplace(!credential);
    setErrors({});
    setFormError("");
  }, [open, credential]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError("");
    const secret: SecretInput = replace ? { mode: "set", password, private_key: privateKey, passphrase } : { mode: "keep" };
    try {
      if (credential) await put(`/api/credentials/${credential.id}`, { name, username, domain, secret });
      else await post("/api/credentials", { name, username, domain, secret });
      await invalidate();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={credential ? `Edit ${credential.name}` : "New credential"}
      description="Reusable login details that several connections can reference. Encrypted at rest; never shown again after saving."
      footer={
        <>
          {formError && <p className="mr-auto text-sm text-danger">{formError}</p>}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="credential-form" loading={busy}>
            {credential ? "Save" : "Create credential"}
          </Button>
        </>
      }
    >
      <form noValidate id="credential-form" onSubmit={submit} className="space-y-4">
        <Field label="Name" error={errors.name}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Home admin" required autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" optional error={errors.username}>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field label="Domain" optional hint="RDP only" error={errors.domain}>
            <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        {credential && !replace ? (
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2/50 px-4 py-3 text-sm">
            <span className="flex items-center gap-2 text-muted">
              <KeyRound className="h-4 w-4 text-success" />
              {credential.secret_fields.length ? `Stored: ${credential.secret_fields.join(", ").replace("_", " ")}` : "No secret stored"}
            </span>
            <Button size="sm" onClick={() => setReplace(true)}>
              Replace secret
            </Button>
          </div>
        ) : (
          <>
            <Field label="Password" optional error={errors["secret.password"]}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </Field>
            <Field label="SSH private key" optional hint="Only used by SSH connections." error={errors["secret.private_key"]}>
              <textarea className="input min-h-[80px] font-mono text-2xs" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
            </Field>
            <Field label="Key passphrase" optional error={errors["secret.passphrase"]}>
              <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  );
}
