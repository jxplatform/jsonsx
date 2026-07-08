/**
 * Remote cursor colors for y-monaco. MonacoBinding decorates other clients' text cursors with
 * per-client class names (`yRemoteSelection-<id>`, `yRemoteSelectionHead-<id>`) but ships no
 * styling — this module maintains one injected <style> element with a rule set per remote client,
 * colored from the presence palette (`user.color`) and labeled with the author's name on hover of
 * the cursor head.
 */

/** The slice of y-protocols Awareness the style manager uses (duck-typed; stays yjs-free). */
export interface AwarenessLike {
  clientID: number;
  getStates: () => Map<number, unknown>;
  on: (event: "change", cb: () => void) => void;
  off: (event: "change", cb: () => void) => void;
}

interface PeerStateShape {
  user?: { color?: string; name?: string; login?: string };
}

/** CSS-escape for the content string (names come from GitHub logins/display names). */
function cssString(value: string): string {
  return `"${value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/** One client's rules: translucent selection band, solid caret, name flag above the caret. */
export function cursorRulesFor(clientId: number, color: string, label: string): string {
  return [
    `.yRemoteSelection-${clientId}{background-color:${color}44;}`,
    `.yRemoteSelectionHead-${clientId}{position:absolute;border-left:2px solid ${color};height:100%;box-sizing:border-box;}`,
    `.yRemoteSelectionHead-${clientId}::after{content:${cssString(label)};position:absolute;top:-1.2em;left:-2px;padding:0 4px;border-radius:3px 3px 3px 0;font:10px/1.4 sans-serif;color:#fff;white-space:nowrap;background-color:${color};opacity:0;transition:opacity .15s;pointer-events:none;}`,
    `.yRemoteSelectionHead-${clientId}:hover::after{opacity:1;}`,
  ].join("\n");
}

/** Full stylesheet text for every remote client with a presence identity. */
export function cursorStylesheet(awareness: AwarenessLike): string {
  const rules: string[] = [];
  for (const [clientId, raw] of awareness.getStates()) {
    if (clientId === awareness.clientID) {
      continue;
    }
    const { user } = raw as PeerStateShape;
    if (!user?.color) {
      continue;
    }
    rules.push(cursorRulesFor(clientId, user.color, user.name ?? user.login ?? String(clientId)));
  }
  return rules.join("\n");
}

/**
 * Keep an injected <style> element in sync with the awareness roster while a code view is bound.
 * Returns the disposer (removes the element and the listener).
 */
export function attachCursorStyles(awareness: AwarenessLike, doc: Document): () => void {
  const style = doc.createElement("style");
  style.dataset["jxCollabCursors"] = "true";
  doc.head.append(style);
  const refresh = () => {
    style.textContent = cursorStylesheet(awareness);
  };
  refresh();
  awareness.on("change", refresh);
  return () => {
    awareness.off("change", refresh);
    style.remove();
  };
}
