// Opening remote sessions. They live in one workspace window (tabs and split
// panes); a second click adds another tab there instead of another window.

/** Name of the browser window that hosts the workspace. */
export const WORKSPACE_NAME = "emremote-workspace";
export const WORKSPACE_CHANNEL = "emremote-workspace";

/**
 * Opens or focuses the workspace window. Call this directly from a click
 * handler (browsers block pop-ups opened after an await).
 */
export function openWorkspaceWindow(): Window | null {
  const w = window.open("", WORKSPACE_NAME);
  w?.focus();
  return w;
}

/**
 * Adds a session to the workspace shown in win. A window that was just created
 * is still blank and gets the workspace loaded with the session; an existing
 * workspace is told through a broadcast channel. If the browser blocked the
 * pop-up, the session opens in this tab.
 */
export function addToWorkspace(win: Window | null, connectionId: string) {
  const url = `/workspace?open=${encodeURIComponent(connectionId)}`;
  if (!win) {
    window.location.href = url;
    return;
  }
  let blank = false;
  try {
    blank = win.location.href === "about:blank";
  } catch {
    blank = false;
  }
  if (blank) {
    win.location.href = url;
    return;
  }
  // Ask the workspace to add it. A window with that name that does not answer (it
  // was navigated elsewhere, or runs an older version) is loaded with the workspace instead.
  const ch = new BroadcastChannel(WORKSPACE_CHANNEL);
  const done = () => {
    clearTimeout(timer);
    ch.close();
  };
  const timer = setTimeout(() => {
    done();
    win.location.href = url;
  }, 1500);
  ch.onmessage = (e) => {
    if (e.data?.type === "ack" && e.data.id === connectionId) done();
  };
  ch.postMessage({ type: "open", id: connectionId });
}

/** Closes a workspace window that was opened for a launch that then failed (never an existing workspace). */
export function closeIfBlank(win: Window | null) {
  try {
    if (win && win.location.href === "about:blank") win.close();
  } catch {
    /* not ours to close */
  }
}

/** Opens a session in the workspace (a new window, or a new tab of the open one). */
export function launchConnection(connectionId: string) {
  addToWorkspace(openWorkspaceWindow(), connectionId);
}

/** Opens a session alone in its own window, outside the workspace. */
export function launchStandalone(connectionId: string) {
  const w = window.open(`/connect/${connectionId}`, `emremote-${connectionId}`);
  w?.focus();
}
