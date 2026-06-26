/// <reference lib="dom" />
/**
 * In-iframe interaction — listens for pointer events inside the canvas iframe, resolves the target
 * to its nearest `data-jx-path` node, and reports hit (click) / hover (move) to the parent with the
 * node's iframe-space rect. The parent owns selection + overlay rendering (cross-origin bridge);
 * the iframe only reports what was pointed at.
 */

import { parseJxPath, serializeJxPath } from "./path-mapping";
import { rectOf } from "../utils/geometry";
import type { IframeChannel } from "./iframe-channel";
import type { IframeToParent, NodeHit, ParentToIframe } from "./iframe-protocol";

/** Walk up from an event target to the nearest element carrying a `data-jx-path`; null if none. */
export function nearestHit(target: EventTarget | null): NodeHit | null {
  let el = target instanceof Element ? target : null;
  while (el) {
    const serialized = (el as HTMLElement).dataset?.jxPath;
    if (serialized) {
      const r = rectOf(el);
      return {
        path: parseJxPath(serialized),
        rect: { height: r.height, width: r.width, x: r.x, y: r.y },
      };
    }
    el = el.parentElement;
  }
  return null;
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
 * Wire pointer listeners on the iframe document and report hit/hover to the parent. Hover is only
 * reported when the resolved node changes, to keep the channel quiet. Returns a teardown function.
 */
export function startInteraction(
  channel: IframeChannel<IframeToParent, ParentToIframe>,
  doc: Document = document,
): () => void {
  let lastHoverKey: string | null = null;

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

  const onMove = (e: Event) => reportHover(nearestHit(e.target));
  const onLeave = () => reportHover(null);

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("pointermove", onMove, true);
  doc.addEventListener("pointerleave", onLeave, true);

  return () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("pointermove", onMove, true);
    doc.removeEventListener("pointerleave", onLeave, true);
  };
}
