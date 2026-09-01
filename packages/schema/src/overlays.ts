/**
 * Popover correctness rules — one implementation, shared by every surface that judges a document.
 *
 * The HTML Popover API is expressed in Jx entirely through `attributes` and nested `style` keys, so
 * nothing in the toolchain had an opinion about it and three shipped sites drifted into three
 * different wrong answers. These rules are that opinion, and they live in `@jxsuite/schema` because
 * they are facts about a document TREE — no DOM, no renderer, no cascade — which is what lets the
 * Studio's Problems report, `jx build` and the starter conformance test all reach them without any
 * of the three depending on the other two.
 *
 * Two findings here are not intuitions; they are the two defects that actually shipped:
 *
 * 1. **`display` in a popover's base rule.** The UA sheet hides a closed popover with
 *    `[popover]:not(:popover-open) { display: none }`. That rule is UA-origin, so ANY author
 *    `display` beats it at any specificity, and the panel is laid out on every page whether open or
 *    not — usually parked off the side of the viewport by the `transform` that was meant to animate
 *    it. Nothing looks wrong until you scroll sideways or read the page with a screen reader.
 * 2. **`popovertarget` on an `<a>`.** `popovertarget` and `popovertargetaction` come from the
 *    `PopoverTargetAttributes` IDL mixin, which HTML includes into `HTMLButtonElement` and
 *    `HTMLInputElement` and into NOTHING else. On any other element they parse and do nothing. They
 *    look like they work because a link inside an open popover dismisses it by navigating away — an
 *    alibi that fails for `target="_blank"` and for a same-document `#hash`, both of which exist in
 *    the fleet today.
 *
 * @docs framework/concepts/overlays
 */

import { getNestedStyle, isJsonObject, isNestedStyle } from "./guards";
import type { JxElement, JxStyle } from "../types";

/**
 * The three keywords the `popover` attribute accepts.
 *
 * It is an ENUMERATED attribute, not a boolean one: the missing-value default is `auto` (so a bare
 * `popover` and `popover=""` are both auto popovers) and the **invalid**-value default is `manual`.
 * That asymmetry is why `popover="true"` is a silent defect rather than a loud one — it parses, and
 * the popover simply stops light-dismissing and stops answering Escape.
 */
export const POPOVER_MODES = ["auto", "manual", "hint"] as const;

/**
 * The only two elements that can invoke a popover.
 *
 * Verified against the committed WHATWG IDL (`@webref/idl/html.idl`): `PopoverTargetAttributes` is
 * `includes`d into `HTMLInputElement` and `HTMLButtonElement`, and no third interface.
 */
export const POPOVER_INVOKER_TAGS: ReadonlySet<string> = new Set(["button", "input"]);

/** The house spelling. `""` means the same thing but renders as "unset" in the Studio inspector. */
export const POPOVER_DEFAULT_MODE = "auto";

/** Every rule this module can report. One id per defect, stable enough for a Problem key. */
export type PopoverRule =
  | "base-display"
  | "breakpoint-display"
  | "base-visibility"
  | "invoker-not-button"
  | "invalid-mode"
  | "target-missing"
  | "target-mismatch"
  | "no-invoker"
  | "no-open-rule"
  | "no-open-display"
  | "cut-exit"
  | "link-does-not-dismiss"
  | "unsafe-anchor";

/**
 * The mechanical repair a finding can carry, or absent when the fix is a judgement.
 *
 * `display` moves the declaration into `:popover-open`; `open-display` adds the one the layout
 * implies; `invoker` removes two attributes that do nothing; `mode` writes the house spelling.
 * Everything else — which popover a link should target, whether a `#hash` belongs in a drawer — is
 * a content decision, and a button that guesses at one is worse than no button (ATAG B.3.2's
 * point).
 */
export type PopoverFix = "display" | "open-display" | "invoker" | "mode";

/** A path into the document, in the same segment vocabulary the studio's `JxPath` uses. */
export type PopoverPath = (string | number)[];

export interface PopoverDefect {
  rule: PopoverRule;
  /** Where the defect is, so a repair can address the node without searching for it again. */
  path: PopoverPath;
  /** One sentence naming what is wrong, in the author's language. */
  message: string;
  /** Why it is wrong and what to do instead. */
  detail: string;
  /** `error` is certainly broken; `warn` is very probably not what was meant. */
  severity: "error" | "warn";
  fix?: PopoverFix;
}

// ─── Reading a node ─────────────────────────────────────────────────────────────

/** The attribute bag, whatever shape the author wrote it in. */
function attrs(node: JxElement): Record<string, unknown> {
  return isJsonObject(node.attributes) ? (node.attributes as Record<string, unknown>) : {};
}

/** An attribute's literal string value, or null when absent or bound. */
function literalAttr(node: JxElement, name: string): string | null {
  const value = attrs(node)[name];
  return typeof value === "string" ? value : null;
}

/** The element's tag, lowercased, or "" when it is a tag expression or absent. */
function tagOf(node: JxElement): string {
  return typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
}

/** How the author addresses this node in a message: its id if it has one, else its tag. */
function labelOf(node: JxElement): string {
  const id = typeof node.id === "string" ? node.id : literalAttr(node, "id");
  if (id) {
    return `#${id}`;
  }
  const tag = tagOf(node);
  return tag === "" ? "the popover" : `the <${tag}>`;
}

/**
 * The popover mode this node declares, or null when it is not a popover.
 *
 * Returns the RAW value rather than a normalised one, because the difference between `""`, `"auto"`
 * and `true` is exactly what two of the rules below are about. A bound value (`{"$ref": …}` or a
 * `"${…}"` template) answers `null` for the mode but still counts as a popover — see
 * {@link isPopover} — because the lint must not accuse an author of a defect it cannot see.
 */
export function popoverModeOf(node: JxElement): string | null {
  const raw = attrs(node).popover;
  return typeof raw === "string" ? raw : null;
}

/** Whether the node declares `popover` at all, however it was written. */
export function isPopover(node: JxElement): boolean {
  return "popover" in attrs(node);
}

/** The node's own `id`, from either the top-level key or the attribute bag. */
function idOf(node: JxElement): string | null {
  if (typeof node.id === "string" && node.id !== "") {
    return node.id;
  }
  const attr = literalAttr(node, "id");
  return attr === "" ? null : attr;
}

// ─── Walking a document ─────────────────────────────────────────────────────────

interface Visit {
  node: JxElement;
  path: PopoverPath;
  /** The nearest enclosing popover, so an invoker can be judged against the panel it sits in. */
  enclosing: JxElement | null;
}

/**
 * Every element in the tree, with its path, in document order.
 *
 * Descends `children` (including a repeater's `map` template) and `$switch` `cases`, matching the
 * reach of `a11y-report.ts`'s own walk. The path segments are the ones the studio's mutators
 * address a node by, so a repair can be applied without a second search.
 *
 * @param root The document or subtree to walk.
 * @yields {Visit} Each element, its path, and the popover it is inside (if any).
 */
function* walk(
  root: JxElement,
  path: PopoverPath = [],
  enclosing: JxElement | null = null,
): Generator<Visit> {
  yield { enclosing, node: root, path };
  const inside = isPopover(root) ? root : enclosing;
  const { children } = root;
  if (Array.isArray(children)) {
    for (const [index, child] of children.entries()) {
      if (child && typeof child === "object") {
        yield* walk(child as JxElement, [...path, "children", index], inside);
      }
    }
  } else if (isJsonObject(children) && isJsonObject((children as JxElement).map)) {
    yield* walk((children as JxElement).map as JxElement, [...path, "children", "map"], inside);
  }
  const template = isJsonObject(root.map) ? (root.map as JxElement) : null;
  if (template) {
    yield* walk(template, [...path, "map"], inside);
  }
  const cases = isJsonObject(root.cases) ? (root.cases as Record<string, JxElement>) : {};
  for (const [key, branch] of Object.entries(cases)) {
    if (branch && typeof branch === "object") {
      yield* walk(branch, [...path, "cases", key], inside);
    }
  }
}

/**
 * Every `id` in the document that carries `popover`.
 *
 * The Studio's `popovertarget` picker offers exactly this list. It is the OPEN DOCUMENT only, and
 * deliberately so: a `popovertarget` resolves in the rendered DOM, and a page composes components
 * whose internals this document cannot see. The picker therefore offers what it can prove and never
 * refuses what it cannot — which is also why {@link findPopoverDefects}'s `target-missing` rule only
 * fires in a document that declares at least one popover of its own.
 *
 * @param doc The document to scan.
 * @returns The ids, in document order, without duplicates.
 */
export function popoverIdsIn(doc: JxElement): string[] {
  const ids: string[] = [];
  for (const { node } of walk(doc)) {
    if (!isPopover(node)) {
      continue;
    }
    const id = idOf(node);
    if (id !== null && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Whether the document declares any popover at all.
 *
 * What "is this command available?" asks. Availability has to be a fact about the DOCUMENT rather
 * than about the selection: a caller may name a popover explicitly — the palette, the assistant, a
 * screenshot step — and gating on the selection would refuse those before they were read. The
 * specific refusal ("that path is not a popover") belongs to the run, where the argument exists.
 *
 * @param doc The document to scan.
 * @returns True when at least one node declares `popover`.
 */
export function documentHasPopover(doc: JxElement): boolean {
  for (const { node } of walk(doc)) {
    if (isPopover(node)) {
      return true;
    }
  }
  return false;
}

// ─── Style inspection ───────────────────────────────────────────────────────────

/** Whether a style key names an at-rule group (`@--md`, `@(print)`, `@starting-style`). */
function isAtRule(key: string): boolean {
  return key.startsWith("@");
}

/** Whether a style key names a nested selector rather than a property. */
function isSelector(key: string): boolean {
  return key.startsWith(":") || key.startsWith("&") || key.startsWith(".") || key.startsWith("[");
}

/** A scalar style value as text, or null when the key is absent or holds a nested block. */
function scalar(style: JxStyle | undefined, prop: string): string | null {
  const value = style?.[prop];
  if (value === undefined || isNestedStyle(value)) {
    return null;
  }
  return String(value);
}

/**
 * Whether any nested selector under `style` declares `display`.
 *
 * Accepts both spellings of the open state — `":popover-open"` and `"&:popover-open"` compile to
 * the same selector — and looks one at-rule deep, because `@--md { ":popover-open": {…} }` is a
 * legitimate place to put a breakpoint-specific open display.
 */
function declaresOpenDisplay(style: JxStyle | undefined): boolean {
  /* `?? {}` rather than an early return: a bare popover with no style at all reaches here, and a
     guard clause for it would be a branch no test can distinguish from the empty-object case. */
  for (const [key, value] of Object.entries(style ?? {})) {
    if (!isNestedStyle(value)) {
      continue;
    }
    if (isSelector(key) && key.includes(":popover-open") && scalar(value, "display") !== null) {
      return true;
    }
    if (isAtRule(key) && declaresOpenDisplay(value)) {
      return true;
    }
  }
  return false;
}

/** Whether any nested selector under `style` is a `:popover-open` rule, whatever it declares. */
function declaresOpenRule(style: JxStyle | undefined): boolean {
  /* `?? {}` rather than an early return: a bare popover with no style at all reaches here, and a
     guard clause for it would be a branch no test can distinguish from the empty-object case. */
  for (const [key, value] of Object.entries(style ?? {})) {
    if (!isNestedStyle(value)) {
      continue;
    }
    if (isSelector(key) && key.includes(":popover-open")) {
      return true;
    }
    if (isAtRule(key) && declaresOpenRule(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Properties that only mean anything under `display: flex` or `display: grid`.
 *
 * The list is short on purpose: each of these is inert under `display: block`, so declaring one is
 * a statement about the box the author expects. `gap` is the exception that earns its place — it
 * applies to multi-column layout too, but on a popover panel it never means that.
 */
const BOX_LAYOUT_PROPS = [
  "flexDirection",
  "flex-direction",
  "alignItems",
  "align-items",
  "justifyContent",
  "justify-content",
  "flexWrap",
  "flex-wrap",
  "gridTemplateColumns",
  "grid-template-columns",
  "gridTemplateRows",
  "grid-template-rows",
  "gap",
];

/** Whether the base rule is written for a flex or grid box. */
function usesBoxLayout(style: JxStyle | undefined): boolean {
  return BOX_LAYOUT_PROPS.some((prop) => scalar(style, prop) !== null);
}

/** The at-rule keys under `style` whose block sets `display` directly. */
function breakpointsSettingDisplay(style: JxStyle | undefined): string[] {
  if (!style) {
    return [];
  }
  const keys: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (isAtRule(key) && isNestedStyle(value) && scalar(value, "display") !== null) {
      keys.push(key);
    }
  }
  return keys;
}

/** Every transition value declared on the element, base rule and at-rule blocks alike. */
function transitionValues(style: JxStyle | undefined): string[] {
  if (!style) {
    return [];
  }
  const out: string[] = [];
  const own = scalar(style, "transition");
  if (own !== null) {
    out.push(own);
  }
  for (const [key, value] of Object.entries(style)) {
    if (isAtRule(key) && isNestedStyle(value)) {
      out.push(...transitionValues(value));
    }
  }
  return out;
}

/** Whether the element positions itself with CSS anchor positioning. */
function usesAnchorPositioning(style: JxStyle | undefined): boolean {
  if (!style) {
    return false;
  }
  if (scalar(style, "positionAnchor") !== null || scalar(style, "position-anchor") !== null) {
    return true;
  }
  return ["top", "left", "right", "bottom", "inset", "insetBlockStart", "insetInlineStart"].some(
    (prop) => (scalar(style, prop) ?? "").includes("anchor("),
  );
}

/**
 * Whether an anchor-positioned element has something to fall back on.
 *
 * `position-area` and `position-try-fallbacks` degrade to nothing rather than to `auto`, and a
 * `@supports` block can restate the position without anchors. A bare `top: anchor(bottom)` has
 * neither: when `anchor()` does not resolve the inset computes to `auto`, and a `position: fixed`
 * box with four `auto` insets falls back to its STATIC position — which, for a panel declared
 * inside a header, is in the middle of the header.
 */
function hasAnchorFallback(style: JxStyle | undefined): boolean {
  if (!style) {
    return false;
  }
  if (
    scalar(style, "positionArea") !== null ||
    scalar(style, "position-area") !== null ||
    scalar(style, "positionTryFallbacks") !== null ||
    scalar(style, "position-try-fallbacks") !== null
  ) {
    return true;
  }
  return Object.keys(style).some((key) => key.startsWith("@supports"));
}

// ─── The rules ──────────────────────────────────────────────────────────────────

const DOCS = "See docs/framework/concepts/overlays.";

/**
 * Every popover defect in a document, in document order.
 *
 * One walk. The popover ids are collected on the way, so an invoker naming an id that appears later
 * in the tree still resolves — the rules are about the document, not about reading order.
 *
 * @param doc The document to check.
 * @returns The defects, most structural first within each node.
 */
export function findPopoverDefects(doc: JxElement): PopoverDefect[] {
  const visits = [...walk(doc)];
  const ids = popoverIdsIn(doc);
  const hasAnyPopover = visits.some(({ node }) => isPopover(node));
  const targeted = new Set<string>();
  for (const { node } of visits) {
    if (POPOVER_INVOKER_TAGS.has(tagOf(node))) {
      const target = literalAttr(node, "popovertarget");
      if (target !== null) {
        targeted.add(target);
      }
    }
  }

  const defects: PopoverDefect[] = [];
  for (const { enclosing, node, path } of visits) {
    defects.push(...invokerDefects(node, path, enclosing, ids, hasAnyPopover));
    if (isPopover(node)) {
      defects.push(...panelDefects(node, path, targeted));
    }
  }
  return defects;
}

/** The rules that judge an element carrying `popovertarget`, or a link inside a panel. */
function invokerDefects(
  node: JxElement,
  path: PopoverPath,
  enclosing: JxElement | null,
  ids: string[],
  hasAnyPopover: boolean,
): PopoverDefect[] {
  const out: PopoverDefect[] = [];
  const tag = tagOf(node);
  const target = literalAttr(node, "popovertarget");

  if (target !== null && !POPOVER_INVOKER_TAGS.has(tag)) {
    out.push({
      detail:
        "`popovertarget` and `popovertargetaction` come from the `PopoverTargetAttributes` IDL " +
        "mixin, which HTML includes into `HTMLButtonElement` and `HTMLInputElement` and into " +
        "nothing else. Elsewhere they parse and do nothing. A link inside an open popover " +
        "dismisses it by navigating away, which is why this looks like it works — but it does " +
        `not for a new tab or a same-page fragment. Remove both attributes. ${DOCS}`,
      fix: "invoker",
      message: `<${tag || "element"}> carries popovertarget, which only <button> and <input> support.`,
      path,
      rule: "invoker-not-button",
      severity: "error",
    });
    return out;
  }

  if (target !== null) {
    if (hasAnyPopover && !ids.includes(target)) {
      const known =
        ids.length > 0 ? `The popovers here are: ${ids.map((id) => `"${id}"`).join(", ")}. ` : "";
      out.push({
        detail:
          `No element in this document declares \`popover\` with the id "${target}". ${known}` +
          `A target that names nothing does nothing, silently. ${DOCS}`,
        message: `popovertarget="${target}" names no popover in this document.`,
        path,
        rule: "target-missing",
        severity: "error",
      });
    } else if (enclosing !== null && idOf(enclosing) !== null && idOf(enclosing) !== target) {
      out.push({
        detail:
          `This control is inside ${labelOf(enclosing)} but targets "${target}". Dismissing a ` +
          "different popover leaves the one the reader is looking at open. This is usually a " +
          `copy-paste between two panels in the same file. ${DOCS}`,
        message: `A control inside ${labelOf(enclosing)} targets "${target}" instead.`,
        path,
        rule: "target-mismatch",
        severity: "warn",
      });
    }
  }

  if (tag === "a" && enclosing !== null && target === null) {
    const href = literalAttr(node, "href") ?? (typeof node.href === "string" ? node.href : null);
    const blank = literalAttr(node, "target") === "_blank";
    const fragment = href !== null && href.includes("#");
    if (blank || fragment) {
      const why = blank
        ? "it opens a new tab, so the panel stays open on the page behind it. "
        : "it is a same-document fragment, so the page scrolls behind the open panel. ";
      out.push({
        detail:
          `A link inside a panel normally dismisses it by navigating away. This one does not: ${why}` +
          "There is no declarative fix — a link cannot carry `popovertarget`. Move it out of the " +
          `panel, make it a <button>, or accept it deliberately. ${DOCS}`,
        message: `A link inside ${labelOf(enclosing)} does not dismiss it.`,
        path,
        rule: "link-does-not-dismiss",
        severity: "warn",
      });
    }
  }
  return out;
}

/** The rules that judge the panel itself. */
function panelDefects(
  node: JxElement,
  path: PopoverPath,
  targeted: ReadonlySet<string>,
): PopoverDefect[] {
  const out: PopoverDefect[] = [];
  const { style } = node;
  const label = labelOf(node);
  const mode = popoverModeOf(node);

  if (mode !== null && mode !== "" && !(POPOVER_MODES as readonly string[]).includes(mode)) {
    out.push({
      detail:
        "`popover` is an enumerated attribute taking `auto`, `manual` or `hint`. Anything else " +
        "falls back to the invalid-value default `manual`, which gives up light dismiss and gives " +
        `up Escape — so the panel opens and there is no way to close it. Write "auto". ${DOCS}`,
      fix: "mode",
      message: `${label} declares popover="${mode}", which is not one of auto, manual or hint.`,
      path,
      rule: "invalid-mode",
      severity: "error",
    });
  } else if (typeof attrs(node).popover === "boolean") {
    out.push({
      detail:
        "`popover` carries its value in its text, so a boolean is not the right shape. Written " +
        'as `true` it reaches two of the compiler\'s emitters as `popover="true"`, which is not ' +
        "one of the three keywords, so HTML falls back to `manual`: no light dismiss, no Escape, " +
        `and the trigger stops toggling. Write "auto". ${DOCS}`,
      fix: "mode",
      message: `${label} writes popover as a boolean.`,
      path,
      rule: "invalid-mode",
      severity: "error",
    });
  }

  const baseDisplay = scalar(style, "display");
  if (baseDisplay !== null) {
    out.push({
      detail:
        "A closed popover is hidden by the browser's own `[popover]:not(:popover-open) { display: " +
        "none }`. That rule is UA-origin, so any author `display` beats it at any specificity, and " +
        "the panel is laid out on every page whether it is open or not — usually parked off the " +
        "side of the viewport by the transform meant to animate it, so nothing looks wrong until " +
        `you scroll sideways. \`display\` belongs in \`:popover-open\` and nowhere else. ${DOCS}`,
      fix: "display",
      message: `${label} sets display in its base rule.`,
      path,
      rule: "base-display",
      severity: "error",
    });
  }

  for (const key of breakpointsSettingDisplay(style)) {
    out.push({
      detail:
        `The same defect as a base \`display\`, arriving through \`${key}\` and therefore only at ` +
        "one width — which is what makes it hard to see. Gate the TRIGGER on a breakpoint, never " +
        `the panel: the popover mechanism is what hides the panel. ${DOCS}`,
      fix: "display",
      message: `${label} sets display inside ${key}.`,
      path,
      rule: "breakpoint-display",
      severity: "error",
    });
  }

  if (scalar(style, "visibility") !== null) {
    out.push({
      detail:
        "A second hiding mechanism the browser already provides. Once `display` leaves the base " +
        "rule this one only adds a frame of flicker on open, and it hides the element from " +
        `assistive technology in a way \`display: none\` already did. ${DOCS}`,
      fix: "display",
      message: `${label} also hides itself with visibility.`,
      path,
      rule: "base-visibility",
      severity: "warn",
    });
  }

  if (!declaresOpenRule(style)) {
    out.push({
      detail:
        "Nothing changes when it opens, so no transition on it can run and — if `display` is not " +
        "in the base rule — the panel has no `display` at all while open. This is usually a panel " +
        `that was styled before it was made a popover. ${DOCS}`,
      message: `${label} has no :popover-open rule.`,
      path,
      rule: "no-open-rule",
      severity: "warn",
    });
  } else if (!declaresOpenDisplay(style) && baseDisplay === null && usesBoxLayout(style)) {
    /* Narrow deliberately. "The open rule sets no display" fires on every panel that is happy with
       the UA's `display: block` — which is two of jxsuite.com's three, so as a bare rule it was
       noise on the one site that gets popovers right. It is only a defect when the base rule is
       ALREADY written for flex or grid, because then nothing ever turns that layout on. */
    out.push({
      detail:
        `${label} declares flex or grid properties, but neither its base rule nor its ` +
        "`:popover-open` rule sets a `display` for them to apply to — and the base rule must not " +
        "(that is what keeps the closed panel hidden). So it opens with the UA's `display: block` " +
        `and the layout silently does nothing. Put \`display: flex\` in \`:popover-open\`. ${DOCS}`,
      fix: "open-display",
      message: `${label} is laid out with flex or grid but never sets display.`,
      path,
      rule: "no-open-display",
      severity: "error",
    });
  }

  for (const value of transitionValues(style)) {
    if (value.includes("display") && !value.includes("overlay")) {
      out.push({
        detail:
          "`display …allow-discrete` keeps the box alive while it animates out; `overlay " +
          "…allow-discrete` is what keeps it in the TOP LAYER for those same milliseconds. " +
          "Without it the panel drops behind the page content and the backdrop disappears a frame " +
          `early, so the exit reads as a flicker rather than an animation. ${DOCS}`,
        message: `${label} transitions display but not overlay.`,
        path,
        rule: "cut-exit",
        severity: "warn",
      });
      break;
    }
  }

  if (usesAnchorPositioning(style) && !hasAnchorFallback(style)) {
    out.push({
      detail:
        "When `anchor()` does not resolve, every inset it feeds computes to `auto` — and a " +
        "`position: fixed` box with four `auto` insets falls back to its STATIC position, which " +
        "for a panel declared inside a header is in the middle of the header. Use `position-area` " +
        "with `position-try-fallbacks`, or add a `@supports` block that positions it without " +
        `anchors. ${DOCS}`,
      message: `${label} is anchor-positioned with no fallback.`,
      path,
      rule: "unsafe-anchor",
      severity: "warn",
    });
  }

  const id = idOf(node);
  if (id !== null && !targeted.has(id)) {
    out.push({
      detail:
        "No `<button>` or `<input>` in this document names it with `popovertarget`. If it is " +
        "opened from another file or from a function that calls `showPopover()`, this is fine; " +
        `otherwise there is no way for a reader to open it. ${DOCS}`,
      message: `${label} has no invoker in this document.`,
      path,
      rule: "no-invoker",
      severity: "warn",
    });
  }
  return out;
}

export interface PopoverDisplayRepair {
  /** Properties to delete from the popover's BASE rule. */
  base: string[];
  /** At-rule keys (`@--md`, …) whose block should lose its own `display`. The block itself stays. */
  breakpoints: string[];
  /** The `display` value to write into `:popover-open`, or null when it already declares one. */
  openDisplay: string | null;
}

/**
 * The style edit that repairs a `base-display` / `breakpoint-display` / `base-visibility` finding.
 *
 * Pure, and returned as data rather than applied, because the two callers write documents very
 * differently: the Studio goes through `transactDoc` so the move is one undo step, and a CLI fixer
 * would rewrite JSON on disk. Both need the same ANSWER — which declaration moves where — and that
 * answer is the part worth having one of.
 *
 * `null` when there is nothing to move. When `:popover-open` already declares a `display`, the base
 * one is deleted and the existing open value kept: the open state is the author's intent and the
 * base rule is the accident.
 *
 * @param style The popover's own style object.
 * @returns The properties to remove from the base rule, and the value to write into
 *   `:popover-open`.
 */
export function popoverDisplayRepair(style: JxStyle | undefined): PopoverDisplayRepair | null {
  if (!style) {
    return null;
  }
  const base: string[] = [];
  if (scalar(style, "display") !== null) {
    base.push("display");
  }
  if (scalar(style, "visibility") !== null) {
    base.push("visibility");
  }
  const breakpoints = breakpointsSettingDisplay(style);
  if (base.length === 0 && breakpoints.length === 0) {
    return null;
  }
  const existing =
    getNestedStyle(style, ":popover-open") ?? getNestedStyle(style, "&:popover-open");
  const openDisplay =
    scalar(existing, "display") !== null ? null : (scalar(style, "display") ?? null);
  return { base, breakpoints, openDisplay };
}
