import { TerminalShell } from "@/components/TerminalShell";

/** Shown instead of first-run setup when the database is empty but this server was set up before. */
export default function DataMissingPage() {
  return (
    <TerminalShell title="database" heading="The database looks empty" onSubmit={(e) => e.preventDefault()}>
      <p data-term className="mb-2 flex items-baseline gap-3">
        <span className="bg-gradient-to-r from-[#e3b341] to-[#ff7b72] bg-clip-text text-2xl font-bold tracking-tight text-transparent">emremote</span>
        <span className="text-white/35">attention</span>
      </p>
      <p className="text-[#e3b341]">
        <span className="font-semibold">[warn]</span> This server was set up before, but its database has no accounts.
      </p>
      <p className="text-white/55">
        <span className="text-white/40">[ -- ]</span> The data folder or database volume is most likely not mounted correctly (for example a changed
        EMREMOTE_DATA_DIR). Nothing has been changed, and first-time setup is switched off so that nobody can start a new installation on top
        of it by accident.
      </p>
      <div data-term className="h-2" />
      <p className="text-white/70">What to do:</p>
      <ol className="list-inside list-decimal space-y-1 text-white/55">
        <li>Check that the data folder is the one you used before (see EMREMOTE_DATA_DIR in .env).</li>
        <li>
          Restart: <span className="text-white/80">docker compose up -d</span>
        </li>
        <li>
          To start over on purpose, set <span className="text-white/80">EMREMOTE_ALLOW_EMPTY_DATABASE=true</span> in .env and restart.
        </li>
      </ol>
    </TerminalShell>
  );
}
