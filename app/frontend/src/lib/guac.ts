// Loader and minimal typings for the vendored Apache Guacamole JavaScript client
// (public/vendor/guacamole-common-js, unmodified upstream 1.6.0).

/* eslint-disable @typescript-eslint/no-explicit-any */
export type GuacamoleNS = any;
export type GuacClient = any;

declare global {
  interface Window {
    Guacamole?: GuacamoleNS;
  }
}

const SRC = "/vendor/guacamole-common-js/guacamole-common-js-1.6.0.js";
let loading: Promise<GuacamoleNS> | null = null;

export function loadGuacamole(): Promise<GuacamoleNS> {
  if (window.Guacamole?.Client) return Promise.resolve(window.Guacamole);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SRC;
      s.async = true;
      s.onload = () => (window.Guacamole?.Client ? resolve(window.Guacamole) : reject(new Error("Remote display client failed to initialize")));
      s.onerror = () => {
        loading = null;
        reject(new Error("Could not load the remote display client"));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/** Client states (Guacamole.Client.State). */
export const ClientState = {
  IDLE: 0,
  CONNECTING: 1,
  WAITING: 2,
  CONNECTED: 3,
  DISCONNECTING: 4,
  DISCONNECTED: 5,
} as const;

/** Tunnel states (Guacamole.Tunnel.State). */
export const TunnelState = { CONNECTING: 0, OPEN: 1, CLOSED: 2, UNSTABLE: 3 } as const;

/** Human-readable explanations for Guacamole status codes. */
export function statusMessage(code: number, protocol?: string): { title: string; hint?: string } {
  switch (code) {
    case 0x0201:
      return { title: "The remote access gateway is busy.", hint: "Try again in a moment." };
    case 0x0202:
      return { title: "The remote computer did not respond in time.", hint: "Check that it is powered on and reachable from the emremote server." };
    case 0x0203:
      return {
        title: "The remote computer reported an error.",
        hint:
          protocol === "rdp"
            ? "Common causes: wrong credentials, NLA required but no credentials given, or an untrusted certificate (pin it in the connection's Security settings)."
            : "Check the credentials and the server's logs.",
      };
    case 0x0204:
      return { title: "The requested connection no longer exists." };
    case 0x0207:
      return {
        title: "The remote computer could not be reached.",
        hint:
          protocol === "rdp"
            ? "Check that Remote Desktop is enabled and the firewall allows the port. If the computer's certificate changed since the first connection, accept the new one in the connection's Security settings."
            : "Check that the computer is on, the service is running and the firewall allows the port.",
      };
    case 0x0208:
      return { title: "The remote computer refused the session.", hint: "It may be busy, or another user may be signed in." };
    case 0x0209:
      return { title: "The session was taken over by another connection." };
    case 0x020a:
      return { title: "The session timed out." };
    case 0x020b:
      return { title: "The session was closed.", hint: "It was terminated by an administrator, by signing out, or by the server." };
    case 0x0301:
      return { title: "Authentication failed.", hint: "Check the username, password and domain." };
    case 0x0303:
      return { title: "Access was denied by the remote computer." };
    case 0x0308:
      return { title: "Your browser stopped responding to the server.", hint: "Check your network connection." };
    case 0x031d:
      return { title: "Too many connections." };
    default:
      return {
        title: "The connection failed.",
        hint:
          protocol === "ssh"
            ? "If the server was reinstalled, its host key changed since the first connection; accept the new key in the connection's Security settings. Otherwise check the credentials."
            : "See the emremote and gateway logs for details.",
      };
  }
}

/** X11 keysyms used by the special-key menu. */
export const Keysym = {
  Ctrl: 0xffe3,
  Alt: 0xffe9,
  Shift: 0xffe1,
  Super: 0xffeb,
  Delete: 0xffff,
  Escape: 0xff1b,
  Tab: 0xff09,
  Print: 0xff61,
  BackSpace: 0xff08,
  F4: 0xffc1,
  L: 0x006c,
  R: 0x0072,
} as const;

export function supportedImageTypes(): string[] {
  const types = ["image/png", "image/jpeg"];
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    if (c.toDataURL("image/webp").startsWith("data:image/webp")) types.push("image/webp");
  } catch {
    /* ignore */
  }
  return types;
}
