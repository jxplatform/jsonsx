/// <reference lib="dom" />
/**
 * In-iframe interaction — listens for pointer events inside the canvas iframe, resolves the target
 * to its nearest `data-jx-path` node, and reports hit (click) / hover (move) to the parent with the
 * node's iframe-space rect. The parent owns selection + overlay rendering (cross-origin bridge);
 * the iframe only reports what was pointed at.
 */

import { parseJxPath, serializeJxPath } from "./path-mapping";
import { rectOf } from "../utils/geometry";
import { computeInsertZones, insertZonesKey } from "./iframe-insert";
import { getActiveElement, isEditing } from "../editor/inline-edit";
import type { IframeChannel } from "./iframe-channel";
import type { IframeToParent, NodeHit, ParentToIframe } from "./iframe-protocol";
import type { JxMutableNode } from "@jxsuite/schema/types";

/**
 * Whether a `pointerleave` means the pointer left the CANVAS — not merely one element inside it.
 *
 * `pointerleave` does not bubble, but a CAPTURE listener on the document still sees it for EVERY
 * descendant being exited (the capture path runs through the document once per element in the exit
 * chain). Treating those as "left the canvas" made an ordinary element→element move clear the hover
 * box and the insertion "+" — and, worse, the exit chain that fires when the cursor lands on the
 * PARENT's floating "+" (which overlays the iframe, so the iframe sees a full leave) ends up racing
 * the button's own `mouseenter`. Only the tail of the chain — body/documentElement/document — means
 * the pointer actually left.
 */
function isCanvasLeave(e: Event, doc: Document): boolean {
  const { target } = e;
  return target === doc || target === doc.documentElement || target === doc.body;
}

/** Walk up from an element to the nearest ancestor carrying a `data-jx-path`; null if none. */
function nearestPathEl(start: Element | null): HTMLElement | null {
  let el = start instanceof Element ? (start as HTMLElement) : null;
  while (el) {
    if (el.dataset?.jxPath) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** Walk up from an event target to the nearest element carrying a `data-jx-path`; null if none. */
export function nearestHit(target: EventTarget | null): NodeHit | null {
  const el = nearestPathEl(target instanceof Element ? target : null);
  if (!el) {
    return null;
  }
  const r = rectOf(el);
  return {
    path: parseJxPath(el.dataset.jxPath as string),
    rect: { height: r.height, width: r.width, x: r.x, y: r.y },
  };
}

/**
 * Measure the current rect of each requested document path by locating its `data-jx-path` element.
 * Paths with no matching node are omitted. The serialized path is the same string the renderer
 * stamps, so a stored selection path round-trips back to its element.
 */
export function measureHits(paths: (string | number)[][], doc: Document = document): NodeHit[] {
  const out: NodeHit[] = [];
  for (const path of paths) {
    const serialized = serializeJxPath(path);
    // Wrap in single quotes (the serialized JSON only ever uses double quotes) and escape the few
    // Characters that could still break out of an attribute-value selector.
    const esc = serialized.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`);
    const el = doc.querySelector(`[data-jx-path='${esc}']`);
    if (el) {
      const r = rectOf(el);
      out.push({ path, rect: { height: r.height, width: r.width, x: r.x, y: r.y } });
    }
  }
  return out;
}

/**
 * The iframe-side capabilities the interaction wiring needs beyond raw pointer events. Injected
 * from {@link file://./iframe-entry.ts} (the entry owns the shadow doc), mirroring how
 * {@link file://./iframe-drop.ts}'s `startGrabDetector` receives its deps rather than reaching for
 * module state.
 */
export interface InteractionDeps {
  /**
   * The iframe's current non-reactive shadow doc (path coordinate space), or null before the first
   * render. Threaded so the insertion-zone computation reads the SAME doc the patch/drag paths
   * use.
   */
  getShadowDoc: () => JxMutableNode | null;
  /**
   * The live render's canvas mode. Insertion "+" zones are a document-editing affordance —
   * suppressed for stylebook renders (specimens aren't insert targets). Absent = permissive.
   */
  getMode?: () => string;
  /**
   * The generation the iframe's DOM currently reflects. The parent DROPS the "+" on every
   * render/patch ack (its anchor rect went stale), so the zone de-dupe below has to forget what it
   * last posted when the gen moves — otherwise the cursor sitting on the very same edge across a
   * re-render posts nothing (same key) and the "+" never comes back until the author wanders to a
   * different edge. Absent = a single fixed gen (no resets).
   */
  getGen?: () => number;
}

/**
 * Wire pointer listeners on the iframe document and report hit/hover (and, when `deps` is given,
 * the insertion "+" zones) to the parent. Hover/zones are only reported when they change, to keep
 * the channel quiet. Returns a teardown function.
 *
 * The insertion-zone hook hangs off the SAME pointermove as hover (the cross-origin cousin of the
 * legacy in-realm insertion-helper mousemove): it resolves the hovered `[data-jx-path]` element and
 * posts `insertZones` only when the zone set's key changes; `null` is posted when the pointer
 * leaves the canvas and whenever the cursor sits mid-element (no near-edge zone), so the parent
 * clears any stale "+".
 */
export function startInteraction(
  channel: IframeChannel<IframeToParent, ParentToIframe>,
  doc: Document = document,
  deps?: InteractionDeps,
): () => void {
  let lastHoverKey: string | null = null;
  let lastZonesKey: string | null = null;
  let lastGen = deps?.getGen?.() ?? 0;

  const onClick = (e: Event) => {
    const hit = nearestHit(e.target);
    if (hit) {
      channel.post({ hit, kind: "hit" });
    }
  };

  const reportHover = (hit: NodeHit | null) => {
    const key = hit ? JSON.stringify(hit.path) : null;
    if (key === lastHoverKey) {
      return;
    }
    lastHoverKey = key;
    channel.post({ hit, kind: "hover" });
  };

  /**
   * Re-sync the zone de-dupe with the parent's state after a render/patch: the parent hid the "+"
   * on the ack, which is exactly the "none" it would have reached from a null post — so the next
   * near-edge move re-posts its zone (and a mid-element move stays quiet).
   */
  const syncZoneGen = () => {
    const gen = deps?.getGen?.() ?? lastGen;
    if (gen !== lastGen) {
      lastGen = gen;
      lastZonesKey = "none";
    }
  };

  /** Resolve + post the insertion "+" zones for an iframe-viewport cursor, deduped by key. */
  const reportInsertZones = (target: EventTarget | null, cursor: { x: number; y: number }) => {
    if (!deps || deps.getMode?.() === "stylebook") {
      return;
    }
    syncZoneGen();
    const shadowDoc = deps.getShadowDoc();
    const el = nearestPathEl(target instanceof Element ? target : null);
    const zones = el && shadowDoc ? computeInsertZones(el, cursor, shadowDoc) : null;
    const key = insertZonesKey(zones);
    if (key === lastZonesKey) {
      return;
    }
    lastZonesKey = key;
    channel.post({ kind: "insertZones", zones });
  };

  const onMove = (e: Event) => {
    reportHover(nearestHit(e.target));
    const pe = e as PointerEvent;
    reportInsertZones(e.target, { x: pe.clientX, y: pe.clientY });
  };
  const onLeave = (e: Event) => {
    if (!isCanvasLeave(e, doc)) {
      return;
    }
    reportHover(null);
    if (deps && lastZonesKey !== "none") {
      lastZonesKey = "none";
      channel.post({ kind: "insertZones", zones: null });
    }
  };

  const onContextMenu = (e: Event) => {
    const me = e as MouseEvent;
    // Inside the ACTIVE editable keep the NATIVE menu (spellcheck / paste) — the session owns it.
    const active = isEditing() ? getActiveElement() : null;
    if (active && e.target instanceof Node && active.contains(e.target)) {
      return;
    }
    // Suppress the browser menu everywhere else (legacy parity — the deleted panel-events handler
    // PreventDefaulted even with no element hit) and let the parent show the Jx element menu.
    e.preventDefault();
    const hit = nearestHit(e.target);
    channel.post({
      kind: "contextMenu",
      path: hit ? hit.path : null,
      x: me.clientX,
      y: me.clientY,
    });
  };

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("pointermove", onMove, true);
  doc.addEventListener("pointerleave", onLeave, true);
  doc.addEventListener("contextmenu", onContextMenu, true);

  return () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("pointermove", onMove, true);
    doc.removeEventListener("pointerleave", onLeave, true);
    doc.removeEventListener("contextmenu", onContextMenu, true);
  };
}
