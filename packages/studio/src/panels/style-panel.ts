/// <reference lib="dom" />
/**
 * Style panel — CSS property editor under the **Target Line** (§6.1), with provenance-coded rows
 * (§6.2), a section accordion, shorthand expand/compress, and a property filter.
 *
 * The panel resolves a compound coordinate before it can commit anything: `(selection, breakpoint,
 * scheme layer, nested selector)`. It has always computed that tuple — it is the per-field key and
 * the five-branch if/else below — and it used to hide it behind three disconnected widgets on two
 * different bars. `target-line.ts` renders it as one sentence instead, and the three widgets are
 * gone: the breakpoint and scheme axes are selected on the pane context bar (region ⑦), and the
 * selector is the one axis this tab owns.
 *
 * Every row then says where its value came from. `provenance.ts` supplies the chip;
 * `computeInheritedSources()` supplies the donor breakpoint the cascade walk always knew and this
 * panel used to throw away.
 */

import { html, nothing } from "lit-html";
import { getNestedStyle } from "@jxsuite/schema/guards";
import { live } from "lit-html/directives/live.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import {
  COMMON_SELECTORS,
  debouncedStyleCommit,
  getNodeAtPath,
  isNestedSelector,
  renderOnly,
  updateUi,
} from "../store";
import { activeTab } from "../workspace/workspace";
import { primarySelection, unifyValues } from "../tabs/selection";
import { shell } from "../shell";
import { activeRegistry } from "../commands/active-registry";
import { selectStylebookTag } from "./stylebook-panel";
import {
  mutateUpdateMediaNestedStyle,
  mutateUpdateMediaNestedStylePath,
  mutateUpdateMediaStyle,
  mutateUpdateNestedStyle,
  mutateUpdateNestedStylePath,
  mutateUpdateStyle,
  transactDoc,
} from "../tabs/transact";
import { inferInputType, propLabel } from "../utils/studio-utils";
import { stringArg } from "../commands/command-args";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import { renderFieldRow } from "../ui/field-row";
import { showPromptDialog } from "../ui/layers";
import { renderDynamicSlot } from "../ui/dynamic-slot";
import { parseMediaEntries, schemeOfQuery } from "../utils/canvas-media";
import { getEffectiveMedia, getEffectiveStyle } from "../site-context";
import { computeInheritedSources } from "../utils/inherited-style";
import { loadUsages, peekUsages, usageFiles } from "../services/references";
import { mediaDisplayName } from "./shared";
import { countProvenance, renderProvenanceChip, renderProvenanceDots } from "./provenance";
import {
  openSelectorMenu,
  renderTargetLine,
  resetSelectorTrigger as resetTargetSelector,
} from "./target-line";
import {
  clickAnythingTo,
  openPageAction,
  renderEmptyState,
  staleSelectionMessage,
} from "./empty-state";
import {
  allConditionsPass,
  autoOpenSections,
  compressBorderSide,
  compressShorthand,
  cssMeta,
  expandBorderSide,
  expandShorthand,
  getCssInitialMap,
  getLonghands,
} from "./style-utils";
import { widgetForType } from "./style-inputs";

import type { FieldProvenance, ProvenanceState } from "./provenance";
import type { TargetScope, TargetSegment } from "./target-line";
import type { Tab } from "../tabs/tab";
import type { JxPath } from "../state";
import type { JsonValue } from "../types";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";

interface CssLonghand {
  name: string;
  entry: Record<string, unknown>;
}

type CssPropertyEntry = Record<string, unknown>;

/** The chip a row wears when its caller has nothing more specific to say. */
const DEFAULT_PROVENANCE: FieldProvenance = { state: "default" };

type StyleMutateFn = (
  t: Tab,
  prop: string,
  val?: string | Record<string, unknown> | undefined,
) => void;

/**
 * Check if a selector is a stylebook tag path (e.g., "table" or "table th"). Tag paths don't start
 * with selector prefixes (`:`, `.`, `&`, `[`, `@`).
 *
 * @param {string} selector
 * @returns {boolean}
 */
function isTagPath(selector: string) {
  return /^[a-z]/.test(selector);
}

/**
 * Resolve a style object by traversing a nested tag path. e.g., "table th" → style["table"]["th"]
 *
 * @param {JxStyle} style
 * @param {string} tagPath
 * @returns {JxStyle}
 */
function resolveNestedTagStyle(style: JxStyle, tagPath: string): JxStyle {
  let obj: JxStyle | undefined = style;
  for (const part of tagPath.split(" ")) {
    obj = getNestedStyle(obj, part);
    if (!obj) {
      return {};
    }
  }
  return obj;
}

/**
 * The style object one compound coordinate addresses.
 *
 * Split out of the panel body because the coordinate has to be resolved TWICE: once against the
 * effective (site-merged) style, which is what the rows display, and once against the document's
 * own, which is what a commit writes. The difference between the two is the "from site tokens"
 * donor — invisible for as long as there was only one resolution.
 *
 * @param {JxStyle} style
 * @param {string | null} activeSelector
 * @param {string | null} editMedia
 * @returns {JxStyle}
 */
function resolveContextStyle(
  style: JxStyle,
  activeSelector: string | null,
  editMedia: string | null,
): JxStyle {
  const base = editMedia ? (getNestedStyle(style, `@${editMedia}`) ?? {}) : style;
  if (activeSelector) {
    return isTagPath(activeSelector)
      ? resolveNestedTagStyle(base, activeSelector)
      : (getNestedStyle(base, activeSelector) ?? {});
  }
  const flat: JxStyle = {};
  for (const [p, v] of Object.entries(base)) {
    if (typeof v !== "object") {
      flat[p] = v;
    }
  }
  return flat;
}

/**
 * The mutation that writes to one compound coordinate — the other half of
 * {@link resolveContextStyle}, and the reason the two now sit side by side: they are one decision
 * expressed twice, and they used to be interleaved in a five-branch `if/else` where a new branch
 * could easily read one coordinate and write another.
 *
 * @param {JxPath} sel
 * @param {string | null} activeSelector
 * @param {string | null} editMedia
 * @returns {StyleMutateFn}
 */
function contextMutate(
  sel: JxPath,
  activeSelector: string | null,
  editMedia: string | null,
): StyleMutateFn {
  if (activeSelector && isTagPath(activeSelector)) {
    const stylePath = activeSelector.split(" ");
    return editMedia
      ? (t, prop, val) =>
          mutateUpdateMediaNestedStylePath(
            t,
            sel,
            editMedia,
            stylePath,
            prop,
            val as string | undefined,
          )
      : (t, prop, val) =>
          mutateUpdateNestedStylePath(t, sel, stylePath, prop, val as string | undefined);
  }
  if (activeSelector) {
    return editMedia
      ? (t, prop, val) =>
          mutateUpdateMediaNestedStyle(
            t,
            sel,
            editMedia,
            activeSelector,
            prop,
            val as string | undefined,
          )
      : (t, prop, val) =>
          mutateUpdateNestedStyle(t, sel, activeSelector, prop, val as string | undefined);
  }
  return editMedia
    ? (t, prop, val) => mutateUpdateMediaStyle(t, sel, editMedia, prop, val as string | undefined)
    : (t, prop, val) => mutateUpdateStyle(t, sel, prop, val as string | undefined);
}

/**
 * Which properties the selected elements disagree about, at the coordinate the tab is editing.
 *
 * Resolved through the SAME `resolveContextStyle` the panel reads its own values with, so "mixed"
 * is decided at exactly the breakpoint, scheme layer and selector the Target Line names — two cards
 * that differ only inside `@md` are not mixed while you are editing Base.
 *
 * Returns an empty set for a selection of one, which is the whole reason a single selection renders
 * no Mixed state anywhere: the loop never finds a second value to disagree with.
 *
 * @param {Tab} tab
 * @param {readonly JxPath[]} targets
 * @param {string | null} activeSelector
 * @param {string | null} editMedia
 * @returns {Set<string>}
 */
function mixedStyleProps(
  tab: Tab,
  targets: readonly JxPath[],
  activeSelector: string | null,
  editMedia: string | null,
): Set<string> {
  const mixed = new Set<string>();
  if (targets.length < 2) {
    return mixed;
  }
  const blocks = targets.map((path) => {
    const node = getNodeAtPath(tab.doc.document, path) as JxMutableNode | undefined;
    return resolveContextStyle(node?.style ?? {}, activeSelector, editMedia);
  });
  const props = new Set<string>();
  for (const block of blocks) {
    for (const prop of Object.keys(block)) {
      props.add(prop);
    }
  }
  for (const prop of props) {
    if (unifyValues(blocks.map((block) => block[prop] ?? null)).mixed) {
      mixed.add(prop);
    }
  }
  return mixed;
}

// ─── Row renderers ──────────────────────────────────────────────────────────

function renderStyleRow(
  entry: CssPropertyEntry,
  prop: string,
  value: string,
  onCommit: (v: string | undefined) => void,
  isWarning: boolean,
  gridMode: boolean,
  inheritedValue: string | undefined,
  templateSignals: string[] = [],
  fieldKey: string = prop,
  provenance?: FieldProvenance,
) {
  const chip: FieldProvenance = provenance ?? DEFAULT_PROVENANCE;
  const type = inferInputType(entry);
  const hasVal = value !== undefined && value !== "";
  const placeholder = !hasVal && inheritedValue ? String(inheritedValue) : "";
  const spanVal = gridMode && (entry as Record<string, unknown>).$span === 2 ? 2 : undefined;
  // The rungs come from `StyleObject.additionalProperties`, not from a list here (§6.6 rule 2).
  // That derives literal + ${} template: a CSS value carrying `${…}` IS a signal binding, which
  // `emitStyleString` compiles to a reactive declaration, and `$ref` is not admitted by JxStyle.
  // Naming the POSITION rather than the answer is the point — a schema that later admits another
  // Rung cannot then be contradicted by a hand-written array sitting here.
  const slot = renderDynamicSlot({
    caps: "styleProperty",
    fieldKey,
    onChange: (v?: JsonValue) => onCommit(v === undefined || v === "" ? undefined : String(v)),
    staticWidget: widgetForType(type, entry, prop, value, onCommit, { placeholder }),
    stateDefs: templateSignals,
    value,
  });
  // `hasValue` is false because the chip supersedes the row's derived set-dot: the dot could only
  // Say set-or-not, and three of the four states this panel can now answer with were previously
  // Indistinguishable from "unset".
  return renderFieldRow({
    prop,
    label: propLabel(entry, prop),
    hasValue: false,
    widget: slot.widget,
    provenance: chip,
    labelExtra: slot.modeButton,
    ...(spanVal != null && { span: spanVal }),
    warning: isWarning,
  });
}

/** What {@link renderShorthandRow} needs to draw one shorthand and its longhand children. */
interface ShorthandRowOptions {
  prop: string;
  entry: CssPropertyEntry;
  /** The style block at the edited coordinate — the primary element's, as every row reads it. */
  style: Record<string, unknown>;
  /** The write, already fanned across the selection. Called INSIDE a transaction. */
  mutate: StyleMutateFn;
  inherited: Record<string, string | number>;
  ctx: ProvenanceCtx;
}

/**
 * A shorthand property row: the header field, plus one row per longhand when it is expanded.
 *
 * Two things were wrong with it, and they were the same thing. It took a single-target mutation
 * while every other row in the tab took the selection-wide one, so "set padding on six cards in one
 * decision" — the sentence §6.5 makes, with padding as its example — wrote to one card. And it drew
 * its own `.set-dot` rather than a provenance chip, so a shorthand `mixedStyleProps` had ALREADY
 * flagged as mixed offered a plain "Clear padding" affordance instead of saying so.
 *
 * Both are fixed by taking the same two things every other row takes: `mutate`, which fans across
 * the selection, and `ctx`, which answers where a value came from.
 */
function renderShorthandRow({
  prop: shortProp,
  entry,
  style,
  mutate,
  inherited,
  ctx,
}: ShorthandRowOptions) {
  const tab = activeTab.value!;
  const longhands = getLonghands(shortProp) as CssLonghand[];
  const shortVal = style[shortProp];
  const hasLonghands = longhands.some((l: CssLonghand) => style[l.name] !== undefined);
  const isExpanded = tab.session.ui.styleShorthands[shortProp] ?? hasLonghands;
  const hasAnyVal = shortVal !== undefined || hasLonghands;

  /**
   * Drop every longhand, then write the shorthand — the one write order this row has.
   *
   * The longhands go unconditionally rather than "the ones the panel can see set", because what the
   * panel can see is the PRIMARY element's style: a second selected element with a `paddingTop` of
   * its own would otherwise keep it and quietly out-rank the shorthand just written over it.
   * Deleting a property an element does not have is a no-op on that element.
   */
  const writeShorthand = (val?: string | undefined) =>
    transactDoc(activeTab.value, (t) => {
      for (const l of longhands) {
        mutate(t, l.name);
      }
      mutate(t, shortProp, val);
    });
  const clearAll = () =>
    transactDoc(activeTab.value, (t) => {
      mutate(t, shortProp);
      for (const l of longhands) {
        mutate(t, l.name);
      }
    });

  const headerWidget = html`
    <div class="style-shorthand-header">
      <sp-textfield
        size="s"
        .value=${live(shortVal || "")}
        placeholder=${
          !shortVal && hasLonghands
            ? longhands.map((l: CssLonghand) => style[l.name] || "0").join(" ")
            : !shortVal && inherited[shortProp]
              ? inherited[shortProp]
              : !shortVal && longhands.some((l: CssLonghand) => inherited[l.name])
                ? longhands.map((l: CssLonghand) => inherited[l.name] || "0").join(" ")
                : ""
        }
        @input=${debouncedStyleCommit(`short:${shortProp}`, 400, (e: Event) => {
          writeShorthand((e.target as HTMLInputElement).value || undefined);
        })}
      ></sp-textfield>
      <sp-action-button
        size="xs"
        quiet
        @click=${(e: Event) => {
          e.stopPropagation();
          activeTab.value!.session.ui.styleShorthands = {
            ...activeTab.value!.session.ui.styleShorthands,
            [shortProp]: !isExpanded,
          };
        }}
      >
        ${
          isExpanded
            ? html`<sp-icon-chevron-down slot="icon"></sp-icon-chevron-down>`
            : html`<sp-icon-chevron-right slot="icon"></sp-icon-chevron-right>`
        }
      </sp-action-button>
    </div>
  `;

  return html`
    ${renderFieldRow({
      prop: shortProp,
      label: propLabel(entry, shortProp),
      hasValue: hasAnyVal,
      widget: headerWidget,
      provenance: shorthandProvenance(shortProp, ctx, hasAnyVal ? clearAll : undefined),
    })}
    ${
      isExpanded
        ? (() => {
            const isBorderSide =
              (entry as Record<string, unknown>).$shorthandType === "border-side";
            const expanded = shortVal
              ? isBorderSide
                ? expandBorderSide(shortVal as string)
                : expandShorthand(shortVal as string, longhands.length)
              : null;
            const compress = isBorderSide ? compressBorderSide : compressShorthand;
            const emptyVal = isBorderSide ? "" : "0";
            /** This longhand becomes `val`; the others keep whatever they show. */
            const recompress = (idx: number, val: string) =>
              writeShorthand(
                compress(
                  longhands.map((l: CssLonghand, i: number) =>
                    i === idx ? val : (style[l.name] ?? (expanded ? expanded[i] : emptyVal)),
                  ) as string[],
                ),
              );
            return longhands.map(({ name, entry: lEntry }: CssLonghand, idx: number) => {
              const lVal = style[name] ?? (expanded ? expanded[idx] : "");
              const hasLVal = lVal !== undefined && lVal !== "";
              return html`
                <div class="style-row style-row--child" data-prop=${name}>
                  <div class="style-row-label">
                    ${renderProvenanceChip(
                      name,
                      longhandProvenance(name, shortProp, hasLVal, ctx, () =>
                        recompress(idx, emptyVal),
                      ),
                    )}
                    <sp-field-label size="s" title=${name}
                      >${propLabel(lEntry, name)}</sp-field-label
                    >
                  </div>
                  ${widgetForType(
                    inferInputType(lEntry),
                    lEntry,
                    name,
                    lVal as string,
                    (newVal: string) => recompress(idx, newVal || emptyVal),
                    {
                      placeholder: !lVal && inherited[name] ? String(inherited[name]) : "",
                    },
                  )}
                </div>
              `;
            });
          })()
        : nothing
    }
  `;
}

// ─── The edit target ─────────────────────────────────────────────────────────

/** Forget the selector menu's element handle — the Inspector unmounted, or a test starts clean. */
export function resetSelectorMenu(): void {
  resetTargetSelector();
}

/**
 * Whether the "show affected" list under a project-wide warning band is open.
 *
 * Module-local rather than a `session.ui` field: it is a disclosure on a project-level warning, and
 * a per-document field would make the same warning open in one tab and closed in another.
 */
let _showAffected = false;

/** Fold the affected list away — the Inspector unmounted, or a test starts clean. */
export function resetAffectedDisclosure(): void {
  _showAffected = false;
}

/**
 * Ask a registered command to do something this panel does not own.
 *
 * The breakpoint and the colour scheme are DEFINED in Project Settings › Contexts and SELECTED on
 * the pane context bar. A Target Line segment that opened its own list would be the third selector
 * §6.4 forbids, so it routes to the definition site through the same command the context bar's
 * "Manage contexts…" footer runs.
 */
function runCommand(id: string, args?: Record<string, unknown>): void {
  void activeRegistry()?.run(id, args);
}

/**
 * The tag a stylebook rule restyles, when one is being edited.
 *
 * In Stylebook the "selector" is a bare tag path (`h1`, `table th`) written into the DOCUMENT's
 * root style, so the first segment of the path is the tag whose blast radius the scope chip
 * states.
 */
function stylebookTagOf(selector: string | null): string | null {
  return selector && isTagPath(selector) ? (selector.split(" ")[0] ?? null) : null;
}

/**
 * Whether this document IS the project's stylesheet.
 *
 * `project.json`'s `style` is not a document's style. The compiler hands it to EVERY route's
 * compile as `projectStyle` (`site/site-build.ts`), and `compileStyles` emits its custom properties
 * as `:root`, its flat properties as `body`, and every bare tag key as a global rule — so `{ "h1":
 * { "color": "red" } }` in project.json becomes `h1 { color: red }` in the stylesheet of every
 * page, reaching inside every component instance too (nothing in the compiler or the runtime
 * attaches a shadow root). Studio shows the same cascade: `getEffectiveStyle` merges the object
 * into every open document.
 *
 * That makes the document Stylebook opens by default the widest blast radius in the app — and it is
 * the one `resolveScope` used to label "in this **document**", the narrowest.
 *
 * Matched by suffix rather than by equality, the way `studio.ts` and `imports-panel.ts` already
 * address this file: a config reached from a sub-directory is still a config, and it still has no
 * elements of its own for "in this document" to be about.
 */
function isProjectStylesheet(path: string): boolean {
  return /(?:^|\/)project\.json$/.test(path);
}

/**
 * How wide an edit here reaches, and — for the project case — how wide, in numbers.
 *
 * Three kinds, in the order a user meets them:
 *
 * - **element** — an element is selected; the rule is scoped to it and to nothing else.
 * - **document** — Stylebook on an ordinary document: every `<tag>` on this page.
 * - **project** — the same keystroke restyles files that are not open. Two documents reach this far:
 *   a LAYOUT, whose root style is inherited by every page declaring it, and
 *   {@link isProjectStylesheet}, which is inherited by all of them.
 *
 * The project stylesheet reaches it with NO tag as well, which no other document does: deselecting
 * in Stylebook leaves the tab editing project.json's own root style — `:root` and `body` on every
 * route — and there is no element anywhere for "this element" to have meant.
 */
function resolveScope(tab: Tab, stylebookTag: string | null): TargetScope {
  const path = tab.documentPath ?? "";
  const isProjectStyle = isProjectStylesheet(path);
  if (!stylebookTag) {
    return isProjectStyle
      ? projectScope("every page in this project", null)
      : { kind: "element", label: "this element" };
  }
  const shared = isProjectStyle || /^\.?\/?layouts\//.test(path);
  const label = `all <${stylebookTag}> in this ${shared ? "project" : "document"}`;
  return shared ? projectScope(label, stylebookTag) : { kind: "document", label };
}

/**
 * The project-wide warning band: its label, its count, and its disclosure.
 *
 * The count is `findReferences`' tag walk, which counts `tagName` matches across the project. Where
 * the host cannot answer — no `findReferences` route, a failed sweep, or no tag to ask about — the
 * band says **unknown** rather than a confident zero, exactly as `services/references.ts` requires
 * of every rendering.
 *
 * @param {string} label
 * @param {string | null} tagName — null for a root-style edit, which has no tag to count.
 * @returns {TargetScope}
 */
function projectScope(label: string, tagName: string | null): TargetScope {
  if (tagName === null) {
    // No tag, so no query: `:root`/`body` on every route is not a `tagName` sweep, and how many
    // Routes that is, is a question no surface here can answer. A zero would be the same lie the
    // Band exists to stop, in a smaller font — and with no file list, there is nothing to disclose.
    return { affected: "how many pages that is, is unknown", kind: "project", label };
  }
  const query = { tagName };
  const state = peekUsages(query);
  if (state === null) {
    // First paint for this tag: ask once, and repaint when the answer lands. `loadUsages` joins an
    // In-flight request, so a panel repainting sixty times a second is still one sweep.
    void loadUsages(query).then(() => renderOnly("rightPanel"));
  }
  return {
    kind: "project",
    label,
    affected: affectedSentence(state),
    affectedFiles: state?.status === "ready" ? usageFiles(state.result) : [],
    showAffected: _showAffected,
    onToggleAffected: () => {
      _showAffected = !_showAffected;
      renderOnly("rightPanel");
    },
  };
}

/** The affected count, in words — and "unknown" wherever the query cannot answer. */
function affectedSentence(state: ReturnType<typeof peekUsages>): string {
  if (state === null || state.status === "pending") {
    return "counting the elements it affects…";
  }
  if (state.status !== "ready") {
    return "how many elements that is, is unknown";
  }
  const { files, refsTotal } = state.result;
  if (refsTotal === 0) {
    return "no element in the project uses it yet";
  }
  return `${refsTotal} element${refsTotal === 1 ? "" : "s"} in ${files.length} file${
    files.length === 1 ? "" : "s"
  }`;
}

/** The two axes the Style tab states but does not own, plus the element it is pointed at. */
function targetSegments(
  elementLabel: string,
  mediaTab: string | null,
  hasBreakpoints: boolean,
  schemeLayer: string | null,
): TargetSegment[] {
  const segments: TargetSegment[] = [
    {
      key: "element",
      label: elementLabel,
      title: "What these edits are pointed at — click to find it in the Outline",
      onActivate: () => runCommand("view.setActivity", { tab: "layers" }),
    },
    {
      key: "media",
      label: hasBreakpoints && mediaTab ? `@${mediaDisplayName(mediaTab)}` : "Base",
      title:
        "The breakpoint these edits land in. Choose it on the pane's Context control; click to " +
        "manage breakpoints.",
      onActivate: () => runCommand("settings.open", { section: "contexts" }),
    },
  ];
  if (schemeLayer) {
    segments.push({
      key: "scheme",
      label: `${mediaDisplayName(schemeLayer)} variant`,
      title:
        "Edits land in this colour-scheme variant. Set the pane's Context control back to Auto " +
        "to edit base styles; click to manage schemes.",
      onActivate: () => runCommand("settings.open", { section: "contexts" }),
    });
  }
  return segments;
}

// ─── Provenance ──────────────────────────────────────────────────────────────

/** An inherited value, its donor's name, and how to go there. */
interface InheritedInfo {
  value: string | number;
  donor: string;
  jump?: (() => void) | undefined;
}

/**
 * The signal a `${…}` style value reads, when it reads one.
 *
 * `state.` is optional because both spellings occur in documents and both mean the same entry — the
 * chip names the signal, not the accessor path it was reached by.
 */
function templateSignalOf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return /\$\{\s*(?:state\.)?([A-Za-z_$][\w$]*)/.exec(value)?.[1] ?? null;
}

/** Whether a value is a `${}` template rather than a literal — the `bound` rung for a CSS value. */
function isTemplateValue(value: unknown): boolean {
  return typeof value === "string" && value.includes("${");
}

/** What the Style tab can say about one property's origin. */
interface ProvenanceCtx {
  own: JxStyle;
  active: JxStyle;
  inherited: Record<string, InheritedInfo>;
  signals: string[];
  clear: (prop: string) => void;
  /**
   * Properties the selected elements DISAGREE about, and how many elements are selected (§6.5).
   *
   * Empty for a selection of one — which is what keeps every other branch of `provenanceOf`
   * reachable exactly as often as it was before the selection became a set.
   */
  mixed?: { props: Set<string>; count: number } | undefined;
}

/**
 * Where this property's value came from.
 *
 * Four answers, and three of them were previously indistinguishable from each other: an inherited
 * value arrived as a placeholder identical to the CSS initial value, a site token arrived looking
 * like a local override, and a `${}` binding arrived looking like a literal with braces in it.
 */
function provenanceOf(prop: string, ctx: ProvenanceCtx): FieldProvenance {
  // Mixed is decided FIRST, because it is a fact about the selection rather than about the value:
  // The primary's own value may be perfectly ordinary while five other elements disagree with it,
  // And drawing that as `set` is exactly the lie this state exists to stop.
  if (ctx.mixed?.props.has(prop)) {
    return {
      state: "mixed",
      donor: String(ctx.mixed.count),
      onClick: () => ctx.clear(prop),
    };
  }
  const value = ctx.active[prop];
  if (value !== undefined && ctx.own[prop] === undefined) {
    // Present in the effective style but not in the document's own: it came from the site style.
    // No jump: the project style document is not something this tab can open.
    return {
      state: "inherited",
      donor: "site tokens",
      title: `Inherited from the project's site tokens — ${prop} is not set on this document`,
    };
  }
  if (value !== undefined) {
    if (isTemplateValue(value)) {
      const signal = templateSignalOf(value);
      return {
        state: "bound",
        ...(signal ? { donor: signal } : {}),
        ...(signal && ctx.signals.includes(signal)
          ? {
              onClick: () => {
                runCommand("view.setActivity", { tab: "state" });
                runCommand("state.selectSignal", { name: signal });
              },
            }
          : {}),
      };
    }
    return { state: "set", onClick: () => ctx.clear(prop) };
  }
  const inherited = ctx.inherited[prop];
  if (inherited) {
    return {
      state: "inherited",
      donor: inherited.donor,
      ...(inherited.jump ? { onClick: inherited.jump } : {}),
    };
  }
  return { state: "default" };
}

/**
 * Where a SHORTHAND row's value came from.
 *
 * A shorthand is less a value than a name for four of them, so every answer it can give is about
 * five properties at once: `padding` is set when `padding` or any of `paddingTop…Left` is, mixed
 * when the selection disagrees about any of the five, and inherited when the cascade supplies one
 * and this document supplies none. Asking only about the shorthand key is what let the row draw a
 * plain "Clear padding" dot over a property the panel had already computed as mixed.
 *
 * @param {string} shortProp
 * @param {ProvenanceCtx} ctx
 * @param {(() => void) | undefined} [clearAll] — clears the shorthand AND its longhands, which is
 *   the only clear this row has ever meant; omitted where there is nothing to clear.
 * @returns {FieldProvenance}
 */
function shorthandProvenance(
  shortProp: string,
  ctx: ProvenanceCtx,
  clearAll?: (() => void) | undefined,
): FieldProvenance {
  const props = [shortProp, ...(getLonghands(shortProp) as CssLonghand[]).map((l) => l.name)];
  const { mixed } = ctx;
  if (mixed && props.some((p) => mixed.props.has(p))) {
    return {
      state: "mixed",
      donor: String(mixed.count),
      ...(clearAll ? { onClick: clearAll } : {}),
    };
  }
  for (const p of props) {
    const prov = provenanceOf(p, ctx);
    if (prov.state === "default") {
      continue;
    }
    return prov.state === "set" && clearAll ? { ...prov, onClick: clearAll } : prov;
  }
  return DEFAULT_PROVENANCE;
}

/**
 * Where a longhand CHILD row's value came from.
 *
 * A longhand can hold a value it was never given: `padding: 1px 2px` fills four child rows, and
 * clearing one of them recompresses the shorthand rather than deleting a key. So a value derived
 * from the shorthand counts as `set` here, and a selection that disagrees about the shorthand
 * disagrees about every child the shorthand fills.
 *
 * @param {string} name
 * @param {string} shortProp
 * @param {boolean} hasValue — set here, or filled in by the shorthand above.
 * @param {ProvenanceCtx} ctx
 * @param {() => void} clearChild
 * @returns {FieldProvenance}
 */
function longhandProvenance(
  name: string,
  shortProp: string,
  hasValue: boolean,
  ctx: ProvenanceCtx,
  clearChild: () => void,
): FieldProvenance {
  const { mixed } = ctx;
  if (mixed && (mixed.props.has(name) || (hasValue && mixed.props.has(shortProp)))) {
    return { state: "mixed", donor: String(mixed.count), onClick: clearChild };
  }
  const prov = provenanceOf(name, ctx);
  if (prov.state === "set" || (prov.state === "default" && hasValue)) {
    return { state: "set", onClick: clearChild };
  }
  return prov;
}

/**
 * A section's tally, counting a shorthand as set when any of its longhands is.
 *
 * @param {{ prop: string; entry: CssPropertyEntry }[]} entries
 * @param {ProvenanceCtx} ctx
 */
function sectionProvenance(
  entries: { prop: string; entry: CssPropertyEntry }[],
  ctx: ProvenanceCtx,
): ProvenanceState[] {
  return entries.map(({ prop, entry }) =>
    inferInputType(entry) === "shorthand"
      ? shorthandProvenance(prop, ctx).state
      : provenanceOf(prop, ctx).state,
  );
}

// ─── Main template ──────────────────────────────────────────────────────────

/**
 * @param {JxMutableNode} node
 * @param {string | null} activeMediaTab
 * @param {string | null} activeSelector
 * @param {{ effectiveStyle?: JxStyle; stylebookSelector?: string | null }} [opts] —
 *   `effectiveStyle` is the site-merged style Stylebook edits against; `stylebookSelector` is the
 *   tag catalogue entry being styled, which is what makes the edit tag-wide rather than
 *   element-wide and therefore what the scope chip reports.
 */
function styleSidebarTemplate(
  node: JxMutableNode,
  activeMediaTab: string | null,
  activeSelector: string | null,
  opts: { effectiveStyle?: JxStyle | undefined; stylebookSelector?: string | null } = {},
) {
  const { effectiveStyle, stylebookSelector = null } = opts;
  const tab = activeTab.value!;
  const sel = primarySelection(tab.session.selection) as JxPath;
  /** The document's OWN style — what a commit writes into. */
  const ownRootStyle: JxStyle = node.style || {};
  const style = effectiveStyle ?? ownRootStyle;
  // Signals seeding the ${} template default when a style value escalates (no $ref in JxStyle).
  const templateSignals = Object.entries(tab.doc.document.state || {})
    .filter(
      ([, d]) =>
        !(d as Record<string, unknown>)?.$handler &&
        (d as Record<string, unknown>)?.$prototype !== "Function",
    )
    .map(([defName]) => defName);
  const { sizeBreakpoints } = parseMediaEntries(getEffectiveMedia(tab.doc.document.$media));
  const mediaNames = sizeBreakpoints.map((bp) => bp.name);
  const mediaTab = activeMediaTab || null;

  // ── Scheme-layer routing (spec §9.5) ────────────────────────────────────────
  // With the tab-bar scheme control forcing a scheme that has a matching declared scheme query,
  // Base-context edits target that scheme's `@--name` block — no extra sidebar tabs. Breakpoint
  // Tabs stay breakpoint-scoped (scheme × breakpoint compound blocks are unsupported).
  const forcedScheme = tab.session.ui.previewColorScheme;
  const schemeLayer =
    mediaTab === null && (forcedScheme === "light" || forcedScheme === "dark")
      ? (Object.entries(getEffectiveMedia(tab.doc.document.$media) ?? {}).find(
          ([, q]) => schemeOfQuery(String(q)) === forcedScheme,
        )?.[0] ?? null)
      : null;
  // The media context edits actually target: a valid breakpoint tab, else the scheme layer.
  const editMedia = mediaTab && mediaNames.length > 0 ? mediaTab : schemeLayer;

  // ── The selector axis — the one this tab owns ──────────────────────────────
  const contextStyle = editMedia
    ? (style[`@${editMedia}`] as Record<string, unknown>) || {}
    : style;
  const declaredSelectors = new Set(Object.keys(contextStyle).filter((s) => isNestedSelector(s)));
  const selectorOptions = [
    ...new Set([
      ...COMMON_SELECTORS,
      ...declaredSelectors,
      ...(activeSelector ? [activeSelector] : []),
    ]),
  ];

  // ── The Target Line (§6.1) ─────────────────────────────────────────────────
  // The three widgets this replaces are gone: the breakpoint `<sp-tabs>` strip, the
  // `.selector-select` picker and the `.style-scheme-badge`. The first two named axes the pane
  // Context bar already selects; the third emitted a class with no CSS rule anywhere in the repo.
  const stylebookTag = stylebookTagOf(stylebookSelector);
  const elementLabel =
    stylebookTag ?? (typeof node.tagName === "string" ? node.tagName : "element");
  const targetLineT = renderTargetLine({
    segments: targetSegments(elementLabel, mediaTab, mediaNames.length > 0, schemeLayer),
    selector: {
      value: activeSelector,
      options: selectorOptions,
      declared: declaredSelectors,
      onSelect: (value) => {
        activeTab.value!.session.ui.activeSelector = value;
      },
      onAddCustom: () => {
        // One flow, through `ui/layers.ts` — the imperative `<input>` this replaces was appended to
        // A bar lit-html owns, bypassing both the renderer and the overlay stack (§11.4).
        void showPromptDialog("Add Selector", {
          confirmLabel: "Use",
          message: "A state or nested rule to edit under this element.",
          placeholder: ":hover, .child, &.active, [attr]",
          validate: (v) =>
            isNestedSelector(v.trim()) ? "" : 'A selector must start with ":", ".", "&" or "[".',
        }).then((value) => {
          if (value) {
            activeTab.value!.session.ui.activeSelector = value.trim();
            renderOnly("rightPanel");
          }
        });
      },
    },
    scope: resolveScope(tab, stylebookTag),
  });

  // ── Filter bar ─────────────────────────────────────────────────────────────
  // One control. The "Active" toggle is gone: it existed only because provenance was invisible
  // With a section closed, and a heading that says "3 set here · 2 inherited" answers the same
  // Question without hiding two thirds of the panel to do it (§6.2).
  const filterBarT = html`
    <div class="style-filter-bar">
      <sp-textfield
        size="s"
        class="style-filter-input"
        placeholder="Filter properties…"
        .value=${live(tab.session.ui.styleFilter || "")}
        @input=${(e: Event) => {
          activeTab.value!.session.ui.styleFilter = (e.target as HTMLInputElement).value;
        }}
      ></sp-textfield>
    </div>
  `;

  // ── Determine the active style object ──────────────────────────────────────
  const activeStyle = resolveContextStyle(style, activeSelector, editMedia);
  // The SAME coordinate, resolved against the document's own style. In Stylebook `style` is the
  // Site-merged effective style, so a property present here and absent there arrived from the
  // Project's tokens — a donor the panel can now name instead of drawing it as a local override
  // Whose "clear" would silently do nothing.
  const ownStyle =
    style === ownRootStyle
      ? activeStyle
      : resolveContextStyle(ownRootStyle, activeSelector, editMedia);
  // ── The selection, and what it means to commit to it (§6.5) ────────────────
  // Every selected element gets the same write, inside ONE `transactDoc` — so setting padding on
  // Six cards is one decision and one undo step. With one element selected this loop runs once
  // Against `sel` and is indistinguishable from the single-target commit it replaces.
  const targets = tab.session.selection.length > 0 ? tab.session.selection : [sel];
  /**
   * ONE write, applied to every selected element — the only write function this tab has.
   *
   * It takes the caller's transaction rather than opening its own, because a row that writes twice
   * (a shorthand and the longhands it supersedes; a renamed custom property and its old key) must
   * still be one undo step. There is no single-target counterpart: every row that had one wrote to
   * the primary element and silently dropped the rest of the selection on the floor.
   */
  const mutateTargets: StyleMutateFn = (t, prop, val) => {
    for (const target of targets) {
      contextMutate(target, activeSelector, editMedia)(t, prop, val);
    }
  };
  const commitStyle = (prop: string, val?: string | Record<string, unknown> | undefined) =>
    transactDoc(activeTab.value, (t) => mutateTargets(t, prop, val));
  /** One target's OWN block at this coordinate — what a write that preserves values reads first. */
  const targetStyleOf = (t: Tab, target: JxPath): JxStyle => {
    const targetNode = getNodeAtPath(t.doc.document, target) as JxMutableNode | undefined;
    return resolveContextStyle(targetNode?.style ?? {}, activeSelector, editMedia);
  };

  // ── Compute inherited style, and NAME THE DONOR ────────────────────────────
  // Scheme layer: the base styles show through as inherited; breakpoint tabs inherit from lower
  // Breakpoints as before. Either way the donor is known at this point and is now kept: it is the
  // Difference between "some value is showing through" and "Base sets this to 16px, go and look".
  const inheritedInfo: Record<string, InheritedInfo> = {};
  if (schemeLayer) {
    const baseBlock = activeSelector ? (getNestedStyle(style, activeSelector) ?? {}) : style;
    for (const [p, v] of Object.entries(baseBlock)) {
      if (typeof v !== "object") {
        inheritedInfo[p] = {
          value: (v as string | number) ?? "",
          donor: "Base",
          jump: () => updateUi("previewColorScheme", "auto"),
        };
      }
    }
  } else {
    for (const [p, source] of Object.entries(
      computeInheritedSources(style, mediaNames, mediaTab, activeSelector),
    )) {
      inheritedInfo[p] = {
        value: source.value,
        donor: source.donor === null ? "Base" : mediaDisplayName(source.donor),
        jump: () => updateUi("activeMedia", source.donor),
      };
    }
  }
  const inheritedStyle: Record<string, string | number> = {};
  for (const [p, info] of Object.entries(inheritedInfo)) {
    inheritedStyle[p] = info.value;
  }
  const mixedProps = mixedStyleProps(tab, targets, activeSelector, editMedia);
  const provCtx: ProvenanceCtx = {
    own: ownStyle,
    active: activeStyle,
    inherited: inheritedInfo,
    signals: templateSignals,
    clear: (prop: string) => commitStyle(prop),
    ...(mixedProps.size > 0 ? { mixed: { count: targets.length, props: mixedProps } } : {}),
  };

  // Auto-open sections that have properties
  const newSections = autoOpenSections({ style: activeStyle }, tab.session.ui.styleSections);
  if (JSON.stringify(newSections) !== JSON.stringify(tab.session.ui.styleSections)) {
    tab.session.ui.styleSections = newSections;
  }

  // Partition properties into sections
  const sectionProps: Record<string, { prop: string; entry: CssPropertyEntry }[]> = {};
  for (const sec of cssMeta.$sections) {
    sectionProps[sec.key] = [];
  }

  for (const [prop, entry] of Object.entries(cssMeta.$defs) as [string, CssPropertyEntry][]) {
    if (typeof (entry as Record<string, unknown>).$shorthand === "string") {
      continue;
    }
    const sec = ((entry as Record<string, unknown>).$section as string) || "other";
    sectionProps[sec]!.push({ entry, prop });
  }
  for (const sec of cssMeta.$sections) {
    sectionProps[sec.key]!.sort(
      (
        a: { prop: string; entry: CssPropertyEntry },
        b: { prop: string; entry: CssPropertyEntry },
      ) =>
        ((a.entry as Record<string, unknown>).$order as number) -
        ((b.entry as Record<string, unknown>).$order as number),
    );
  }

  const otherProps = [];
  for (const prop of Object.keys(activeStyle)) {
    if (!(cssMeta.$defs as Record<string, unknown>)[prop]) {
      const val = activeStyle[prop];
      if (val !== null && typeof val === "object") {
        continue;
      }
      otherProps.push(prop);
    }
  }

  const nestedRules: string[] = [];
  for (const [prop, val] of Object.entries(activeStyle)) {
    if (val !== null && typeof val === "object" && !Array.isArray(val) && !prop.startsWith("@")) {
      nestedRules.push(prop);
    }
  }

  // ── Filter state ─────────────────────────────────────────────────────────
  const filterText = (tab.session.ui.styleFilter || "").toLowerCase();
  const isFiltering = filterText.length > 0;

  // ── Section templates ────────────────────────────────────────────────────
  const sectionTemplates = cssMeta.$sections
    .filter((sec) => sec.key !== "other")
    .map((sec) => {
      const entries = sectionProps[sec.key]!;

      const sectionActiveProps = entries.filter(
        ({ prop, entry }: { prop: string; entry: CssPropertyEntry }) => {
          if (activeStyle[prop] !== undefined) {
            return true;
          }
          if (inferInputType(entry) === "shorthand") {
            return (getLonghands(prop) as CssLonghand[]).some(
              (l: CssLonghand) => activeStyle[l.name] !== undefined,
            );
          }
          return false;
        },
      );

      const clearSection = () => {
        transactDoc(activeTab.value, (t) => {
          for (const { prop, entry } of sectionActiveProps) {
            if (activeStyle[prop] !== undefined) {
              mutateTargets(t, prop);
            }
            if (inferInputType(entry) === "shorthand") {
              for (const l of getLonghands(prop) as CssLonghand[]) {
                mutateTargets(t, l.name);
              }
            }
          }
        });
      };

      // The heading's own answer to "is anything in here set, inherited or bound" — the question
      // The retired "Active" toggle answered by hiding everything that was not.
      const counts = countProvenance(sectionProvenance(entries, provCtx));
      const headingT = html`
        <span slot="heading" class="style-section-heading">
          ${sec.label}
          ${renderProvenanceDots(counts, {
            onClearSet: sectionActiveProps.length > 0 ? clearSection : undefined,
            clearTitle: `Clear all ${sec.label.toLowerCase()} properties`,
          })}
        </span>
      `;

      const isOpen = isFiltering ? true : (tab.session.ui.styleSections[sec.key] ?? false);

      if (!isOpen) {
        return html`
          <sp-accordion-item
            label=${sec.label}
            .open=${false}
            @sp-accordion-item-toggle=${(e: Event) => {
              activeTab.value!.session.ui.styleSections = {
                ...activeTab.value!.session.ui.styleSections,
                [sec.key]: (e.target as HTMLElement & { open: boolean }).open,
              };
            }}
          >
            ${headingT}
          </sp-accordion-item>
        `;
      }

      const rows = [];
      for (const { prop, entry } of entries) {
        const val = activeStyle[prop];
        const hasVal = val !== undefined;
        const condMet = allConditionsPass(entry, activeStyle);
        const type = inferInputType(entry);
        if (!hasVal && !condMet) {
          continue;
        }

        if (filterText) {
          const label = propLabel(entry, prop).toLowerCase();
          if (!prop.includes(filterText) && !label.includes(filterText)) {
            continue;
          }
        }

        if (type === "shorthand") {
          const longhands = getLonghands(prop) as CssLonghand[];
          const hasAny =
            hasVal || longhands.some((l: CssLonghand) => activeStyle[l.name] !== undefined);
          if (!hasAny && !condMet) {
            continue;
          }
          rows.push(
            renderShorthandRow({
              prop,
              entry,
              style: activeStyle,
              mutate: mutateTargets,
              inherited: inheritedStyle,
              ctx: provCtx,
            }),
          );
        } else {
          const isWarning = hasVal && !condMet;
          if (hasVal || condMet) {
            rows.push(
              renderStyleRow(
                entry,
                prop,
                (val as string) ?? "",
                (newVal: string | undefined) => commitStyle(prop, newVal || undefined),
                isWarning,
                sec.$layout === "grid",
                inheritedStyle[prop] as string | undefined,
                templateSignals,
                `style|${sel.join("/")}|${editMedia ?? ""}|${activeSelector ?? ""}|${prop}`,
                provenanceOf(prop, provCtx),
              ),
            );
          }
        }
      }

      if (isFiltering && rows.length === 0) {
        return nothing;
      }

      return html`
        <sp-accordion-item
          label=${sec.label}
          .open=${isOpen}
          @sp-accordion-item-toggle=${(e: Event) => {
            activeTab.value!.session.ui.styleSections = {
              ...activeTab.value!.session.ui.styleSections,
              [sec.key]: (e.target as HTMLElement & { open: boolean }).open,
            };
          }}
        >
          ${headingT}
          <div class=${sec.$layout === "grid" ? "style-section-body--grid" : ""}>${rows}</div>
        </sp-accordion-item>
      `;
    });

  // ── Custom section ─────────────────────────────────────────────────────────
  const cssInitialMap = getCssInitialMap();
  const customIsOpen = tab.session.ui.styleSections.other ?? otherProps.length > 0;
  const customSectionT = html`
    <sp-accordion-item
      label="Custom"
      .open=${customIsOpen}
      @sp-accordion-item-toggle=${(e: Event) => {
        activeTab.value!.session.ui.styleSections = {
          ...activeTab.value!.session.ui.styleSections,
          other: (e.target as HTMLElement & { open: boolean }).open,
        };
      }}
    >
      <div>
        ${otherProps.map(
          (prop) => html`
            <div class="kv-row">
              <sp-textfield
                size="s"
                class="kv-key"
                .value=${live(prop)}
                @change=${(e: Event) => {
                  const newProp = (e.target as HTMLInputElement).value.trim();
                  if (!newProp || newProp === prop) {
                    return;
                  }
                  // A rename is the one write that cannot be fanned out with a single value: each
                  // Element keeps ITS OWN value under the new key. The old code batched half of the
                  // Rename (the delete) against the primary and the other half against the primary
                  // Too, while the value cell beside it wrote to the whole selection — so renaming
                  // A property the selection shared moved it on one element and left it on the
                  // Rest.
                  transactDoc(activeTab.value, (t) => {
                    for (const target of targets) {
                      const current = targetStyleOf(t, target)[prop];
                      if (current === undefined) {
                        continue;
                      }
                      const write = contextMutate(target, activeSelector, editMedia);
                      write(t, prop);
                      write(t, newProp, String(current));
                    }
                  });
                }}
              ></sp-textfield>
              <sp-textfield
                size="s"
                class="kv-val"
                .value=${live(String(activeStyle[prop]))}
                placeholder=${ifDefined(cssInitialMap.get(prop))}
                @input=${debouncedStyleCommit(`custom:${prop}`, 400, (e: Event) => {
                  commitStyle(prop, (e.target as HTMLInputElement).value);
                })}
              ></sp-textfield>
              <sp-action-button size="xs" quiet @click=${() => commitStyle(prop)}>
                <sp-icon-close slot="icon"></sp-icon-close>
              </sp-action-button>
            </div>
          `,
        )}
        <div style="display:flex;gap:4px;padding-top:4px">
          <sp-textfield
            size="s"
            placeholder="Property name…"
            style="flex:1"
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const prop = (e.target as HTMLInputElement).value.trim();
                if (prop) {
                  const initial = cssInitialMap.get(prop) || "";
                  commitStyle(prop, initial || "");
                  (e.target as HTMLInputElement).value = "";
                }
              }
            }}
          ></sp-textfield>
        </div>
      </div>
    </sp-accordion-item>
  `;

  // ── Relative Styling section (nested rules) ───────────────────────────────
  const nestedIsOpen = tab.session.ui.styleSections.nested ?? nestedRules.length > 0;
  const nestedSectionT =
    nestedRules.length > 0
      ? html`
          <sp-accordion-item
            label="Relative Styling"
            .open=${nestedIsOpen}
            @sp-accordion-item-toggle=${(e: Event) => {
              activeTab.value!.session.ui.styleSections = {
                ...activeTab.value!.session.ui.styleSections,
                nested: (e.target as HTMLElement & { open: boolean }).open,
              };
            }}
          >
            <div style="display:flex;flex-direction:column;gap:4px;padding:4px 0">
              ${nestedRules.map(
                (rule) => html`
                  <div style="display:flex;align-items:center;gap:4px">
                    <button
                      style="flex:1;text-align:left;padding:6px 10px;background:var(--spectrum-gray-200, #1a1a1a);border:none;border-radius:var(--radius);color:var(--spectrum-gray-900, #fafafa);font-size:var(--spectrum-font-size-75, 12px);cursor:pointer"
                      @click=${() => {
                        const newSelector = activeSelector ? `${activeSelector} ${rule}` : rule;
                        selectStylebookTag(newSelector, undefined, {
                          panCanvas: true,
                        });
                      }}
                    >
                      ${rule}
                    </button>
                    <sp-action-button size="xs" quiet @click=${() => commitStyle(rule)}>
                      <sp-icon-delete slot="icon"></sp-icon-delete>
                    </sp-action-button>
                  </div>
                `,
              )}
              <button
                style="padding:6px 10px;background:none;border:1px dashed var(--spectrum-gray-400, #333);border-radius:var(--radius);color:var(--spectrum-gray-700, #a1a1aa);font-size:var(--spectrum-font-size-75, 12px);cursor:pointer"
                @click=${async () => {
                  const name = await showPromptDialog("Add Nested Selector", {
                    confirmLabel: "Add",
                    message: "Enter a selector to nest under the current rule.",
                    placeholder: "th, :hover, .active",
                    validate: (v) => (v.trim() ? "" : "Enter a selector."),
                  });
                  if (name) {
                    commitStyle(name, {});
                  }
                }}
              >
                + Add
              </button>
            </div>
          </sp-accordion-item>
        `
      : nothing;

  return html`
    <div class="style-sidebar">
      ${targetLineT} ${filterBarT}
      <sp-accordion allow-multiple size="s">
        ${sectionTemplates} ${nestedSectionT} ${customSectionT}
      </sp-accordion>
    </div>
  `;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Top-level Style panel — returns a lit-html template.
 *
 * @param {{ getCanvasMode: () => string }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderStylePanelTemplate(ctx: { getCanvasMode: () => string }) {
  const tab = activeTab.value;
  const noDocument = () =>
    renderEmptyState({
      actions: [openPageAction()],
      message: "Open a page to style what you click.",
    });
  if (!tab) {
    return noDocument();
  }
  if (ctx.getCanvasMode() === "stylebook" && shell.stylebook.selection) {
    const node = tab.doc.document;
    if (!node) {
      return noDocument();
    }
    // No separate `Styling: <h1>` header. It said the same thing the Target Line's scope chip says,
    // Except that it said it as a caption, after the fact, and without the blast radius (§6.1).
    return styleSidebarTemplate(node, tab.session.ui.activeMedia, tab.session.ui.activeSelector, {
      effectiveStyle: getEffectiveStyle(node.style),
      stylebookSelector: shell.stylebook.selection,
    });
  }
  const selected = primarySelection(tab.session.selection);
  if (!selected) {
    return renderEmptyState({ message: clickAnythingTo("style it") });
  }
  const node = getNodeAtPath(tab.doc.document, selected);
  if (!node) {
    return renderEmptyState({ message: staleSelectionMessage() });
  }
  return styleSidebarTemplate(node, tab.session.ui.activeMedia, tab.session.ui.activeSelector);
}

/** Single property input row (generic field row helper) */
export function _fieldRow(
  label: string,
  type: string,
  value: string,
  onChange: (v: string | boolean) => void,
  _datalistId: string | undefined,
) {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const onInput = (e: Event) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onChange((e.target as HTMLInputElement).value), 400);
  };
  const inputTpl =
    type === "textarea"
      ? html`<sp-textfield
          multiline
          size="s"
          .value=${live(value ?? "")}
          @input=${onInput}
        ></sp-textfield>`
      : type === "checkbox"
        ? html`<sp-checkbox
            ?checked=${Boolean(value)}
            @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
          ></sp-checkbox>`
        : html`<sp-textfield
            size="s"
            .value=${live(value ?? "")}
            @input=${onInput}
          ></sp-textfield>`;
  return html`
    <div class="field-row">
      <sp-field-label size="s">${label}</sp-field-label>
      ${inputTpl}
    </div>
  `;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * The style-context selectors addressable right now: the common set plus whatever the selected
 * element already declares, plus the active one. Mirrors the picker's own menu, from the same
 * data.
 */
export function availableSelectors(): string[] {
  const tab = activeTab.value;
  const declared: string[] = [];
  const selected = primarySelection(tab?.session.selection);
  if (tab && selected) {
    const node = getNodeAtPath(tab.doc.document, selected);
    for (const key of Object.keys(node?.style ?? {})) {
      if (isNestedSelector(key)) {
        declared.push(key);
      }
    }
  }
  const active = tab?.session.ui.activeSelector;
  return [...new Set([...COMMON_SELECTORS, ...declared, ...(active ? [active] : [])])];
}

/**
 * The Style tab's selector verbs.
 *
 * `style.openSelectorMenu` is the one command here that addresses a CONTROL rather than a state,
 * and it earns that on purpose: the shot it serves photographs the open menu, so the menu is the
 * subject. What it does not do is hand a CSS selector back to the runner for a synthetic mouse
 * press — the element comes from the Target Line's own `ref`, so a refactor of that markup moves
 * the handle with it. The menu it opens is now a segment of the Target Line rather than a picker on
 * a retired toolbar; the id, and therefore the shot, is unchanged.
 *
 * `style.setSelector` is the state half of the same idea, and it is what a caller that wants a
 * RESULT rather than a picture should use: the menu exists to choose a selector, and choosing one
 * is expressible.
 *
 * @returns {AnyCommand[]}
 */
export function styleCommands(): AnyCommand[] {
  const styleTabOpen = (ctx: { document: { open: boolean }; selection: { count: number } }) =>
    ctx.document.open && ctx.selection.count > 0;

  return [
    {
      category: "View",
      id: "style.openSelectorMenu",
      level: "selection",
      menus: ["palette"],
      group: "8_style",
      requires: "the Style tab showing a selected element",
      when: styleTabOpen,
      run: () => openSelectorMenu(),
      title: "Open Selector Menu",
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          selector: pathlessSelectorProperty(),
        },
        required: ["selector"],
        type: "object",
      },
      category: "View",
      id: "style.setSelector",
      level: "selection",
      menus: ["palette"],
      group: "8_style",
      requires: "an element selection",
      when: styleTabOpen,
      run: (_commandCtx, args) => {
        const { selector } = args as { selector?: unknown };
        if (selector === null) {
          const tab = activeTab.value;
          if (tab) {
            tab.session.ui.activeSelector = null;
          }
          return;
        }
        const value = stringArg("style.setSelector", args, "selector");
        if (!isNestedSelector(value)) {
          throw new RangeError(
            `command "style.setSelector" argument "selector": "${value}" is not a nested ` +
              `selector — it must start with ":", ".", "&" or "["`,
          );
        }
        const tab = activeTab.value;
        if (!tab) {
          throw new RangeError(`command "style.setSelector" needs an open document`);
        }
        tab.session.ui.activeSelector = value;
      },
      title: "Set Style Selector",
    },
  ];
}

/** The `selector` property's schema: a nested selector, or `null` for the base context. */
function pathlessSelectorProperty(): object {
  return {
    description:
      'A nested selector such as ":hover", ".child" or "[open]". null edits the base context.',
    oneOf: [{ type: "string" }, { type: "null" }],
  };
}

/**
 * Register the Style tab's selector verbs.
 *
 * @param {CommandRegistry} registry
 */
export function registerStyleCommands(registry: CommandRegistry): void {
  registry.registerAll(styleCommands());
}
