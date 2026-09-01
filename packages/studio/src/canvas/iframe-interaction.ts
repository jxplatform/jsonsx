/// <reference lib="dom" />
/**
 * In-iframe interaction — listens for pointer events inside the canvas iframe, resolves the target
 * to its nearest `data-jx-path` node, and reports hit (click) / hover (move) to the parent with the
 * node's iframe-space rect. The parent owns selection + overlay rendering (cross-origin bridge);
 * the iframe only reports what was pointed at.
 */

import { jxPathSelector, parseJxPath, serializeJxPath } from "./path-mapping";
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

/** Measure an already-resolved path element. Split out so callers can dedupe BEFORE measuring. */
function measureHit(el: HTMLElement, serializedPath: string): NodeHit {
  const r = rectOf(el);
  return {
    path: parseJxPath(serializedPath),
    rect: { height: r.height, width: r.width, x: r.x, y: r.y },
  };
}

/** Walk up from an event target to the nearest element carrying a `data-jx-path`; null if none. */
export function nearestHit(target: EventTarget | null): NodeHit | null {
  const el = nearestPathEl(target instanceof Element ? target : null);
  if (!el) {
    return null;
  }
  return measureHit(el, el.dataset.jxPath as string);
}

/**
 * Whether an element is actually rendered, as opposed to merely present in the DOM.
 *
 * `checkVisibility` is the platform's own answer, and it is the right one: it walks the ancestor
 * chain, so a node inside a closed popover or a `display: none` section is reported hidden without
 * this having to know why. happy-dom implements it faithfully (`display`, `visibility`, `opacity`,
 * disconnection), so the guard is exercised under test rather than merely asserted.
 *
 * A rect test would NOT work here and was tried: happy-dom performs no layout, so every element
 * measures 0×0 at the origin and the guard would report the whole document hidden.
 *
 * An engine without `checkVisibility` gets the benefit of the doubt. Withholding a selection box
 * from a node that is on screen is a worse failure than drawing one for a node that is not.
 */
function isRendered(el: Element): boolean {
  const check = (el as { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(el, { checkVisibilityCSS: true }) : true;
}

/**
 * Measure the current rect of each requested document path by locating its `data-jx-path` element.
 *
 * Paths with no matching node are omitted. Paths that resolve to an element which is NOT RENDERED —
 * a closed popover, a `display: none` node, a `$switch` branch that is not the live case — come
 * back under `hidden` instead of as a rect. That distinction is the point: they used to be measured
 * like anything else, and a zero rect is a truthy object, so the overlay drew a 0×0 box at the
 * artboard origin and the block action bar anchored to it. Selecting a hidden node put a selection
 * marker in the corner of the page and left the toolbar sitting there.
 *
 * The serialized path is the same string the renderer stamps, so a stored selection path
 * round-trips back to its element.
 */
export function measureHits(
  paths: (string | number)[][],
  doc: Document = document,
): { hits: NodeHit[]; hidden: (string | number)[][] } {
  const hits: NodeHit[] = [];
  const hidden: (string | number)[][] = [];
  for (const path of paths) {
    const el = doc.querySelector(jxPathSelector(serializeJxPath(path)));
    if (!el) {
      continue;
    }
    if (isRendered(el)) {
      const r = rectOf(el);
      hits.push({ path, rect: { height: r.height, width: r.width, x: r.x, y: r.y } });
    } else {
      hidden.push(path);
    }
  }
  return { hidden, hits };
}

/**
 * The iframe-side capabilities the interaction wiring needs beyond raw pointer events. Injected
 * from {@link file://./iframe-entry.ts} (the entry owns the shadow doc), mirroring how
 * {@link file://./iframe-drop.ts}'s `startGrabDetector` receives its deps rather than reaching for
 * module state.
 */
/** The three `popovertargetaction` keywords. Anything else falls back to the HTML default. */
const INVOKER_ACTIONS = new Set(["toggle", "show", "hide"]);

/**
 * Report an invoker click, when the click landed on one and it names an addressable popover.
 *
 * Both attributes are read from their CANVAS spellings: the runtime renamed `popover` to
 * `data-jx-popover` for the render, but `popovertarget` keeps its own name — nothing in the editor
 * needs it renamed, since with no real popover to invoke the browser does nothing with it anyway.
 * That is what makes this safe to post unconditionally: a trigger whose target is a component's own
 * internal popover resolves to no addressable node, and nothing is posted.
 *
 * Called only after `onClick`'s preview branch has returned, so no mode gate is needed here.
 *
 * @param target The click's `e.target`.
 * @param channel The frame's channel.
 */
function postPopoverInvoke(
  target: EventTarget | null,
  channel: { post: (m: IframeToParent) => void },
): void {
  if (!(target instanceof Element)) {
    return;
  }
  const invoker = target.closest("[popovertarget]");
  const id = invoker?.getAttribute("popovertarget");
  if (!invoker || !id) {
    return;
  }
  /* Scanned rather than selected. The id is author-controlled text, so a `[id='…']` selector would
     need escaping — a rule this file already keeps in exactly one place (`jxPathSelector`) and
     should not gain a second spelling of. The set scanned is the addressable POPOVERS, which is
     also the set the answer has to come from, so the scan is the test. */
  const panels = invoker.ownerDocument.querySelectorAll("[data-jx-popover]");
  const panel = [...panels].find((el) => el.id === id) as HTMLElement | undefined;
  const serialized = panel?.dataset.jxPath;
  if (!serialized) {
    return;
  }
  const raw = invoker.getAttribute("popovertargetaction") ?? "toggle";
  const action = INVOKER_ACTIONS.has(raw) ? (raw as "toggle" | "show" | "hide") : "toggle";
  channel.post({ action, kind: "popoverTargetClick", targetPath: parseJxPath(serialized) });
}

export interface InteractionDeps {
  /**
   * The iframe's current non-reactive shadow doc (path coordinate space), or null before the first
   * render. Threaded so the insertion-zone computation reads the SAME doc the patch/drag paths
   * use.
   */
  getShadowDoc: () => JxMutableNode | null;
  /**
   * The live render's canvas mode. Editing affordances are suppressed per mode: insertion "+" zones
   * are meaningless for stylebook renders (specimens aren't insert targets), and preview reports
   * nothing at all beyond link intent — no hit, no hover, no zones, no Jx context menu — because a
   * preview is the shipped page, not a document you can point at. Absent = permissive.
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

  /**
   * Whether this render is a preview. Preview is the fidelity view: it has no selection, no hover
   * box, no insertion "+" and no Jx element menu, so the frame reports none of them. (The host
   * refuses the same messages independently — the iframe bundle ships prebuilt, so neither side may
   * rely on the other's build being current.)
   */
  const isPreview = () => deps?.getMode?.() === "preview";

  /**
   * Report that the person is now working in this frame's pane — every mode, every button, every
   * target.
   *
   * `pointerdown` rather than `click`, and unconditional rather than mode-gated, because both of
   * `hit`'s holes are holes in what a CLICK means here. In preview there is no `hit` by design (a
   * click in preview is a click on the page), and in edit/design `hit` is posted only when the
   * click lands on a `[data-jx-path]` node — so an artboard's empty margin, a right-click, and
   * every single interaction with a Preview pane all left the keyboard in the other pane.
   *
   * It carries nothing, which is what makes it safe to send from preview: the parent moves pane
   * focus and does not touch the document, so the page underneath is still just a page.
   */
  const onPointerDown = () => {
    channel.post({ kind: "paneFocus" });
  };

  const onClick = (e: Event) => {
    /*
     * Preview keeps anchors live, so a click would navigate this iframe and destroy the render (and
     * the editing session with it). Report the intent so the parent can open the real page in a real
     * browser tab — where routing, project JS and server data behave as they will in production —
     * rather than replacing the canvas with a half-loaded page.
     *
     * Design/edit never reach this: the runtime de-links anchors onto `data-jx-href` there, so there
     * is no navigation to intercept and a click means "select this element".
     */
    if (isPreview()) {
      if (e.target instanceof Element) {
        const anchor = e.target.closest("a[href]");
        const href = anchor?.getAttribute("href");
        if (href && !href.startsWith("#")) {
          e.preventDefault();
          channel.post({ href, kind: "previewNavigate" });
        }
      }
      // No hit post: a click in preview is a click on the page, never a selection.
      return;
    }
    postPopoverInvoke(e.target, channel);
    const hit = nearestHit(e.target);
    if (hit) {
      // Ctrl/Cmd is the accumulate gesture (§6.5). The iframe reports the modifier and nothing
      // Else — it holds no selection state, so what a modified click MEANS is the parent's to
      // Decide, exactly as the unmodified click already was.
      const mouse = e as MouseEvent;
      channel.post({
        additive: mouse.ctrlKey === true || mouse.metaKey === true,
        hit,
        kind: "hit",
      });
    }
  };

  /**
   * Post hover only when the hovered element changes — and MEASURE only then.
   *
   * The de-dupe key is the element's own `data-jx-path` attribute, which is already the serialized
   * path, so deciding "did this change?" costs one string compare. The previous form called
   * {@link nearestHit} first, which ran `getBoundingClientRect` on every single `pointermove` before
   * the key was ever compared — a forced layout per mouse move, thrown away almost every time.
   */
  const reportHover = (el: HTMLElement | null) => {
    if (isPreview()) {
      return;
    }
    const key = el?.dataset.jxPath ?? null;
    if (key === lastHoverKey) {
      return;
    }
    lastHoverKey = key;
    channel.post({ hit: el && key ? measureHit(el, key) : null, kind: "hover" });
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
    if (!deps || deps.getMode?.() === "stylebook" || isPreview()) {
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

  /**
   * Hover + insertion zones are coalesced into one frame.
   *
   * Chrome already caps `pointermove` at the display rate, but each event did DOM walks, a
   * `JSON.parse` of the path, and — via `computeInsertZones` — a `getBoundingClientRect` plus a
   * `getComputedStyle` on the parent. Collapsing to one rAF means at most one such pass per frame,
   * and only the newest cursor position is used (an intermediate position is never interesting once
   * a newer one has arrived).
   */
  let movePending = 0;
  let moveTarget: EventTarget | null = null;
  let moveX = 0;
  let moveY = 0;
  const raf = (cb: () => void) =>
    doc.defaultView?.requestAnimationFrame(cb) ?? requestAnimationFrame(cb);
  const cancelRaf = (id: number) =>
    doc.defaultView?.cancelAnimationFrame(id) ?? cancelAnimationFrame(id);

  const flushMove = () => {
    movePending = 0;
    const target = moveTarget;
    moveTarget = null;
    reportHover(nearestPathEl(target instanceof Element ? target : null));
    reportInsertZones(target, { x: moveX, y: moveY });
  };

  const onMove = (e: Event) => {
    const pe = e as PointerEvent;
    moveTarget = e.target;
    moveX = pe.clientX;
    moveY = pe.clientY;
    if (movePending) {
      return;
    }
    movePending = raf(flushMove);
  };
  const onLeave = (e: Event) => {
    if (!isCanvasLeave(e, doc)) {
      return;
    }
    reportHover(null);
    if (deps && !isPreview() && lastZonesKey !== "none") {
      lastZonesKey = "none";
      channel.post({ kind: "insertZones", zones: null });
    }
  };

  const onContextMenu = (e: Event) => {
    const me = e as MouseEvent;
    // Preview keeps the NATIVE menu: the Jx element menu's verbs (duplicate, delete, paste, wrap)
    // Are document edits, and preview does not edit. Copy Link Address does what it says instead.
    if (isPreview()) {
      return;
    }
    // Inside the ACTIVE editable keep the NATIVE menu (spellcheck / paste) — the session owns it.
    const active = isEditing() ? getActiveElement() : null;
    if (active && e.target instanceof Node && active.contains(e.target)) {
      return;
    }
    const hit = nearestHit(e.target);
    /*
     * NO ELEMENT UNDER THE POINTER — keep the browser's menu.
     *
     * This called `preventDefault()` before looking, "legacy parity" with a handler that did the
     * same. The parent then posts `path: null`, `showContextMenu` returns early on it, and the
     * result is a right-click that suppresses the browser menu and shows nothing in its place:
     * plan §10's dead zone, named there as the thing to fix. The margin around the artboard is
     * exactly where a reader reaches for View Source or Inspect.
     */
    if (!hit) {
      return;
    }
    // An element IS under the pointer, so the Jx element menu is the right answer and the browser's
    // Would be a worse one.
    e.preventDefault();
    channel.post({
      kind: "contextMenu",
      path: hit.path,
      x: me.clientX,
      y: me.clientY,
    });
  };

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("pointermove", onMove, true);
  doc.addEventListener("pointerleave", onLeave, true);
  doc.addEventListener("contextmenu", onContextMenu, true);

  return () => {
    if (movePending) {
      cancelRaf(movePending);
      movePending = 0;
    }
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("pointermove", onMove, true);
    doc.removeEventListener("pointerleave", onLeave, true);
    doc.removeEventListener("contextmenu", onContextMenu, true);
  };
}
