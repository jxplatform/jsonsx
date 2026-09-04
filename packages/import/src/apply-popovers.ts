/**
 * Rewrite a captured dropdown, mega-menu or drawer into a real HTML popover.
 *
 * The importer had no concept of an overlay, and the failure was quiet rather than loud: the markup
 * all survived — `aria-haspopup`, `aria-controls`, `data-toggle-panel` and the panel itself — but
 * the panel was captured in its CLOSED state and that state was written down as an unconditional
 * style. The reference corpus emitted its navigation submenu as `{ display: grid, opacity: 0,
 * position: absolute, zIndex: 10 }`, with nothing anywhere left to change the opacity. The menu
 * could never appear again.
 *
 * The target is the platform's own popover, which `@jxsuite/schema` already models. Two of its
 * rules are the two defects that have actually shipped in this repo, so they are obeyed here by
 * construction rather than checked afterwards:
 *
 * 1. **A popover's base rule may not set `display` or `visibility`.** The UA sheet closes a popover
 *    with `[popover]:not(:popover-open) { display: none }`, and that rule is UA-origin, so any
 *    author `display` beats it and the panel is laid out whether open or not. The captured
 *    declarations move into `:popover-open`, which is where they were always describing.
 * 2. **Only `<button>` and `<input>` can invoke one.** `popovertarget` comes from an IDL mixin
 *    included into those two interfaces and nothing else; on an `<a>` it parses and does nothing.
 *    An anchor that is really a button (`href="#"`) is converted into one. An anchor that actually
 *    navigates is left alone, because turning a link into a button would break the link.
 *
 * `opacity` is handled here rather than by `popoverDisplayRepair`, which lifts only `display` and
 * `visibility`. The corpus's mega-menu is concealed with `opacity: 0` alone, so a repair that
 * ignored it would produce a popover that opens into nothing.
 */

import type { JxElement } from "@jxsuite/schema/types";
import { POPOVER_DEFAULT_MODE, POPOVER_INVOKER_TAGS } from "@jxsuite/schema/overlays";

/** Attributes naming the panel an invoker controls, in the order they are trusted. */
const TARGET_ATTRIBUTES = ["aria-controls", "data-toggle-panel", "data-target", "href"];

/** Attributes that mark a control as opening something, none of which is required on its own. */
const INVOKER_MARKERS = ["aria-haspopup", "aria-expanded", "data-toggle-panel", "data-target"];

/** Declarations that mean "this panel is currently closed" rather than "this is its design". */
const CONCEALING = new Set(["display", "visibility", "opacity"]);

/** A concealed panel is only a popover if it is also lifted out of the flow. */
const POSITIONED = new Set(["absolute", "fixed"]);

function styleOf(node: JxElement): Record<string, unknown> | undefined {
  return node.style as Record<string, unknown> | undefined;
}

function attributesOf(node: JxElement): Record<string, unknown> | undefined {
  return node.attributes as Record<string, unknown> | undefined;
}

function childrenOf(node: JxElement): JxElement[] {
  return Array.isArray(node.children)
    ? (node.children.filter((child) => typeof child !== "string") as JxElement[])
    : [];
}

/** Whether a style hides the node outright, and by which declaration. */
function concealedBy(style: Record<string, unknown> | undefined): string[] {
  if (!style) {
    return [];
  }
  const found: string[] = [];
  if (style["display"] === "none") {
    found.push("display");
  }
  if (style["visibility"] === "hidden" || style["visibility"] === "collapse") {
    found.push("visibility");
  }
  const { opacity } = style;
  if (opacity === 0 || opacity === "0") {
    found.push("opacity");
  }
  return found;
}

/**
 * Whether this node looks like an overlay panel rather than ordinary hidden content.
 *
 * Concealment alone is not enough and must not be: a responsive alternate, a decorative SVG
 * definition and a closed accordion row are all hidden too, and staples any of them permanently
 * over the page if mistaken for a popover. Being lifted out of the flow is what distinguishes a
 * thing drawn ON TOP from a thing not drawn at all — with `role="dialog"` and `inert` accepted as
 * explicit statements of the same intent.
 */
export function looksLikePanel(node: JxElement): boolean {
  const style = styleOf(node);
  if (concealedBy(style).length === 0) {
    return false;
  }
  const attributes = attributesOf(node);
  if (attributes?.["role"] === "dialog" || attributes?.["inert"] !== undefined) {
    return true;
  }
  return POSITIONED.has(String(style?.["position"] ?? ""));
}

/** The id an invoker names, from whichever attribute carries it. */
export function targetIdOf(node: JxElement): string | null {
  const attributes = attributesOf(node);
  if (!attributes) {
    return null;
  }
  for (const name of TARGET_ATTRIBUTES) {
    const raw = attributes[name];
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }
    const id = raw.startsWith("#") ? raw.slice(1) : name === "href" ? "" : raw;
    if (id.length > 0 && /^[A-Za-z][\w:.-]*$/.test(id)) {
      return id;
    }
  }
  return null;
}

/** Whether this element is a control that opens something. */
function looksLikeInvoker(node: JxElement): boolean {
  const tag = String(node.tagName ?? "").toLowerCase();
  if (tag !== "button" && tag !== "input" && tag !== "a") {
    return false;
  }
  const attributes = attributesOf(node);
  if (!attributes) {
    return false;
  }
  return (
    INVOKER_MARKERS.some((name) => attributes[name] !== undefined) || targetIdOf(node) !== null
  );
}

/** Every element in the tree that carries an `id`, so a control can be paired with its panel. */
function indexById(root: JxElement): Map<string, JxElement> {
  const index = new Map<string, JxElement>();
  const visit = (node: JxElement): void => {
    const id = attributesOf(node)?.["id"];
    if (typeof id === "string" && !index.has(id)) {
      index.set(id, node);
    }
    for (const child of childrenOf(node)) {
      visit(child);
    }
  };
  visit(root);
  return index;
}

/**
 * The panel an invoker opens, when no id names it.
 *
 * Takes the ancestry INCLUDING the invoker, so the invoker's own next sibling is considered first
 * and each ancestor's after it.
 *
 * The corpus's mega-menu is the case this exists for: the trigger sits inside a `<span>` and the
 * panel is that span's next sibling, so the panel is the trigger's UNCLE. Walking up from the
 * invoker and checking each ancestor's next sibling finds it, where "the invoker's own next
 * sibling" finds nothing on any of the site's four dropdowns.
 */
function panelBesideAncestor(ancestry: readonly JxElement[]): JxElement | null {
  for (let depth = ancestry.length - 1; depth >= 0; depth -= 1) {
    const node = ancestry[depth]!;
    const parent = ancestry[depth - 1];
    if (!parent) {
      break;
    }
    const siblings = childrenOf(parent);
    const next = siblings[siblings.indexOf(node) + 1];
    if (next && looksLikePanel(next)) {
      return next;
    }
  }
  return null;
}

/**
 * The value a concealed property takes when the panel is OPEN.
 *
 * `opacity: 0` and `visibility: hidden` each have an exact inverse, so the open rule can state it
 * rather than rely on a default — which is what makes a transition possible and what stops the
 * schema's `no-open-rule` warning firing on a panel that is genuinely fine.
 *
 * `display: none` has NO inverse. The captured value erased whatever the panel used when open, and
 * writing `block` there would be inventing a fact: the element's own default is the honest answer,
 * so nothing is written and the warning is accepted.
 */
function openValueFor(property: string, closed: unknown): string | null {
  if (property === "opacity" && (closed === 0 || closed === "0")) {
    return "1";
  }
  if (property === "visibility" && (closed === "hidden" || closed === "collapse")) {
    return "visible";
  }
  return null;
}

/** Move a panel's closed-state declarations into `:popover-open`, where they describe the open one. */
function liftConcealment(node: JxElement): void {
  const style = styleOf(node);
  if (!style) {
    return;
  }
  const open = (style[":popover-open"] as Record<string, unknown> | undefined) ?? {};
  for (const property of Object.keys(style)) {
    if (!CONCEALING.has(property)) {
      continue;
    }
    const value = style[property];
    const isConcealment = concealedBy({ [property]: value }).length > 0;
    /* A concealment is replaced by its inverse where it has one; anything else was the panel's
       design and is carried across unchanged, because the base rule is no longer where it belongs. */
    const openValue = isConcealment ? openValueFor(property, value) : value;
    if (openValue !== null) {
      (open as Record<string, unknown>)[property] = openValue;
    }
    delete style[property];
  }
  if (Object.keys(open).length > 0) {
    (style as Record<string, unknown>)[":popover-open"] = open;
  }
}

export interface PopoverResult {
  /** How many invoker/panel pairs were converted. */
  converted: number;
  /** Anchors left alone because converting them would have broken a real link. */
  skippedNavigatingLinks: number;
}

/**
 * Convert every recognisable overlay in a page tree into a native popover.
 *
 * @param {JxElement} root - The page tree, mutated in place
 * @returns {PopoverResult}
 */
export function applyPopovers(root: JxElement): PopoverResult {
  const result: PopoverResult = { converted: 0, skippedNavigatingLinks: 0 };
  const byId = indexById(root);
  const claimed = new Set<JxElement>();
  let generated = 0;

  const visit = (node: JxElement, ancestry: JxElement[]): void => {
    if (looksLikeInvoker(node)) {
      const id = targetIdOf(node);
      const panel = (id === null ? null : byId.get(id)) ?? panelBesideAncestor([...ancestry, node]);

      if (panel && panel !== node && !claimed.has(panel) && looksLikePanel(panel)) {
        const tag = String(node.tagName ?? "").toLowerCase();
        const attributes = (node.attributes ??= {}) as Record<string, unknown>;

        /* `popovertarget` exists only on button and input. An anchor that is really a button
           becomes one; an anchor that navigates keeps its job, because a dead link is a worse
           defect than an unconverted menu. */
        if (!POPOVER_INVOKER_TAGS.has(tag)) {
          const { href } = attributes;
          const navigates = typeof href === "string" && href.length > 0 && href !== "#";
          if (navigates) {
            result.skippedNavigatingLinks += 1;
            for (const child of childrenOf(node)) {
              visit(child, [...ancestry, node]);
            }
            return;
          }
          node.tagName = "button";
          attributes["type"] = "button";
          delete attributes["href"];
        }

        const panelAttributes = (panel.attributes ??= {}) as Record<string, unknown>;
        let { id: panelId } = panelAttributes;
        if (typeof panelId !== "string" || panelId.length === 0) {
          generated += 1;
          panelId = `jx-popover-${generated}`;
          panelAttributes["id"] = panelId;
        }

        panelAttributes["popover"] = POPOVER_DEFAULT_MODE;
        delete panelAttributes["inert"];
        delete panelAttributes["aria-hidden"];
        liftConcealment(panel);

        attributes["popovertarget"] = panelId;
        /* The browser maintains `aria-expanded` on a popover invoker itself; a captured literal
           would be a second, stale writer of the same fact. */
        delete attributes["aria-expanded"];

        claimed.add(panel);
        result.converted += 1;
      }
    }

    for (const child of childrenOf(node)) {
      visit(child, [...ancestry, node]);
    }
  };

  visit(root, []);
  return result;
}
