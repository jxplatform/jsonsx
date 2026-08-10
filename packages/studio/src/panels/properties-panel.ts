/// <reference lib="dom" />
/**
 * The Content tab — everything about WHAT this element is and says.
 *
 * Plan §6.5 re-split the inspector by task. Content is the element itself (tag, id, class, text),
 * its HTML attributes, its link target, its custom attributes, its component props and its media.
 * Three things left, and each left for a place that already had a better claim on it:
 *
 * - **Repeater · Switch · Observed Attributes · CSS Properties · CSS Parts → the Logic tab.** Wiring
 *   a `$switch` and wiring a click handler are the same task (`panels/events-panel.ts`).
 * - **The Page section → the Document Header card.** `panels/head-panel.ts` owns the one layout
 *   picker; this panel drew a second one that could disagree with it.
 * - **Media breakpoint DEFINITIONS → Project Settings › Contexts** (P4). Nothing remains here: the
 *   only reason adding a breakpoint used to cost you your element selection.
 *
 * What is left is one accordion of rows, all of which go through `ui/field-row.ts`.
 */

import { html, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { debouncedStyleCommit, getNodeAtPath, renderOnly } from "../store";
import { displayTagName, isRef, isTagExpression } from "@jxsuite/schema/guards";
import type { DirEntry, JsonValue } from "../types";
import {
  mutateUpdateAttribute,
  mutateUpdateProp,
  mutateUpdateProperty,
  transactDoc,
} from "../tabs/transact";
import { activeTab, workspace } from "../workspace/workspace";
import { deriveRefusal } from "../workspace/pane-derive";
import { primarySelection, unifyValues } from "../tabs/selection";
import { shell } from "../shell";
import {
  argsSchema,
  booleanArg,
  booleanProperty,
  stringArg,
  stringProperty,
} from "../commands/command-args";
import type { LayoutSelection } from "../shell";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import { activeRegistry } from "../commands/active-registry";
import { componentRegistry } from "../files/components";
import { widgetForType } from "./style-inputs";
import { renderFieldRow, renderKvRow } from "../ui/field-row";
import type { FieldProvenance } from "./provenance";
import { renderDynamicSlot, slotMode } from "../ui/dynamic-slot";
import { spTextArea, spTextField } from "../ui/field-input";
import { attrLabel, camelToLabel, inferInputType, parseCemType } from "../utils/studio-utils";
import { classifyHref, composeHref } from "../utils/link-target";
import type { LinkKind } from "../utils/link-target";
import {
  clickAnythingTo,
  openPageAction,
  renderEmptyState,
  staleSelectionMessage,
} from "./empty-state";
import { renderMediaPicker } from "../ui/media-picker";
import { renderColorSelector } from "../ui/color-selector";
import {
  loadUsages,
  peekUsages,
  retryUsages,
  usageFiles,
  usageHeadline,
} from "../services/references";
import { getPlatform } from "../platform";
import htmlMeta from "../../data/html-meta.json";

import type {
  JxAttributeValue,
  JxMutableNode,
  JxPrototypeDef,
  JxStateDefinition,
  JxStateObject,
  JxTagExpression,
} from "@jxsuite/schema/types";
import type { SignalOption } from "../ui/dynamic-slot";
import type { JxPath } from "../state";

interface HtmlMetaEntry {
  $section: string;
  $order: number;
  $attr?: string;
  $elements?: string[];
  $label?: string;
  $input?: string;
  $shorthand?: boolean;
  type?: string;
  [key: string]: unknown;
}

// ─── The binding vocabulary, shared with the Logic tab ───────────────────────

/**
 * The two extra signals a position inside a repeater template can bind to, or `null` outside one.
 *
 * A "map" segment addresses a repeater template (`[…, "children", i, "map", …]`, or the legacy `[…,
 * "children", "map", …]`), so anything at or below it is inside one.
 *
 * Exported because Content and Logic both offer them and there is one right answer: a `$switch`
 * inside a `$map` can read `$map/item`, and so can the `alt` attribute two nodes below it.
 */
export function mapSignalsFor(path: JxPath): SignalOption[] | null {
  return path.includes("map")
    ? [
        { label: "$map/item", value: "$map/item" },
        { label: "$map/index", value: "$map/index" },
      ]
    : null;
}

/** State keys a value position may bind to — handlers and Functions are not values. */
export function bindableSignalNames(doc: JxMutableNode): string[] {
  return Object.entries(doc.state || {})
    .filter(
      ([, d]) =>
        !(d as Record<string, unknown>)?.$handler &&
        (d as JxPrototypeDef)?.$prototype !== "Function",
    )
    .map(([defName]) => defName);
}

/**
 * Render a state entry's default value as the static input text when unbinding.
 *
 * @param {import("@jxsuite/schema/types").JxStateDefinition | undefined} def
 * @returns {string}
 */
export function defaultAsString(def: JxStateDefinition | undefined) {
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    return "";
  }
  const dv = (def as JxStateObject).default;
  if (dv === undefined) {
    return "";
  }
  return typeof dv === "object" ? JSON.stringify(dv) : String(dv);
}

/** Who a bound value comes from, in the fewest words that are true — the chip's donor text. */
function bindingDonor(value: unknown): string {
  if (isRef(value)) {
    const ref = value.$ref;
    return ref.startsWith("#/state/") ? ref.slice(8) : ref || "nothing yet";
  }
  return typeof value === "string" ? "a template" : "a formula";
}

// ─── Sub-templates ──────────────────────────────────────────────────────────

/**
 * Component props, each row carrying §6.2's provenance chip — the SECOND cascade.
 *
 * A component instance's value for a prop either overrides the component's declared default or does
 * not exist, and until now the two were the same blank field. The chip states which, and in the
 * inherited case it names the donor AND jumps to it: the donor of a component default is the
 * component definition, which this panel can already open.
 */
function renderComponentPropsFieldsTemplate(
  node: JxMutableNode,
  path: JxPath,
  mapSignals: SignalOption[] | null,
  navigateToComponent: (path: string) => void,
) {
  const tab = activeTab.value;
  const comp = componentRegistry.find((c) => c.tagName === node.tagName);
  if (!comp || !comp.props) {
    return renderEmptyState({
      compact: true,
      message: "This component is not in the project's library, so it has no settings to show.",
    });
  }
  const isNpm = comp.source === "npm";
  const currentVals = isNpm ? node.attributes || {} : node.$props || {};
  const updateFn = isNpm
    ? (name: string, v?: JsonValue) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateAttribute(
            t,
            path,
            name,
            v === "" ? undefined : (v as JxAttributeValue | undefined),
          ),
        )
    : (name: string, v?: JsonValue) =>
        transactDoc(activeTab.value, (t) => mutateUpdateProp(t, path, name, v));

  const defs = tab!.doc.document.state || {};
  const signalNames = bindableSignalNames(tab!.doc.document);
  const extraSignals = mapSignals;

  return html`
    ${comp.props.map((prop) => {
      const rawValue = currentVals[prop.name];
      const boundRef = isRef(rawValue) ? rawValue.$ref : null;
      const hasVal = rawValue !== undefined && rawValue !== null;
      const parsed = parseCemType(prop.type);
      const onChange = (v?: JsonValue) => updateFn(prop.name, v);
      const staticVal = slotMode(rawValue) === "literal" ? String(rawValue ?? "") : "";

      // De-escalating to literal restores the bound signal's declared default (old unbind behavior).
      const literalDefault = boundRef
        ? defaultAsString(defs[boundRef.startsWith("#/state/") ? boundRef.slice(8) : boundRef]) ||
          undefined
        : undefined;

      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let debounce: ReturnType<typeof setTimeout> | undefined;
      let widgetTpl;
      if (prop.format === "image") {
        widgetTpl = renderMediaPicker(prop.name, staticVal, onChange);
      } else if (prop.format === "color") {
        widgetTpl = renderColorSelector(prop.name, staticVal, onChange);
      } else if (prop.format === "date") {
        widgetTpl = spTextField(
          `cprop:${prop.name}`,
          String(staticVal),
          (v: string) => onChange(v),
          {
            placeholder: "YYYY-MM-DD",
          },
        );
      } else if (parsed.kind === "boolean") {
        widgetTpl = html`<sp-checkbox
          size="s"
          .checked=${live(Boolean(staticVal))}
          @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked || undefined)}
        ></sp-checkbox>`;
      } else if (parsed.kind === "number") {
        widgetTpl = html`<sp-number-field
          size="s"
          .value=${live(staticVal)}
          @input=${(e: Event) => {
            clearTimeout(debounce);
            debounce = setTimeout(() => onChange((e.target as HTMLInputElement).value), 400);
          }}
        ></sp-number-field>`;
      } else if (parsed.kind === "combobox") {
        const options = parsed.options as string[];
        widgetTpl = html`<jx-value-selector
          .value=${String(staticVal)}
          size="s"
          placeholder="—"
          .options=${options.map((o) => ({ label: camelToLabel(o), value: o }))}
          @change=${(e: Event & { detail?: { value?: string } }) =>
            onChange(e.detail?.value ?? (e.target as HTMLInputElement).value)}
        ></jx-value-selector>`;
      } else {
        widgetTpl = spTextField(`cprop:${prop.name}`, String(staticVal), (v: string) =>
          onChange(v),
        );
      }

      const slot = renderDynamicSlot({
        caps: "componentProp",
        extraSignals,
        fieldKey: `cprop|${path.join("/")}|${prop.name}`,
        literalDefault,
        onChange,
        staticWidget: widgetTpl,
        stateDefs: signalNames,
        value: rawValue,
      });

      return renderFieldRow({
        hasValue: hasVal,
        label: camelToLabel(prop.name),
        labelExtra: slot.modeButton,
        prop: prop.name,
        provenance: componentPropProvenance(prop, rawValue, hasVal, {
          onClear: () => updateFn(prop.name),
          openDefinition: comp.path ? () => navigateToComponent(comp.path!) : undefined,
        }),
        widget: slot.widget,
      });
    })}
    ${
      comp.props.length === 0
        ? renderEmptyState({
            compact: true,
            message: "This component has no settings to fill in yet.",
          })
        : nothing
    }
    ${
      comp.path
        ? html`<span class="kv-add" @click=${() => navigateToComponent(comp.path!)}
            >→ Edit definition</span
          >`
        : nothing
    }
  `;
}

/**
 * Which of §6.2's four states a component-prop row is in.
 *
 * Bound beats set (a `$ref` IS a value, but "bound to `title`" is the more useful sentence); set
 * beats inherited; a prop with no declared default and no value is plain Default and draws
 * nothing.
 */
function componentPropProvenance(
  prop: { name: string; default?: unknown; description?: string },
  rawValue: unknown,
  hasVal: boolean,
  actions: { onClear: () => void; openDefinition?: (() => void) | undefined },
): FieldProvenance {
  if (hasVal && slotMode(rawValue) !== "literal") {
    return { donor: bindingDonor(rawValue), state: "bound", title: `Bound — ${prop.name}` };
  }
  if (hasVal) {
    return { onClick: actions.onClear, state: "set", title: `Clear ${prop.name}` };
  }
  if (prop.default !== undefined) {
    return {
      donor: "the component default",
      state: "inherited",
      title: `Not set here — the component's default (${String(prop.default)}) applies`,
      ...(actions.openDefinition ? { onClick: actions.openDefinition } : {}),
    };
  }
  return { state: "default" };
}

/** Custom attrs fields template — attributes this element's schema does not know about. */
function renderCustomAttrsFieldsTemplate(
  path: JxPath,
  attrs: Record<string, unknown>,
  knownAttrNames: Set<string>,
) {
  const customAttrs = Object.entries(attrs).filter(([k]) => !knownAttrNames.has(k));
  return html`
    ${customAttrs.map(([attr, val]) =>
      renderKvRow({
        name: attr,
        onCommit: (newAttr: string, newVal: string) => {
          if (newAttr !== attr) {
            transactDoc(activeTab.value, (t) => {
              mutateUpdateAttribute(t, path, attr);
              mutateUpdateAttribute(t, path, newAttr, newVal);
            });
          } else {
            transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr, newVal));
          }
        },
        onDelete: () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr)),
        value: String(val),
      }),
    )}
    <span
      class="kv-add"
      @click=${() => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, "data-", ""))}
      >+ Add attribute</span
    >
  `;
}

// ─── Page-route enumeration (for the Link-target Internal picker) ─────────────

/** @type {string[] | null} — cached list of internal routes derived from the pages/ tree. */
let pageRouteEntries: string[] | null = null;

/**
 * Derive a site route from a page file path relative to `pages/`, following the file-based routing
 * convention: `index.json` → the directory route, `[slug].json` → `:slug`, all others drop their
 * extension. Directory routes get a trailing slash (`/about/`); the root is `/`.
 *
 * @param {string} relPath — path relative to `pages/`, forward-slashed (e.g. "blog/[slug].json").
 * @returns {string}
 */
function routeForPagePath(relPath: string): string {
  const withoutExt = relPath.replace(/\.[^./]+$/, "");
  const segments = withoutExt
    .split("/")
    .map((seg) => (seg.startsWith("[") ? `:${seg.slice(1, -1)}` : seg));
  const isIndex = segments.at(-1) === "index";
  if (isIndex) {
    segments.pop();
  }
  const body = segments.join("/");
  if (!body) {
    return "/";
  }
  // Dynamic routes keep no trailing slash; static routes are directory-style (trailing slash).
  return isIndex || body.includes(":") ? `/${body}${isIndex ? "/" : ""}` : `/${body}/`;
}

/** Recursively walk the pages/ tree and populate {@link pageRouteEntries} with derived routes. */
async function loadPageRouteEntries() {
  const platform = getPlatform();
  const routes: string[] = [];
  const docExts = new Set([".json", ".md", ".html"]);
  async function walk(dir: string, rel: string) {
    let listing: DirEntry[];
    try {
      listing = await platform.listDirectory(dir);
    } catch {
      return;
    }
    for (const entry of listing) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.type === "directory") {
        await walk(entry.path ?? `${dir}/${entry.name}`, childRel);
      } else if (docExts.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        routes.push(routeForPagePath(childRel));
      }
    }
  }
  await walk("pages", "");
  pageRouteEntries = [...new Set(routes)].toSorted((a, b) => a.localeCompare(b));
  renderOnly("rightPanel");
}

export function invalidatePageRouteCache() {
  pageRouteEntries = null;
}

/**
 * Composite Link-target control for an anchor's `href` — a kind selector (Internal / External /
 * Anchor / Email / Phone) plus the matching input, backed by classifyHref/composeHref so edits
 * round-trip. Internal targets render an sp-picker of page routes enumerated from the pages/ tree.
 *
 * @param {JxMutableNode} node
 * @param {JxPath} path
 */
function renderLinkTargetField(node: JxMutableNode, path: JxPath) {
  const raw = typeof node.attributes?.href === "string" ? node.attributes.href : "";
  const { kind, value } = classifyHref(raw);

  const commit = (nextKind: LinkKind, nextValue: string) => {
    const composed = composeHref(nextKind, nextValue);
    transactDoc(activeTab.value!, (t) =>
      mutateUpdateAttribute(t, path, "href", composed || undefined),
    );
  };

  const kindOptions: { value: LinkKind; label: string }[] = [
    { label: "Internal Page", value: "internal" },
    { label: "External URL", value: "external" },
    { label: "Anchor", value: "anchor" },
    { label: "Email", value: "mailto" },
    { label: "Phone", value: "tel" },
  ];

  const kindSelector = html`
    <sp-picker
      class="link-target-kind"
      size="s"
      value=${kind}
      @change=${(e: Event) => {
        const nextKind = (e.target as HTMLInputElement).value as LinkKind;
        // Switching kind reinterprets the current value under the new kind.
        commit(nextKind, value);
      }}
    >
      ${kindOptions.map((o) => html`<sp-menu-item value=${o.value}>${o.label}</sp-menu-item>`)}
    </sp-picker>
  `;

  let valueInput;
  if (kind === "internal") {
    if (pageRouteEntries === null) {
      void loadPageRouteEntries();
    }
    const routes = pageRouteEntries ?? [];
    const knownValue = value !== "" && !routes.includes(value);
    valueInput = html`
      <sp-picker
        class="link-target-value"
        size="s"
        value=${value}
        @change=${(e: Event) => commit("internal", (e.target as HTMLInputElement).value)}
      >
        ${knownValue ? html`<sp-menu-item value=${value}>${value}</sp-menu-item>` : nothing}
        ${routes.map((r) => html`<sp-menu-item value=${r}>${r}</sp-menu-item>`)}
      </sp-picker>
    `;
  } else {
    const placeholder =
      kind === "mailto"
        ? "name@example.com"
        : kind === "tel"
          ? "+15551234567"
          : kind === "anchor"
            ? "section-id"
            : "https://example.com";
    valueInput = html`
      <sp-textfield
        class="link-target-value"
        size="s"
        placeholder=${placeholder}
        .value=${live(value)}
        @input=${debouncedStyleCommit("link:href", 400, (e: Event) =>
          commit(kind, (e.target as HTMLInputElement).value),
        )}
      ></sp-textfield>
    `;
  }

  return renderFieldRow({
    hasValue: raw !== "",
    label: "Link",
    onClear: () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, "href")),
    prop: "href",
    widget: html`<div class="link-target-field">${kindSelector}${valueInput}</div>`,
  });
}

/**
 * Real enum picker (sp-picker) for the anchor `target` attribute, replacing the generic
 * jx-value-selector so the four browsing-context keywords are offered as a dropdown.
 *
 * @param {JxMutableNode} node
 * @param {JxPath} path
 * @param {HtmlMetaEntry} entry
 */
function renderTargetField(node: JxMutableNode, path: JxPath, entry: HtmlMetaEntry) {
  const options = Array.isArray(entry.enum) ? (entry.enum as string[]) : [];
  const current = typeof node.attributes?.target === "string" ? node.attributes.target : "";
  return renderFieldRow({
    hasValue: current !== "",
    label: attrLabel(entry, "target"),
    onClear: () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, "target")),
    prop: "target",
    widget: html`
      <sp-picker
        class="link-target-window"
        size="s"
        value=${current}
        @change=${(e: Event) =>
          transactDoc(activeTab.value!, (t) =>
            mutateUpdateAttribute(
              t,
              path,
              "target",
              (e.target as HTMLInputElement).value || undefined,
            ),
          )}
      >
        ${options.map((o) => html`<sp-menu-item value=${o}>${o}</sp-menu-item>`)}
      </sp-picker>
    `,
  });
}

/**
 * True when an attribute value is a binding (a `$ref` object or a template string containing
 * `${…}`), so the Link-target special-case must fall back to the raw widget to keep it editable.
 */
function isBoundAttrValue(value: unknown): boolean {
  return isRef(value) || (typeof value === "string" && value.includes("${"));
}

// ─── Layout selection panel ─────────────────────────────────────────────────

/*
 * There is no `openLayoutAtNode`, and every line of it was wrong by the time it was deleted.
 *
 * Its docstring said `navigateToComponent` "swaps the tab's document (pushing the page onto the
 * document stack)" — two releases stale: nothing has swapped since §14.1 landed and there is no
 * document stack. Then it did four things, and the last three were the defect:
 *
 * 1. **Navigate.** Now the command's job, and the command opens the layout BESIDE the page rather
 *    than over the page it is teaching about — §8.2's promise since P3, never shipped.
 * 2. **`setLayoutSelection(null)`.** Its stated reason — "the layout is now the open document, so
 *    its nodes are ordinary editable content" — stops being true the moment the layout opens beside
 *    the page rather than replacing it. Clearing it is precisely what killed the follow on its first
 *    frame, and it is what made the Inspector blank at the instant the layout appeared.
 * 3. **Re-select against `activeTab`.** The focus deliberately stays in the page now, so the tab
 *    this reached was the wrong one. The selection is carried by the derivation instead —
 *    `pane-derive.ts`'s `DerivedTarget.select`, read from `shell.layoutSelection`'s `layoutPath`
 *    and applied to the companion pane's tab once the open resolves. For one release that sentence
 *    was written here and nothing implemented it: `layoutPath` had no consumer outside the canvas
 *    hit test, `derivationFor("layout")` stored `{resolved: null}`, and the exact regression this
 *    ledger entry describes — dropped into a layout file with nothing selected — was back while
 *    the comment denied it.
 *
 *    The companion resolves `shell.layoutSelection.layoutFile` in preference to the page's own
 *    `$layout` for the same reason the old code did: they are different answers for a nested chain,
 *    and the one the author clicked is the one they meant.
 * 4. **`renderOnly("rightPanel")`.** `panels/right-panel.ts:106` tracks `shell.layoutSelection`
 *    itself and `:212` reads it, so the repaint was already subscribed — a second, imperative
 *    subscription that only looked necessary because the function above had just cleared the state
 *    the real one is keyed on.
 */

/**
 * The Layout-element panel — what the inspector says when you click page chrome.
 *
 * It spent a release cycle unreachable: `shell.layoutSelection` had this reader and no writer, so
 * clicking the site name in the header — the first click a new user makes — did nothing at all. The
 * canvas hit test writes it now (§8.2), and `panels/right-panel.ts` tracks it, so the panel
 * renders.
 */
/**
 * The chip that opens the layout beside the page.
 *
 * **Drawn only where it can run**, which is why the condition lives at the call site rather than
 * inside the handler. `canvas/iframe-host.ts` focuses the pane a layout click landed in — including
 * a LENS, which draws layout chrome because it draws the same document — and from a derived pane
 * `pane.derive` can only throw `an open document in a pane that is not itself derived`, into a
 * floating `void registry.run(…)` that swallows it. A chip that does nothing when you press it is
 * worse than no chip: the sentence above it already says where the element comes from, and in that
 * shell the layout is either already beside you or one Unsplit away.
 */
function openLayoutTpl(): TemplateResult {
  return html`<span
    class="kv-add"
    @click=${() => {
      /* ONE command, addressed by id — the chip is a control, not a second definition site for
         what "open the layout" means. It opens the layout BESIDE the page and leaves the keyboard
         in the page, so the next click on layout chrome moves the side pane's selection instead of
         teaching the author what a pane is. */
      void activeRegistry()?.run("pane.derive", { preset: "layout" });
    }}
    >Open Layout →</span
  >`;
}

function renderLayoutSelectionPanel() {
  const selection = shell.layoutSelection as LayoutSelection;
  const tagName = selection.tagName || "element";
  const { className } = selection;
  const displayPath = selection.layoutFile || "layout";

  return html`
    <div class="style-sidebar">
      <sp-accordion allow-multiple size="s">
        <sp-accordion-item label="Layout Element" open>
          <div class="style-section-body">
            <div class="layout-origin">
              <span class="layout-origin-badge">Layout</span>
              <code class="layout-origin-tag">&lt;${tagName}&gt;</code>
            </div>
            ${
              className
                ? renderFieldRow({
                    hasValue: false,
                    label: "Class",
                    prop: "className",
                    widget: html`<span class="layout-origin-class">${className}</span>`,
                  })
                : nothing
            }
            <p class="layout-origin-note">
              This element comes from ${displayPath}, which wraps every page that uses it. Open the
              layout to edit it.
            </p>
            ${deriveRefusal(workspace.activePaneId) === null ? openLayoutTpl() : nothing}
          </div>
        </sp-accordion-item>
      </sp-accordion>
    </div>
  `;
}

// ─── Usages (§9.6) ───────────────────────────────────────────────────────────

/**
 * The Usage section's key, in the same per-tab `inspectorSections` record every other section uses,
 * so `inspector.setSection` addresses it exactly like the rest and nothing needs a second store.
 */
const USAGES_SECTION = "__usages";

/**
 * The component instance's usage line — "Used on 7 pages →", expanding to the files.
 *
 * Three things this deliberately does NOT do. It does not render when the host cannot answer
 * (`usagesSupported()` is `capability.findReferences`): a confident "0" for a component used
 * everywhere is worse than no line at all. It does not ask on every paint — `peekUsages` is
 * side-effect-free and only a cold target starts a request, which repaints once when it lands. And
 * it does not swallow a failure: a failed count says so and offers Retry, because "we could not
 * check" and "nothing uses this" are the two answers a user must never confuse.
 *
 * @param tagName — the instance's custom-element tag.
 * @param componentPath — its definition file, when the registry knows one. Passing both asks the
 *   one question that covers file references AND element instances.
 */
function renderUsagesSection(tagName: string, componentPath: string | null) {
  const query = { tagName, ...(componentPath ? { path: componentPath } : {}) };
  const state = peekUsages(query);
  // ONE gate, and it is the peek itself: a host with no `findReferences` answers "unsupported"
  // Synchronously, and the section does not exist. A separate `usagesSupported()` guard above this
  // Would make the arm below unreachable, which is a branch nothing can ever test.
  if (state?.status === "unsupported") {
    return nothing;
  }
  if (state === null) {
    // Cold: ask once, and repaint the inspector when the answer arrives.
    void loadUsages(query).then(() => renderOnly("rightPanel"));
  }

  let body;
  let heading = "Usage";
  if (state === null || state.status === "pending") {
    body = html`<div class="usage-note">Counting references…</div>`;
  } else if (state.status === "failed") {
    heading = "Usage · unknown";
    body = html`
      <div class="usage-note">
        References could not be counted: ${state.message}. This is not the same as “unused”.
      </div>
      <sp-action-button
        size="s"
        quiet
        @click=${() => {
          void retryUsages(query).then(() => renderOnly("rightPanel"));
        }}
        >Retry</sp-action-button
      >
    `;
  } else {
    const files = usageFiles(state.result);
    heading = usageHeadline(state.result);
    body =
      files.length === 0
        ? html`<div class="usage-note">
            Nothing else in this project places <code>&lt;${tagName}&gt;</code> yet.
          </div>`
        : html`${files.map(
            (file) => html`
              <button
                class="usage-row"
                type="button"
                title=${file.refs.map((r) => `${r.refType} ${r.ref} ×${r.count}`).join(", ")}
                @click=${() => openUsage(file.path)}
              >
                <span class="usage-row-path">${file.path}</span>
                <span class="usage-row-count">${file.count}</span>
              </button>
            `,
          )}`;
  }

  return html`
    <sp-accordion-item
      label=${heading}
      ?open=${isInspectorSectionOpen(USAGES_SECTION, false)}
      @sp-accordion-item-toggle=${() =>
        setInspectorSection(USAGES_SECTION, !isInspectorSectionOpen(USAGES_SECTION, false))}
    >
      <div class="style-section-body">${body}</div>
    </sp-accordion-item>
  `;
}

/** Open a referencing file in a tab — the "→" half of "Used on N pages →". */
function openUsage(path: string): void {
  // Lazy import: `files/files.ts` imports this panel's siblings, and a static edge here would close
  // The inspector → files → inspector cycle.
  void import("../files/files").then((m) => m.openFileInTab(path));
}

/** Send the user to the tab that DOES answer, without this module importing the dock. */
function showLogicTab(): void {
  void import("./right-panel").then((m) => m.setInspectorTab("events"));
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * The Tag row when the tag is CHOSEN rather than typed.
 *
 * Read-only on purpose, for now. The branches and the pointer that picks between them are shown —
 * so the row answers "what can this element be, and what decides" without the author opening the
 * JSON — and each branch is editable as a name, which is the edit people actually make. Changing
 * the DISCRIMINANT is an expression edit and belongs to the formula builder; until this row grows
 * one, the honest thing is to show the pointer plainly rather than fake a control that cannot
 * express what is there.
 *
 * The hint is the row's own, not the shared expression hint, because this is the one `$expression`
 * position in Jx that is not live: the tag is decided when the element is created.
 *
 * @param {JxTagExpression} expression The choice declared on this element.
 * @param {JxPath} path The node being edited.
 */
function renderChosenTag(expression: JxTagExpression, path: JxPath) {
  const setBranch = (key: "value" | "initial" | "default", next: string) => {
    transactDoc(activeTab.value, (t) =>
      mutateUpdateProperty(t, path, "tagName", {
        $expression: { ...expression, [key]: next },
      }),
    );
  };
  const branchField = (label: string, value: string, key: "value" | "initial" | "default") => html`
    <label class="chosen-tag-branch">
      <span>${label}</span>
      <sp-textfield
        size="s"
        .value=${live(value)}
        autocomplete="off"
        list="tag-names"
        @input=${debouncedStyleCommit(`prop:tagName:${key}`, 400, (e: Event) => {
          setBranch(key, (e.target as HTMLInputElement).value);
        })}
      ></sp-textfield>
    </label>
  `;
  const target = isRef(expression.target) ? expression.target.$ref : "an expression";
  return html`
    <div class="chosen-tag">
      <p class="chosen-tag-hint">Chosen from <code>${target}</code> when the element is created.</p>
      ${
        expression.operator === "?:"
          ? html`${branchField("When set", expression.value, "value")}
            ${branchField("Otherwise", expression.initial, "initial")}`
          : html`${Object.entries(expression.cases).map(
              ([key, tag]) => html`<p class="chosen-tag-case"><code>${key}</code> → ${tag}</p>`,
            )}
            ${branchField("Otherwise", expression.default, "default")}`
      }
    </div>
  `;
}

/**
 * The Content tab — lit-html template with accordion sections.
 *
 * @param {{ navigateToComponent: (path: string) => void }} ctx
 */
export function renderPropertiesPanelTemplate(ctx: {
  navigateToComponent: (path: string) => void;
}) {
  const tab = activeTab.value;
  if (!tab) {
    return renderEmptyState({
      actions: [openPageAction()],
      message: "Open a page to inspect and style what you click.",
    });
  }

  // Layout element selected — show read-only info with link to open layout
  if (shell.layoutSelection) {
    return renderLayoutSelectionPanel();
  }

  const selected = primarySelection(tab.session.selection);
  if (!selected) {
    return renderEmptyState({ message: clickAnythingTo("edit its content") });
  }
  const path: JxPath = selected;
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return renderEmptyState({ message: staleSelectionMessage() });
  }

  // A repeating list has no content of its own — it has a source and a template, and both are
  // Wiring. Content says where the answer lives rather than drawing an empty accordion (§6.5).
  if (node.$prototype === "Array") {
    return renderEmptyState({
      actions: [{ label: "Open Logic", run: showLogicTab }],
      detail: "Its items, filter, sort and template are wiring, so they live in Logic.",
      message: "A repeating list has no content of its own.",
    });
  }

  // The whole selection the Content tab edits. `[path]` when one element is selected, which is
  // Every existing call site's behaviour unchanged.
  const targets: JxPath[] = tab.session.selection.length > 0 ? tab.session.selection : [path];
  const doc = tab.doc.document;
  const isCustomInstance = displayTagName(node.tagName).includes("-");
  const chosenTag = isTagExpression(node.tagName) ? node.tagName.$expression : null;
  const tagName = displayTagName(node.tagName) || "div";
  const attrs = node.attributes || {};

  const mapSignals = mapSignalsFor(path);
  // Signals offered to attribute/textContent bindings (handlers and Functions excluded).
  const bindableSignals = bindableSignalNames(tab.doc.document);

  function renderAttrRow(attr: string, entry: HtmlMetaEntry, value: unknown) {
    const type = inferInputType(entry);
    const hasVal = value !== undefined && value !== "";
    // One write per selected element, inside ONE transaction (§6.5). `targets` is `[path]` for a
    // Single selection, so this is the same single mutation it has always been.
    const commitAttr = (v?: JsonValue) =>
      transactDoc(activeTab.value!, (t) => {
        for (const target of targets) {
          mutateUpdateAttribute(t, target, attr, v as JxAttributeValue | undefined);
        }
      });

    // Enhanced Link handling: only for anchors (a/area) with a plain (non-binding) value. Bindings
    // ($ref objects or ${…} template strings) fall through to the raw widget to stay editable.
    const isAnchor = tagName === "a" || tagName === "area";
    if (isAnchor && !isBoundAttrValue(value)) {
      if (attr === "href") {
        return renderLinkTargetField(node, path);
      }
      if (attr === "target") {
        return renderTargetField(node, path, entry);
      }
    }

    const attrSlot = (staticWidget: unknown) =>
      renderDynamicSlot({
        caps: "attribute",
        extraSignals: mapSignals,
        fieldKey: `attr|${path.join("/")}|${attr}`,
        onChange: commitAttr,
        staticWidget,
        stateDefs: bindableSignals,
        value,
      });

    const literalWidget =
      entry.type === "boolean"
        ? html`
            <sp-checkbox
              size="s"
              .checked=${live(Boolean(value))}
              @change=${(e: Event) => commitAttr((e.target as HTMLInputElement).checked ? "" : undefined)}
            >
            </sp-checkbox>
          `
        : widgetForType(type, entry, attr, isRef(value) ? "" : String(value || ""), (v: string) =>
            commitAttr(v || undefined),
          );
    const slot = attrSlot(literalWidget);
    return renderFieldRow({
      hasValue: hasVal,
      label: attrLabel(entry, attr),
      labelExtra: slot.modeButton,
      prop: attr,
      provenance: attributeProvenance(
        attr,
        value,
        hasVal,
        () =>
          transactDoc(activeTab.value, (t) => {
            for (const target of targets) {
              mutateUpdateAttribute(t, target, attr);
            }
          }),
        mixedAcrossSelection(doc, targets, (n) => (n?.attributes ?? {})[attr] ?? null),
      ),
      widget: slot.widget,
    });
  }

  // ── Collect applicable attributes from html-meta ──
  const applicableAttrs = {} as Record<string, HtmlMetaEntry>;
  for (const [attr, entry] of Object.entries(htmlMeta.$defs) as [string, HtmlMetaEntry][]) {
    if (!entry.$elements || entry.$elements.includes(displayTagName(tagName))) {
      // The $attr field aliases a $defs key to a different attribute name.
      // This lets the same attribute (e.g. "name") carry per-element metadata.
      applicableAttrs[entry.$attr ?? attr] = entry;
    }
  }

  const attrSections: Record<string, { name: string; entry: HtmlMetaEntry }[]> = {};
  for (const sec of htmlMeta.$sections) {
    attrSections[sec.key] = [];
  }
  for (const [attr, entry] of Object.entries(applicableAttrs)) {
    const secKey = entry.$section;
    if (attrSections[secKey]) {
      attrSections[secKey].push({ entry, name: attr });
    }
  }
  for (const sec of htmlMeta.$sections) {
    attrSections[sec.key]!.sort(
      (a: { name: string; entry: HtmlMetaEntry }, b: { name: string; entry: HtmlMetaEntry }) =>
        a.entry.$order - b.entry.$order,
    );
  }

  const knownAttrNames = new Set(Object.keys(applicableAttrs));
  if (isCustomInstance) {
    const comp = componentRegistry.find((c) => c.tagName === node.tagName);
    if (comp?.props) {
      for (const p of comp.props) {
        knownAttrNames.add(p.name);
      }
    }
  }
  const customAttrs = Object.entries(attrs).filter(([k]) => !knownAttrNames.has(k));

  const autoOpen = new Set();
  for (const [attr] of Object.entries(attrs)) {
    const entry = applicableAttrs[attr];
    if (entry) {
      autoOpen.add(entry.$section);
    }
  }
  if (customAttrs.length > 0) {
    autoOpen.add("__custom");
  }

  function isSectionOpen(key: string) {
    return isInspectorSectionOpen(key, autoOpen.has(key));
  }

  function toggleSection(key: string) {
    // One writer: the accordion's own click and `inspector.setSection` land in the same function,
    // So the command and the control cannot disagree about what "open" means.
    setInspectorSection(key, !isSectionOpen(key));
  }

  // ── Build section templates ─────────────────────────────────────────

  const textSlot = renderDynamicSlot({
    caps: "textProperty",
    extraSignals: mapSignals,
    fieldKey: `prop|${path.join("/")}|textContent`,
    onChange: (v?: JsonValue) =>
      transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "textContent", v)),
    staticWidget: spTextArea(
      "prop:textContent",
      typeof node.textContent === "string" ? node.textContent : "",
      (v: string) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateProperty(t, path, "textContent", v || undefined),
        ),
    ),
    stateDefs: bindableSignals,
    value: node.textContent,
  });

  /**
   * The set-here chip for a document property, with the tooltip in the label's own words.
   *
   * The derived tooltip would read "Clear textContent"; the label above it reads "Text Content".
   * The row's key and the row's name are different vocabularies, and the tooltip belongs to the one
   * the user is looking at.
   */
  const propertyChip = (name: string, human: string): FieldProvenance => ({
    onClick: () => transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, name)),
    state: "set",
    title: `Clear ${human}`,
  });

  const elemT = html`
    <sp-accordion-item
      label="Element"
      ?open=${isSectionOpen("__element") !== false}
      @sp-accordion-item-toggle=${() => toggleSection("__element")}
    >
      <div class="style-section-body">
        ${renderFieldRow({
          hasValue: chosenTag !== null,
          label: "Tag",
          prop: "tagName",
          /* A CHOSEN TAG IS NOT TYPEABLE, so the plain field is not offered for one.
             `tagName` may be a name or a choice between names. Binding the object into a textfield
             would have shown `[object Object]` and — the part that matters — the first keystroke
             would have replaced the whole expression with whatever was typed, destroying the
             author's branches with no undo prompt and no error. So the two shapes get two controls:
             a name is typed, and a choice is shown as its branches with the pointer that picks
             between them. */
          widget:
            chosenTag === null
              ? html`
                  <sp-textfield
                    size="s"
                    .value=${live(tagName)}
                    autocomplete="off"
                    list="tag-names"
                    @input=${debouncedStyleCommit("prop:tagName", 400, (e: Event) => {
                      transactDoc(activeTab.value, (t) =>
                        mutateUpdateProperty(
                          t,
                          path,
                          "tagName",
                          (e.target as HTMLInputElement).value || undefined,
                        ),
                      );
                    })}
                  ></sp-textfield>
                `
              : renderChosenTag(chosenTag, path),
        })}
        ${renderFieldRow({
          hasValue: Boolean(node.$id),
          label: "ID",
          prop: "$id",
          ...(node.$id ? { provenance: propertyChip("$id", "ID") } : {}),
          widget: spTextField("prop:$id", String(node.$id || ""), (v: string) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateProperty(t, path, "$id", v || undefined),
            ),
          ),
        })}
        ${renderFieldRow({
          hasValue: Boolean(node.className),
          label: "Class",
          prop: "className",
          ...(node.className ? { provenance: propertyChip("className", "class") } : {}),
          widget: spTextField("prop:className", String(node.className || ""), (v: string) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateProperty(t, path, "className", v || undefined),
            ),
          ),
        })}
        ${
          !Array.isArray(node.children) || node.children.length === 0
            ? renderFieldRow({
                hasValue: node.textContent !== undefined,
                label: "Text Content",
                labelExtra: textSlot.modeButton,
                prop: "textContent",
                widget: textSlot.widget,
                ...(node.textContent === undefined
                  ? {}
                  : { provenance: propertyChip("textContent", "text") }),
              })
            : nothing
        }
        ${renderFieldRow({
          hasValue: Boolean(node.hidden),
          label: "Hidden",
          prop: "hidden",
          ...(node.hidden ? { provenance: propertyChip("hidden", "hidden") } : {}),
          widget: html`
            <sp-checkbox
              size="s"
              .checked=${live(Boolean(node.hidden))}
              @change=${(e: Event) =>
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateProperty(
                    t,
                    path,
                    "hidden",
                    (e.target as HTMLInputElement).checked || undefined,
                  ),
                )}
            >
            </sp-checkbox>
          `,
        })}
      </div>
    </sp-accordion-item>
  `;

  const compPropsT = isCustomInstance
    ? html`
        <sp-accordion-item label="Component Settings" open>
          <div class="style-section-body">
            ${renderComponentPropsFieldsTemplate(node, path, mapSignals, ctx.navigateToComponent)}
          </div>
        </sp-accordion-item>
      `
    : nothing;

  // "Used on N pages →". Only for a component instance: an ordinary <div> is not a thing that can
  // Be reused, so the question does not arise.
  const usagesT = isCustomInstance
    ? renderUsagesSection(
        displayTagName(tagName),
        componentRegistry.find((c) => c.tagName === displayTagName(tagName))?.path ?? null,
      )
    : nothing;

  const attrSectionTemplates = htmlMeta.$sections
    .filter((sec) => attrSections[sec.key]!.length > 0)
    .map((sec) => {
      const sectionAttrs = attrSections[sec.key]!;
      const setCount = sectionAttrs.filter(
        (a: { name: string; entry: HtmlMetaEntry }) => attrs[a.name] !== undefined,
      ).length;
      return html`
        <sp-accordion-item
          label=${sec.label}
          ?open=${isSectionOpen(sec.key)}
          @sp-accordion-item-toggle=${() => toggleSection(sec.key)}
        >
          ${sectionDot(setCount)}
          <div class="style-section-body">
            ${sectionAttrs.map((a: { name: string; entry: HtmlMetaEntry }) =>
              renderAttrRow(a.name, a.entry, attrs[a.name]),
            )}
          </div>
        </sp-accordion-item>
      `;
    });

  const customSectionT =
    customAttrs.length > 0 || Object.keys(attrs).length > 0
      ? html`
          <sp-accordion-item
            label="Custom"
            ?open=${isSectionOpen("__custom")}
            @sp-accordion-item-toggle=${() => toggleSection("__custom")}
          >
            ${sectionDot(customAttrs.length)}
            <div class="style-section-body">
              ${renderCustomAttrsFieldsTemplate(path, attrs, knownAttrNames)}
            </div>
          </sp-accordion-item>
        `
      : nothing;

  return html`
    <div class="style-sidebar">
      <sp-accordion allow-multiple size="s">
        ${elemT} ${compPropsT} ${usagesT} ${attrSectionTemplates} ${customSectionT}
      </sp-accordion>
    </div>
  `;
}

/**
 * The collapsed-header provenance dot (§6.2), and the end of a false affordance.
 *
 * It inherited `.set-dot`'s `cursor: pointer` and its "turns red on hover" rule, which together say
 * "click me to clear this" — and nothing happened, because it never had a handler. It is not a
 * control and it is not deleted either: §6.2 puts a provenance dot on collapsed accordion headers
 * precisely so a section's state is legible while closed, and clicking anywhere in the header
 * already toggles the section, so a second, different meaning for the same click would be worse
 * than the silence. So it keeps the information and gives up the affordance: an inert, labelled
 * indicator that says how many values in the section are set.
 */
function sectionDot(setCount: number) {
  return setCount > 0
    ? html`<span
        slot="heading"
        class="set-dot set-dot--section"
        aria-hidden="true"
        title=${`${setCount} value${setCount === 1 ? "" : "s"} set in this section`}
      ></span>`
    : nothing;
}

/** Which of §6.2's states an HTML-attribute row is in. Attributes have no third cascade layer. */
function attributeProvenance(
  attr: string,
  value: unknown,
  hasVal: boolean,
  onClear: () => void,
  mixedCount = 0,
): FieldProvenance {
  // Mixed first, for the same reason the Style tab decides it first: it is a fact about the
  // SELECTION, and the primary's own value says nothing about whether the others agree. A count of
  // 0 (a selection of one) can never reach this branch, so single-selection rows are untouched.
  if (mixedCount > 0) {
    return { donor: String(mixedCount), onClick: onClear, state: "mixed" };
  }
  if (hasVal && (isRef(value) || (typeof value === "string" && value.includes("${")))) {
    return { donor: bindingDonor(value), state: "bound", title: `Bound — ${attr}` };
  }
  return hasVal ? { onClick: onClear, state: "set", title: `Clear ${attr}` } : { state: "default" };
}

/**
 * How many selected elements disagree about `key` on `read` — 0 when they agree or there is one.
 *
 * The Content tab's two cascades (HTML attributes and component props) both need the same answer
 * about the same set, so the question is asked once here and answered with `unifyValues`, the same
 * comparison the Style tab uses.
 *
 * @param {JxMutableNode} doc
 * @param {readonly JxPath[]} targets
 * @param {(node: JxMutableNode | undefined) => unknown} read
 * @returns {number}
 */
export function mixedAcrossSelection(
  doc: JxMutableNode,
  targets: readonly JxPath[],
  read: (node: JxMutableNode | undefined) => unknown,
): number {
  if (targets.length < 2) {
    return 0;
  }
  const values = targets.map((path) => read(getNodeAtPath(doc, path) as JxMutableNode | undefined));
  return unifyValues(values).mixed ? targets.length : 0;
}

// ─── Section state ────────────────────────────────────────────────────────────

/**
 * The Inspector's fixed section keys — the accordion rows the inspector always draws.
 *
 * Attribute-schema sections add their own keys at render time (a class's `$section`), so this is a
 * floor, not a closed set: {@link inspectorSectionKeys} unions it with whatever the OPEN DOCUMENT
 * declares, and that union is what `inspector.setSection` validates against. A fixed enum would
 * refuse a section the user is looking at; no validation at all would accept the label the old
 * `inspector.toggleSection` step passed ("Element", not `__element`) and silently do nothing.
 *
 * `__media` left with the breakpoint definitions, which are Project Settings › Contexts now (P4).
 * `__observed`, `__cssprops` and `__cssparts` are drawn by the Logic tab; the key space is the
 * INSPECTOR's, not one tab's, so `inspector.setSection` keeps addressing all of them.
 */
export const INSPECTOR_SECTION_KEYS = [
  "__element",
  "__observed",
  "__usages",
  "__custom",
  "__cssprops",
  "__cssparts",
] as const;

export type InspectorSectionKey = (typeof INSPECTOR_SECTION_KEYS)[number];

/** Section keys addressable right now: the fixed rows plus any already recorded for this tab. */
export function inspectorSectionKeys(): string[] {
  const recorded = Object.keys(activeTab.value?.session.ui.inspectorSections ?? {});
  return [...new Set<string>([...INSPECTOR_SECTION_KEYS, ...recorded])];
}

/**
 * Whether one Inspector section is expanded, falling back to the caller's default.
 *
 * The fallback is the caller's because it is not a constant: an attribute section opens itself when
 * one of its attributes is set, and Usage never does. Only the panel drawing the row knows.
 */
export function isInspectorSectionOpen(section: string, fallback: boolean): boolean {
  const recorded = activeTab.value?.session.ui.inspectorSections?.[section];
  return recorded === undefined ? fallback : recorded;
}

/**
 * Open or close one Inspector section, per tab.
 *
 * The pair `{ section, open }` is the whole point: `inspector.toggleSection` named a DELTA against
 * a section whose state depended on the selected node's own attributes (`autoOpen`), so the same
 * three manifest steps opened a section on one document and closed it on the next. Writing a new
 * object rather than mutating in place is what the reactive read in `isSectionOpen` depends on.
 */
export function setInspectorSection(section: string, open: boolean): void {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  tab.session.ui.inspectorSections = { ...tab.session.ui.inspectorSections, [section]: open };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * The Inspector's section verb. **This is the setter that retires `inspector.toggleSection`.**
 *
 * @returns {AnyCommand[]}
 */
export function inspectorCommands(): AnyCommand[] {
  return [
    {
      args: argsSchema({
        open: booleanProperty("True to expand the section, false to collapse it."),
        section: stringProperty(
          "The section key — one of the fixed rows (__element, __observed, __usages, " +
            "__custom, __cssprops, __cssparts) or an attribute schema's own $section.",
        ),
      }),
      category: "View",
      id: "inspector.setSection",
      level: "document",
      menus: ["palette"],
      group: "4_docks",
      requires: "an open document",
      when: (ctx) => ctx.document.open,
      run: (_commandCtx, args) => {
        const open = booleanArg("inspector.setSection", args, "open");
        const section = stringArg("inspector.setSection", args, "section");
        const known = inspectorSectionKeys();
        if (!known.includes(section)) {
          throw new RangeError(
            `command "inspector.setSection" argument "section": "${section}" is not a section ` +
              `this document declares — declared: ${known.join(", ")}`,
          );
        }
        setInspectorSection(section, open);
      },
      title: "Show Inspector Section",
    },
    {
      /**
       * Find Usages. Defined ONCE, here, and rendered twice: the palette gets it from the app
       * registry, and `editor/context-menu.ts` pulls the `context/element` records out of this same
       * set into the menu it builds — so the row and the palette entry cannot drift in title, chord
       * or availability. It reads `ctx.selection.kind`, which both contexts populate from the node
       * under the cursor, so one `run` serves the menu's target and the canvas selection alike.
       *
       * `when` is the capability, not a `try`: a host with no `findReferences` route hides the
       * command rather than offering a verb that answers "0 usages" for a component on every page.
       */
      category: "Selection",
      id: "selection.findUsages",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "4_identity",
      undo: "none",
      when: (ctx) => ctx.capability.findReferences && ctx.selection.isComponentInstance,
      requires: "a component instance, on a backend that can search the project",
      run: () => {
        const tagName = componentSelectionTag();
        if (!tagName) {
          return;
        }
        const componentPath = componentRegistry.find((c) => c.tagName === tagName)?.path ?? null;
        setInspectorSection(USAGES_SECTION, true);
        void loadUsages({ tagName, ...(componentPath ? { path: componentPath } : {}) }).then(() =>
          renderOnly("rightPanel"),
        );
      },
      title: "Find Usages",
    },
  ];
}

/**
 * The tag of the selected component instance, or null.
 *
 * Read from the document rather than from a menu target so the one record works in both registries:
 * the context menu's own `getContext` reports the right-clicked node's tag as `selection.kind`, and
 * the app's reports the canvas selection's. This is the fallback for the app registry, where the
 * selection lives on the tab.
 */
function componentSelectionTag(): string | null {
  const tab = activeTab.value;
  const selection = primarySelection(tab?.session.selection);
  if (!tab || !selection) {
    return null;
  }
  const node = getNodeAtPath(tab.doc.document, selection);
  const tagName = typeof node?.tagName === "string" ? node.tagName : "";
  return tagName.includes("-") ? tagName : null;
}

/**
 * Register the Inspector's section verb.
 *
 * @param {CommandRegistry} registry
 */
export function registerInspectorCommands(registry: CommandRegistry): void {
  registry.registerAll(inspectorCommands());
}
