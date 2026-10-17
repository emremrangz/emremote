// A session shown in a large window on top of the current page ("quick view"), without leaving it.
const EVENT = "emremote-quickview";

export function openQuickView(connectionId: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: connectionId }));
}

export function onQuickView(handler: (connectionId: string) => void): () => void {
  const h = (e: Event) => handler((e as CustomEvent<string>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
