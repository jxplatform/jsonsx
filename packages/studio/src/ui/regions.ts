/// <reference lib="dom" />
/**
 * Regions — the shell's addressable surfaces, in one id space.
 *
 * `shell.ts` declares `FocusRegion = "rail" | "navigator" | "pane" | "inspector" | "dock" |
 * "status"` and has done since the shell record landed. It is an enum with **no DOM counterpart**:
 * nothing can be asked where the Navigator _is_, so nothing can move focus into it, cycle to the
 * next one, or measure it. Three consumers want exactly that map — F6 region cycling, focus
 * restoration after a toast or a Problems jump, and the screenshot pipeline, which today addresses
 * the shell through sixteen CSS selectors, seven of which name nodes the shell redesign deletes.
 *
 * **The grammar** (UX-REDESIGN-PLAN §13.2) is `<surface>[.<instance>][/<part>]`:
 *
 * ```text
 * navigator                     the Navigator dock
 * navigator/panel:git           the Source Control panel inside it
 * navigator/panel:git/commit    a leaf within that panel
 * inspector/tab:style           the Style tab's body
 * inspector/field:href          a field row (ui/field-row.ts already emits `data-prop`)
 * pane.primary/tabs             the primary pane's own tab strip
 * overlay.dialog:settings       a named overlay slot
 * ```
 *
 * **Ids are DERIVED, not authored**, which is the property that makes them survive a rename. The
 * panel host stamps `navigator/panel:${id}` once and every panel gets a region for free; the
 * inspector stamps `inspector/tab:${key}` from its own tab records; `getLayerSlot()` stamps
 * `overlay.<kind>:<id>` from the key it already builds. A panel rename then propagates to the
 * region automatically, and a stale id fails the shot contract instead of photographing the wrong
 * box. Only leaves — `navigator/panel:git/commit` — are hand-stamped, and those are counted.
 *
 * Resolution reads the live DOM rather than a registration table, for the same reason
 * {@link import("./layers").isModalOpen} does: whatever is on screen is the answer, and there is no
 * bookkeeping for a new surface to forget.
 */

import type { FocusRegion } from "../shell";

/** The attribute every region carries. One attribute, one grammar, one resolver. */
export const REGION_ATTR = "data-jx-region";

/** The eight surfaces §13.2 declares. A region id always begins with one of these. */
export const REGION_SURFACES = [
  "rail",
  "navigator",
  "inspector",
  "pane",
  "dock.bottom",
  "statusbar",
  "commandbar",
  "overlay",
] as const;

export type RegionSurface = (typeof REGION_SURFACES)[number];

/** A parsed region id. `instance` and `part` are absent for a bare surface. */
export interface ParsedRegionId {
  surface: RegionSurface;
  /** `primary` in `pane.primary`, `dialog` in `overlay.dialog:settings`. */
  instance?: string;
  /** Everything after the first `/` — `panel:git/commit` in `navigator/panel:git/commit`. */
  part?: string;
}

/**
 * `dock.bottom` is the one surface whose name contains the instance separator, so the split is
 * longest-prefix rather than "up to the first dot".
 */
const DOTTED_SURFACES = new Set<string>(["dock.bottom"]);

/**
 * Parse a region id, or return `null` when it is not one.
 *
 * Rejecting is the point: the resolver never falls back to `querySelector(id)`, so a CSS selector
 * that slips into a manifest resolves to nothing instead of quietly working.
 */
export function parseRegionId(id: string): ParsedRegionId | null {
  const slash = id.indexOf("/");
  const head = slash === -1 ? id : id.slice(0, slash);
  const part = slash === -1 ? undefined : id.slice(slash + 1);
  if (part === "" || head === "") {
    return null;
  }

  let surface = head;
  let instance: string | undefined;
  if (!DOTTED_SURFACES.has(head)) {
    const dot = head.indexOf(".");
    if (dot !== -1) {
      surface = head.slice(0, dot);
      instance = head.slice(dot + 1);
      if (instance === "") {
        return null;
      }
    }
  }
  if (!(REGION_SURFACES as readonly string[]).includes(surface)) {
    return null;
  }
  return instance === undefined
    ? part === undefined
      ? { surface: surface as RegionSurface }
      : { part, surface: surface as RegionSurface }
    : part === undefined
      ? { instance, surface: surface as RegionSurface }
      : { instance, part, surface: surface as RegionSurface };
}

/** Whether a string is a well-formed region id. */
export function isRegionId(id: string): boolean {
  return parseRegionId(id) !== null;
}

/**
 * `pane` names the primary pane.
 *
 * The second pane arrives with the pane grid, and every id minted before it should keep meaning
 * what it meant — so the alias is declared here once rather than at each call site.
 */
function canonicalRegionId(id: string): string {
  if (id === "pane") {
    return "pane.primary";
  }
  return id.startsWith("pane/") ? `pane.primary/${id.slice(5)}` : id;
}

/** Where the search runs. Injectable so a test can resolve inside a detached tree. */
type RegionRoot = Pick<ParentNode, "querySelectorAll">;

function regionRoot(root?: RegionRoot): RegionRoot {
  return root ?? document;
}

/**
 * Ids answered by an attribute the app ALREADY emits, rather than by a `data-jx-region` stamp.
 *
 * `ui/field-row.ts` has emitted `data-prop=${prop}` on every inspector row since it landed, and the
 * screenshot manifest has been addressing `#right-panel [data-prop='href']` through it for as long.
 * Restamping several hundred rows with a second attribute saying the same thing would be pure
 * duplication, so the grammar reads the existing one — `inspector/field:href` is the id, and the
 * precedent is the reason that part of the grammar was specified the way it was.
 */
const DERIVED_RESOLVERS: readonly {
  pattern: RegExp;
  locate: (match: RegExpMatchArray, root: RegionRoot) => HTMLElement[];
}[] = [
  {
    locate: ([, prop], root) => {
      const inspector = resolveRegion("inspector", root);
      return inspector
        ? [...inspector.querySelectorAll<HTMLElement>(`[data-prop="${CSS.escape(prop!)}"]`)]
        : [];
    },
    pattern: /^inspector\/field:(.+)$/,
  },
];

/**
 * Every element currently carrying `id`, in document order.
 *
 * Plural because overlays legitimately stack: two popovers open at once both used to match
 * `sp-popover[open]`, and the shot cropped whichever the DOM happened to list first. An id that
 * addresses several elements is answerable — `resolve` takes the last, which is the topmost.
 */
export function resolveAllRegions(id: string, root?: RegionRoot): HTMLElement[] {
  const canonical = canonicalRegionId(id);
  if (!isRegionId(canonical)) {
    return [];
  }
  const stamped = [
    ...regionRoot(root).querySelectorAll<HTMLElement>(
      `[${REGION_ATTR}="${CSS.escape(canonical)}"]`,
    ),
  ];
  if (stamped.length > 0) {
    return stamped;
  }
  for (const resolver of DERIVED_RESOLVERS) {
    const match = canonical.match(resolver.pattern);
    if (match) {
      return resolver.locate(match, regionRoot(root));
    }
  }
  return [];
}

/**
 * The element a region id addresses right now, or `null`.
 *
 * The LAST match wins, because the only ids that repeat are overlay slots and the last one appended
 * is the one on top.
 */
export function resolveRegion(id: string, root?: RegionRoot): HTMLElement | null {
  const all = resolveAllRegions(id, root);
  return all.at(-1) ?? null;
}

/** Every region id present in the DOM, deduplicated and sorted — the map, enumerated. */
export function listRegions(root?: RegionRoot): string[] {
  const ids = new Set<string>();
  for (const el of regionRoot(root).querySelectorAll<HTMLElement>(`[${REGION_ATTR}]`)) {
    const id = el.getAttribute(REGION_ATTR);
    if (id && isRegionId(id)) {
      ids.add(id);
    }
  }
  return [...ids].toSorted();
}

/** The region id nearest ancestor-or-self of `el` declares, or `null`. */
export function regionIdOf(el: Element | null): string | null {
  const host = el?.closest(`[${REGION_ATTR}]`);
  const id = host?.getAttribute(REGION_ATTR) ?? null;
  return id && isRegionId(id) ? id : null;
}

// ─── The FocusRegion ↔ region-id map ─────────────────────────────────────────

/**
 * `shell.focusRegion`'s six values, as region ids.
 *
 * This is the map that made the enum inert: the shell could say which region had focus and nothing
 * could act on it. With it, "focus the Navigator" is `resolveRegion(REGION_FOR_FOCUS.navigator)`,
 * and F6 is a walk over `Object.keys`.
 */
export const REGION_FOR_FOCUS: Readonly<Record<FocusRegion, string>> = {
  dock: "dock.bottom",
  inspector: "inspector",
  navigator: "navigator",
  pane: "pane.primary",
  rail: "rail",
  status: "statusbar",
};

const FOCUS_FOR_SURFACE: Readonly<Record<string, FocusRegion>> = {
  "dock.bottom": "dock",
  inspector: "inspector",
  navigator: "navigator",
  pane: "pane",
  rail: "rail",
  statusbar: "status",
};

/**
 * Which `shell.focusRegion` an element sits in, or `null` when it is outside every region (an
 * overlay, or a node nobody has stamped).
 *
 * The inverse direction matters as much as the forward one: focus moves for reasons the shell did
 * not initiate — a click, a toast dismissal, restoring the caret after a dialog — and the record
 * has to be able to catch up from the DOM.
 */
export function focusRegionOf(el: Element | null): FocusRegion | null {
  const id = regionIdOf(el);
  if (!id) {
    return null;
  }
  const parsed = parseRegionId(id);
  return parsed ? (FOCUS_FOR_SURFACE[parsed.surface] ?? null) : null;
}

// ─── Stamping ─────────────────────────────────────────────────────────────────

/**
 * The shell's fixed hosts, declared once.
 *
 * These live in `index.html` as bare `<div id>`s, so they cannot stamp themselves the way a panel
 * or an overlay slot does. The table is the shell's own layout stated in region terms, and it is
 * the only place a surface id is written down by hand.
 *
 * `#tab-strip` is addressed as `pane.primary/tabs` deliberately: the region names the PANE's strip,
 * so the id survives the node. `#chat-panel` and `#frontmatter-panel` are named the same way, and
 * the assistant is the case that has now happened: `inspector.assistant` was minted while the chat
 * was still a fifth grid column, and it needed no edit when the column was deleted and the node
 * moved into the Inspector dock's cell — which is the whole argument for naming the role rather
 * than the div. The frontmatter bar is the primary pane's document header, and the same will be
 * true of it when the Document Header card replaces the node.
 */
export const SHELL_REGION_HOSTS: Readonly<Record<string, string>> = {
  "#activity-bar": "rail",
  "#canvas-wrap": "pane.primary",
  "#chat-panel": "inspector.assistant",
  "#frontmatter-panel": "pane.primary/frontmatter",
  "#left-panel": "navigator",
  "#right-panel": "inspector",
  "#statusbar": "statusbar",
  "#tab-strip": "pane.primary/tabs",
  "#toolbar": "commandbar",
};

/**
 * Stamp the shell hosts. Idempotent, and safe to call before the DOM exists (an absent host is
 * simply not stamped — the desktop shell and the tests both boot partial trees).
 */
export function stampShellRegions(root: ParentNode = document): void {
  for (const [selector, id] of Object.entries(SHELL_REGION_HOSTS)) {
    root.querySelector(selector)?.setAttribute(REGION_ATTR, id);
  }
}

/** Region id for a Navigator panel, derived from the panel's own id. */
export function navigatorPanelRegion(panelId: string): string {
  return `navigator/panel:${panelId}`;
}

/** Region id for an Inspector tab, derived from the tab record's value. */
export function inspectorTabRegion(tabId: string): string {
  return `inspector/tab:${tabId}`;
}

/** The overlay instance each layer host contributes: a modal IS a dialog, a popover IS a menu. */
export const OVERLAY_INSTANCE: Readonly<Record<"popover" | "modal" | "dialog", string>> = {
  dialog: "dialog",
  modal: "dialog",
  popover: "menu",
};

/**
 * Region id for an overlay slot.
 *
 * With an `id` this is `overlay.dialog:settings` — derived from the key `getLayerSlot` already
 * builds, so naming a slot names its region. Without one it is the bare instance, which resolves to
 * the topmost open overlay of that kind.
 */
export function overlayRegion(layer: "popover" | "modal" | "dialog", id?: string): string {
  const instance = OVERLAY_INSTANCE[layer];
  return id ? `overlay.${instance}:${id}` : `overlay.${instance}`;
}

/**
 * `regions` — the namespace §13.3 names, gathered so a consumer imports one thing.
 *
 * `probe.regions` is a projection of this; nothing here knows the camera exists.
 */
export const regions = {
  focusRegionOf,
  idOf: regionIdOf,
  list: listRegions,
  parse: parseRegionId,
  resolve: resolveRegion,
  resolveAll: resolveAllRegions,
} as const;
