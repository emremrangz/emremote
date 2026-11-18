import { useSyncExternalStore } from "react";
import { getReadAccess, isMacClient, readLocal, subscribeReadAccess } from "@/lib/clipboard";
import { Button } from "@/components/ui/Button";

/** The browser's clipboard read access, updated when it changes (shared by every session on the page). */
function useClipboardAccess() {
  return useSyncExternalStore(subscribeReadAccess, getReadAccess);
}

/**
 * Explains in the Clipboard panel what right-click paste can do with the current browser setting, and asks for access
 * on an explicit click (never on a right click in the session, where the question gets closed unanswered).
 */
export function ClipboardAccess({ onText }: { onText?: (text: string) => void }) {
  const { state, refused } = useClipboardAccess();
  const paste = isMacClient() ? "⌘V" : "Ctrl+V";
  let body: React.ReactNode;
  if (state === "granted") {
    body = <p>Clipboard access is on: right-click pastes what you copied on this computer.</p>;
  } else if (state === "denied" || refused) {
    body = (
      <p>
        The browser is blocking clipboard access for this site, so right-click cannot paste what you copied on this computer.{" "}
        {paste} still works. To allow it in Chrome or Edge, click the icon left of the address, open Site settings and set
        Clipboard to Allow. If it already says Ask, the browser blocked it by itself after its question was closed: choose
        Reset permission there, reload the page and press Allow clipboard access here.
      </p>
    );
  } else if (state === "prompt") {
    body = (
      <>
        <p>Allow clipboard access once so right-click pastes what you copied on this computer. {paste} works without it.</p>
        <Button
          size="sm"
          className="mt-2"
          onClick={async () => {
            const t = await readLocal(); // the browser asks now; its answer updates this panel
            if (t && onText) onText(t);
          }}
        >
          Allow clipboard access
        </Button>
      </>
    );
  } else if (state === "gesture") {
    body = <p>Right-click shows the browser's own Paste button before pasting what you copied on this computer.</p>;
  } else {
    body = <p>Paste with {paste}: this browser does not let pages read the clipboard otherwise.</p>;
  }
  return <div className="rounded-md border border-border bg-surface-2 p-2 text-2xs leading-relaxed text-subtle">{body}</div>;
}
