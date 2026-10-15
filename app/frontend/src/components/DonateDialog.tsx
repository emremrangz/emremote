import { ExternalLink, Heart } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/misc";

const IBAN = "TR80 0006 4000 0016 3120 7544 92";

const rows: { label: string; value: string; copy?: boolean }[] = [
  { label: "Bank transfer (IBAN)", value: IBAN, copy: true },
  { label: "Recipient", value: "Yunus Emre Marangoz", copy: true },
  { label: "Reference", value: "emremote Açık Kaynak Bağış", copy: true },
];

/** Support details for the project (the maintainer's), with a switch to hide the button. */
export function DonateDialog({ open, onOpenChange, onHide }: { open: boolean; onOpenChange: (o: boolean) => void; onHide: () => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Support emremote"
      description="emremote is free and open source. If it is useful to you, you can help its development."
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={onHide}>
            Hide this button
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <dt className="text-xs text-subtle">{r.label}</dt>
                <dd className="mt-0.5 select-all break-words font-mono text-[13px]">{r.value}</dd>
              </div>
              {r.copy && <CopyButton value={r.value.replace(/\s+/g, " ")} label={`Copy ${r.label.toLowerCase()}`} />}
            </div>
          ))}
        </dl>
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <Heart className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          Thank you! A star on GitHub, a bug report or a pull request helps just as much.
        </p>
        <a
          href="https://github.com/emremrangz/emremote"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
        >
          github.com/emremrangz/emremote <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </Dialog>
  );
}
