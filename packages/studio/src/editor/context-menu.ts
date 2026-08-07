/// <reference lib="dom" />
// ─── Clipboard & Context Menu ─────────────────────────────────────────────────
/**
 * The element context menu is a RENDERING of the command registry (UX-REDESIGN-PLAN §5.5).
 *
 * This file used to hold an 18-item literal of `{ label, action, danger }` records — a fourth
 * hand-maintained copy of verbs that also exist in the toolbar, the block action bar and the
 * keymap, with bare labels that taught no chords and hand-set danger styling. It now holds the
 * command RECORDS (next to their implementations, which have always lived here) and a renderer that
 * asks `registry.forPlacement("context/element")` what to draw.
 *
 * Everything a row prints is derived:
 *
 * - The `title` — the record is the only place the action is named;
 * - The chord, via `keymap.formatBinding(id)`, so ⌘C is finally taught where it is used;
 * - `destructive` styling, from the record rather than a per-row `danger: true`;
 * - `disabledReason(id)` as a greyed subtitle, so an inapplicable verb explains itself instead of
 *   vanishing and leaving the author to guess the menu is state-dependent at all.
 *
 * Group ordering and `when` filtering are the registry's; dividers fall where `group` changes. What
 * is left here is positioning, popover rendering, and the menu keyboard contract.
 */
import { html, nothing } from "lit-html";
import { jsonClone } from "../utils/studio-utils";
import { ref } from "lit-html/directives/ref.js";
import { htmlToJx } from "@jxsuite/markup/html-to-jx";
import { childIndex, getNodeAtPath, parentElementPath } from "../store";
import { activeTab, workspace } from "../workspace/workspace";
import { isSelected, isSpliceablePath, primarySelection } from "../tabs/selection";
import {
  mutateDuplicateNode,
  mutateInsertNode,
  mutateRemoveNode,
  mutateRemoveNodes,
  mutateReplaceStyle,
  mutateWrapNode,
  transactDoc,
} from "../tabs/transact";
import { notify } from "../services/notify";
import { convertToComponent } from "./convert-to-component";
import { componentRegistry } from "../files/components";
import { renderPopover } from "../ui/layers";
import { rectOf } from "../utils/geometry";
import { createCommandRegistry } from "../commands/registry";
import { defaultCommands, noopCommandDeps } from "../commands/defaults";
import { inspectorCommands } from "../panels/properties-panel";
import { usagesSupported } from "../services/references";
import { editorKindForMode, makeContext } from "../commands/context";

import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { CommandContext } from "../commands/context";
import type { Placement } from "../commands/levels";
import type { JxPath } from "../state";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";

type JxNode = JxMutableNode;

// ─── Clipboard helpers ───────────────────────────────────────────────────────

const JX_MIME = "web application/jx+json";

/** @param {JxNode | string} node */
function nodeToHtml(node: JxNode | string): string {
  if (typeof node === "string") {
    return node;
  }
  const tag = node.tagName || "div";
  let attrs = "";
  if (node.attributes) {
    for (const [k, v] of Object.entries(node.attributes)) {
      // Bound ($ref) attribute values have no static HTML representation — skip.
      if (typeof v === "object") {
        continue;
      }
      attrs += v === "" ? ` ${k}` : ` ${k}="${String(v).replaceAll('"', "&quot;")}"`;
    }
  }
  if (node.style) {
    const css = Object.entries(node.style)
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
    if (css) {
      attrs += ` style="${css.replaceAll('"', "&quot;")}"`;
    }
  }
  let inner = "";
  if (typeof node.textContent === "string") {
    inner = node.textContent;
  } else if (Array.isArray(node.children)) {
    inner = node.children.map((c) => nodeToHtml(c)).join("");
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Write a Jx node to the system clipboard with both jx+json and text/html types.
 *
 * @param {object} json
 */
async function writeToClipboard(json: Record<string, unknown>) {
  workspace.clipboard = json;
  try {
    const jxBlob = new Blob([JSON.stringify(json)], { type: JX_MIME });
    const htmlBlob = new Blob([nodeToHtml(json)], { type: "text/html" });
    await navigator.clipboard.write([
      new ClipboardItem({
        [JX_MIME]: jxBlob,
        "text/html": htmlBlob,
      }),
    ]);
  } catch {
    // Fallback: write as plain text if custom MIME not supported
    try {
      await navigator.clipboard.writeText(JSON.stringify(json));
    } catch {
      // Clipboard API unavailable — workspace.clipboard is the fallback
    }
  }
}

/**
 * Read from the system clipboard. Returns Jx node(s) or null.
 *
 * @returns {Promise<JxNode[] | null>}
 */
async function readFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes(JX_MIME)) {
        const blob = await item.getType(JX_MIME);
        const json = JSON.parse(await blob.text()) as JxNode;
        return [json];
      }
      if (item.types.includes("text/html")) {
        const blob = await item.getType("text/html");
        const htmlStr = await blob.text();
        const nodes = htmlToJx(htmlStr);
        const jxNodes = nodes.map((n) =>
          typeof n === "string" ? { tagName: "p", textContent: n } : n,
        ) as JxNode[];
        if (jxNodes.length > 0) {
          return jxNodes;
        }
      }
      if (item.types.includes("text/plain")) {
        const blob = await item.getType("text/plain");
        const text = await blob.text();
        // Try parsing as Jx JSON
        try {
          const parsed = JSON.parse(text) as JxNode;
          if (parsed && parsed.tagName) {
            return [parsed];
          }
        } catch {
          // Plain text → paragraph node
        }
        if (text.trim()) {
          return [{ tagName: "p", textContent: text.trim() }];
        }
      }
    }
  } catch {
    // Clipboard API unavailable — use workspace fallback
    if (workspace.clipboard) {
      return [jsonClone(workspace.clipboard)];
    }
  }
  return null;
}

// ─── Clipboard actions ───────────────────────────────────────────────────────

export async function copyNode() {
  const tab = activeTab.value;
  const selected = primarySelection(tab?.session.selection);
  if (!tab || !selected) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, selected);
  if (!node) {
    return;
  }
  const json = jsonClone(node);
  await writeToClipboard(json);
  notify.success("Copied", { key: "clipboard" });
}

export async function cutNode() {
  const tab = activeTab.value;
  const sel = primarySelection(tab?.session.selection);
  if (!tab || !sel || sel.length < 2) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, sel);
  if (!node) {
    return;
  }
  const json = jsonClone(node);
  await writeToClipboard(json);
  // The clipboard holds the primary node; the cut removes everything selected, in one undo step.
  const cutting = tab.session.selection.filter((path) => path.length >= 2);
  /* AND THE REMOVAL CAN BE REFUSED, which makes this a copy rather than a cut.
     `transactDoc` consults the collab gate, which pauses structural editing for the whole room
     while source is canonical. Reporting "Cut" anyway claims a removal that did not happen — and
     the toast's action is `edit.undo`, so the one recovery it offered was aimed at whatever edit
     came BEFORE this one. The gate raises its own keyed toast saying why; this one stays silent
     rather than adding a false claim beside it. */
  if (!transactDoc(tab, (t) => mutateRemoveNodes(t, cutting))) {
    return;
  }
  notify.success("Cut", { action: "edit.undo", key: "clipboard" });
}

export async function pasteNode() {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }

  const nodes = await readFromClipboard();
  if (!nodes || nodes.length === 0) {
    return;
  }

  const selected = primarySelection(tab.session.selection);
  const pPath = selected ?? [];
  const parent = getNodeAtPath(tab.doc.document, pPath);
  if (!parent) {
    return;
  }

  if (selected && selected.length >= 2) {
    const pp = parentElementPath(selected) as JxPath;
    const idx = childIndex(selected) as number;
    transactDoc(tab, (t) => {
      for (let i = 0; i < nodes.length; i++) {
        mutateInsertNode(t, pp, idx + 1 + i, nodes[i]!);
      }
    });
  } else {
    const idx = Array.isArray(parent.children) ? parent.children.length : 0;
    transactDoc(tab, (t) => {
      for (let i = 0; i < nodes.length; i++) {
        mutateInsertNode(t, pPath, idx + i, nodes[i]!);
      }
    });
  }
  notify.success("Pasted", { action: "edit.undo", key: "clipboard" });
}

export function copyStyles() {
  const tab = activeTab.value;
  const selected = primarySelection(tab?.session.selection);
  if (!tab || !selected) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, selected);
  if (!node?.style) {
    return;
  }
  workspace.styleClipboard = jsonClone(node.style);
  notify.success("Styles copied", { key: "clipboard" });
}

export function pasteStyles() {
  if (!workspace.styleClipboard) {
    return;
  }
  const tab = activeTab.value;
  const targets = tab?.session.selection ?? [];
  if (!tab || targets.length === 0) {
    return;
  }
  const style = jsonClone(workspace.styleClipboard);
  // Pasting one style onto six cards is the §6.5 example, and it is one undo step: `transactDoc`
  // Records everything its callback mutates as a single history entry.
  transactDoc(tab, (t) => {
    for (const sel of targets) {
      mutateReplaceStyle(t, sel, jsonClone(style));
    }
  });
  notify.success(
    targets.length === 1 ? "Styles pasted" : `Styles pasted to ${targets.length} elements`,
    { action: "edit.undo", key: "clipboard" },
  );
}

// ─── The menu target ─────────────────────────────────────────────────────────

/**
 * The node an open element menu addresses, plus the per-invocation hooks its rows need.
 *
 * The registry is module-level and long-lived; the target is per-right-click. Every record's `when`
 * / `enablement` / `run` reaches the node through {@link ElementCommandDeps.target}, which is what
 * lets one set of records serve every right-click without being rebuilt.
 */
export interface ElementMenuTarget {
  path: JxPath;
  node: JxMutableNode;
  /** Navigate to a component's own document. Absent when the host cannot open one. */
  onEditComponent?: ((path: string) => void) | undefined;
  /** Re-render the surface that opened the menu — the outline's inline title editor needs it. */
  rerender?: (() => void) | undefined;
}

/** What the element command records read from the rest of Studio. */
export interface ElementCommandDeps {
  /** The node the open menu addresses, or `null` when no menu is open. */
  target: () => ElementMenuTarget | null;
  /** The style payload available to paste, or `null` when nothing has been copied. */
  styleClipboard: () => JxStyle | null;
  /** The component document's path when `tagName` names a registered component, else `null`. */
  componentPathFor: (tagName: string) => string | null;
}

/** Whether the node is a repeater (an `Array` prototype node), whose one child is its template. */
function isArrayNode(node: JxMutableNode): boolean {
  return node.$prototype === "Array";
}

// ─── The element command records ─────────────────────────────────────────────

/**
 * The commands the element context menu contributes.
 *
 * `selection.duplicate`, `selection.delete` and `selection.repeat` are deliberately NOT here: they
 * are defined in `commands/defaults.ts` and already declare `context/element`, and a second
 * definition site is the exact failure the registry exists to prevent.
 *
 * `selection.repeat` was here, in this file's PRIVATE registry, which is why the two
 * `repeat-dialog` shots were quarantined: the app registry never held it, so the palette could not
 * list it, no chord could reach it, the AI could not call it, and
 * `__jxAutomation.run("selection.repeat")` answered "unknown command" — the Repeat dialog was
 * reachable by right-click and by nothing else.
 */
export function elementCommands(deps: ElementCommandDeps): AnyCommand[] {
  /** A menu is open over some node — the precondition every row in this file shares. */
  const hasTarget = () => deps.target() !== null;
  /** The target sits in a splice coordinate, so structural verbs can address it. */
  const spliceable = () => {
    const target = deps.target();
    return target !== null && isSpliceablePath(target.path);
  };
  /** Not the repeater itself: its content is the single `map` template, not a child list. */
  const notRepeater = () => {
    const target = deps.target();
    return target !== null && !isArrayNode(target.node);
  };
  /** The component document behind the target's tag, when there is one and it can be opened. */
  const editableComponent = () => {
    const target = deps.target();
    const tagName = target?.node.tagName;
    if (!target?.onEditComponent || !tagName) {
      return null;
    }
    return deps.componentPathFor(tagName);
  };

  const NOT_STRUCTURAL =
    "an element with a sibling position — not the page root or a repeater item";

  return [
    // ── Clipboard ──
    {
      id: "edit.copy",
      title: "Copy",
      category: "Edit",
      level: "selection",
      keyScope: "canvas",
      keybinding: "mod+c",
      menus: ["context/element", "palette"],
      group: "1_clipboard",
      undo: "none",
      when: hasTarget,
      requires: "an element to copy",
      run: () => copyNode(),
    },
    {
      id: "edit.cut",
      title: "Cut",
      category: "Edit",
      level: "selection",
      keyScope: "canvas",
      keybinding: "mod+x",
      menus: ["context/element", "palette"],
      group: "1_clipboard",
      undo: "document",
      when: hasTarget,
      enablement: spliceable,
      requires: NOT_STRUCTURAL,
      run: () => cutNode(),
    },
    {
      id: "edit.pasteAfter",
      title: "Paste after",
      category: "Edit",
      level: "selection",
      keyScope: "canvas",
      keybinding: "mod+v",
      menus: ["context/element", "palette"],
      group: "1_clipboard",
      undo: "document",
      when: hasTarget,
      enablement: () => spliceable() && notRepeater(),
      requires: NOT_STRUCTURAL,
      run: async () => {
        const target = deps.target();
        const nodes = await readFromClipboard();
        if (!target || !nodes || nodes.length === 0) {
          return;
        }
        const parent = parentElementPath(target.path) as JxPath;
        const idx = childIndex(target.path) as number;
        transactDoc(activeTab.value, (t) => {
          for (const [offset, node] of nodes.entries()) {
            mutateInsertNode(t, parent, idx + 1 + offset, node);
          }
        });
        notify.success("Pasted", { action: "edit.undo", key: "clipboard" });
      },
    },
    {
      id: "edit.pasteInside",
      title: "Paste inside",
      category: "Edit",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "1_clipboard",
      undo: "document",
      when: hasTarget,
      // A repeater has no child list to paste into, and the document root is addressed by the
      // Canvas itself rather than by an element menu.
      enablement: () => {
        const target = deps.target();
        return target !== null && target.path.length >= 2 && notRepeater();
      },
      requires: "a container element that is not a repeater",
      run: async () => {
        const target = deps.target();
        const nodes = await readFromClipboard();
        if (!target || !nodes || nodes.length === 0) {
          return;
        }
        const idx = Array.isArray(target.node.children) ? target.node.children.length : 0;
        transactDoc(activeTab.value, (t) => {
          for (const [offset, node] of nodes.entries()) {
            mutateInsertNode(t, target.path, idx + offset, node);
          }
        });
        notify.success("Pasted", { action: "edit.undo", key: "clipboard" });
      },
    },

    // ── Styles ──
    {
      id: "edit.copyStyles",
      title: "Copy styles",
      category: "Edit",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "2_styles",
      undo: "none",
      when: hasTarget,
      enablement: () => Boolean(deps.target()?.node.style),
      requires: "styles on the selected element",
      run: () => {
        const style = deps.target()?.node.style;
        if (!style) {
          return;
        }
        workspace.styleClipboard = jsonClone(style);
        notify.success("Styles copied", { key: "clipboard" });
      },
    },
    {
      id: "edit.pasteStyles",
      title: "Paste styles",
      category: "Edit",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "2_styles",
      undo: "document",
      when: hasTarget,
      enablement: () => deps.styleClipboard() !== null,
      requires: "a copied style set",
      run: () => {
        const target = deps.target();
        const style = deps.styleClipboard();
        if (!target || !style) {
          return;
        }
        const clone = jsonClone(style);
        transactDoc(activeTab.value, (t) => mutateReplaceStyle(t, target.path, clone));
        notify.success("Styles pasted", { action: "edit.undo", key: "clipboard" });
      },
    },

    // ── Structure ── (shares "3_structure" with the default set's Duplicate)
    {
      id: "selection.insertBefore",
      title: "Insert before",
      category: "Insert",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "3_structure",
      undo: "document",
      when: hasTarget,
      enablement: spliceable,
      requires: NOT_STRUCTURAL,
      run: () => insertSiblingParagraph(deps.target(), 0),
    },
    {
      id: "selection.insertAfter",
      title: "Insert after",
      category: "Insert",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "3_structure",
      undo: "document",
      when: hasTarget,
      enablement: spliceable,
      requires: NOT_STRUCTURAL,
      run: () => insertSiblingParagraph(deps.target(), 1),
    },
    {
      id: "selection.wrap",
      title: "Wrap in Div",
      category: "Selection",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "3_structure",
      undo: "document",
      when: hasTarget,
      enablement: spliceable,
      requires: NOT_STRUCTURAL,
      run: () => {
        const target = deps.target();
        if (target) {
          transactDoc(activeTab.value, (t) => mutateWrapNode(t, target.path));
        }
      },
    },

    // ── Identity ──
    {
      id: "selection.setTitle",
      title: "Set Title",
      category: "Selection",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "4_identity",
      undo: "document",
      // The inline title editor lives in the surface that opened the menu; with no `rerender` hook
      // There is nothing to edit into, and the row used to render as a silent no-op.
      when: () => Boolean(deps.target()?.rerender),
      enablement: spliceable,
      requires: NOT_STRUCTURAL,
      run: async () => {
        const target = deps.target();
        if (!target?.rerender) {
          return;
        }
        // Lazy import breaks the context-menu ↔ layers-panel module cycle
        const { startLayerTitleEdit } = await import("../panels/layers-panel");
        startLayerTitleEdit(target.path, target.rerender);
      },
    },
    {
      id: "selection.editComponent",
      title: "Edit Component",
      category: "Selection",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "4_identity",
      undo: "none",
      when: () => editableComponent() !== null,
      requires: "a component instance",
      run: () => {
        const target = deps.target();
        const path = editableComponent();
        if (target?.onEditComponent && path) {
          target.onEditComponent(path);
        }
      },
    },
    {
      id: "selection.convertToComponent",
      title: "Convert to Component",
      category: "Selection",
      level: "selection",
      menus: ["context/element", "palette"],
      group: "4_identity",
      undo: "project",
      when: () => {
        const target = deps.target();
        const tagName = target?.node.tagName;
        return Boolean(tagName) && deps.componentPathFor(tagName as string) === null;
      },
      enablement: spliceable,
      requires: NOT_STRUCTURAL,
      run: () => convertToComponent(),
    },
  ];
}

/** Insert an empty paragraph `offset` positions from the target (0 = before, 1 = after). */
function insertSiblingParagraph(target: ElementMenuTarget | null, offset: number): void {
  if (!target) {
    return;
  }
  const parent = parentElementPath(target.path) as JxPath;
  const idx = childIndex(target.path) as number;
  transactDoc(activeTab.value, (t) =>
    mutateInsertNode(t, parent, idx + offset, { children: [], tagName: "p" }),
  );
}

/** Define the element menu's commands on `registry`. Throws on a duplicate id or chord clash. */
export function registerElementCommands(registry: CommandRegistry, deps: ElementCommandDeps): void {
  registry.registerAll(elementCommands(deps));
}

// ─── The live registry ───────────────────────────────────────────────────────

/** The node the currently open menu addresses. */
let _target: ElementMenuTarget | null = null;

/** Deps bound to the live modules. */
const liveDeps: ElementCommandDeps = {
  componentPathFor: (tagName) =>
    // A custom-element tag is the only thing that CAN name a component; the registry lookup is
    // What decides whether it does.
    (tagName.includes("-") && componentRegistry.find((c) => c.tagName === tagName)?.path) || null,
  styleClipboard: () => workspace.styleClipboard,
  target: () => _target,
};

/**
 * The facts the predicates read, derived from the open menu's target.
 *
 * `selection.isRoot` is the context's "this selection has no removable position" flag — it is what
 * `selection.delete` gates on — so it reports true for a repeater template as well as for the
 * document root. Both are unspliceable, and treating only the literal root as root would let Delete
 * splice a template at NaN (see {@link isSpliceablePath}).
 */
function liveContext(): CommandContext {
  const target = _target;
  const tab = activeTab.value;
  return makeContext({
    // The menu's context has to carry capabilities too, now that it renders a record gated on one:
    // `makeContext` defaults every capability to false, which would hide Find Usages on every host.
    capability: { findReferences: usagesSupported() },
    document: { dirty: Boolean(tab?.doc.dirty), open: Boolean(tab) },
    /* The editor the menu was opened over. `makeContext` defaults this to "none", which was a
       falsehood the records here got away with only because every one of them gates on the menu's
       own target instead: a verb that reads `editor.kind` — as the canvas verbs in `shortcuts.ts`
       now do — would have been dead in this menu and live over a settings document, which is
       exactly backwards. The menu opens from the canvas AND from the Outline, so the kind comes
       from the tab rather than being asserted. */
    editor: { kind: tab ? editorKindForMode(tab.session.ui.canvasMode) : "none" },
    selection: {
      count: target ? 1 : 0,
      isComponentInstance: Boolean(target && liveDeps.componentPathFor(target.node.tagName ?? "")),
      isRepeater: target ? isArrayNode(target.node) : false,
      isRoot: target ? !isSpliceablePath(target.path) : false,
      kind: target?.node.tagName ?? "",
    },
  });
}

let _registry: CommandRegistry | null = null;

/**
 * The registry the menu renders.
 *
 * It carries this file's records PLUS every `context/element` record from `commands/defaults.ts`
 * (Duplicate and Delete). Those two have their one definition site there; until a bootstrap
 * composes every contribution point into a single app-wide registry, the menu builds its own and
 * supplies real implementations for exactly the verbs it renders.
 */
export function contextMenuRegistry(): CommandRegistry {
  if (_registry) {
    return _registry;
  }
  const registry = createCommandRegistry({ getContext: liveContext });
  const inherited = defaultCommands({
    ...noopCommandDeps(),
    // Neither implementation re-checks spliceability. `selection.delete` and `selection.duplicate`
    // Both declare `enablement: structurallyEditable`, which reads `selection.isRoot` — and
    // {@link liveContext} sets that from the very predicate a hand-guard here would repeat.
    // `registry.run` throws `CommandUnavailableError` before a disabled record's `run` is reached,
    // So the guard was unreachable, and a second copy of the invariant is how the two come to
    // Disagree.
    deleteSelection: () => {
      const target = _target;
      if (target) {
        transactDoc(activeTab.value, (t) => mutateRemoveNode(t, target.path));
      }
    },
    duplicateSelection: () => {
      const target = _target;
      if (target) {
        transactDoc(activeTab.value, (t) => mutateDuplicateNode(t, target.path));
      }
    },
  }).filter((command) => (command.menus ?? []).includes("context/element"));
  registry.registerAll(inherited);
  // Find Usages has its one definition site in `panels/properties-panel.ts`, beside the section it
  // Opens. Pulling its `context/element` records in here — the same move `defaultCommands` gets
  // Above — is what keeps the menu row and the palette entry a single record rather than two that
  // Drift.
  registry.registerAll(
    inspectorCommands().filter((command) => (command.menus ?? []).includes("context/element")),
  );
  registerElementCommands(registry, liveDeps);
  _registry = registry;
  return registry;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

/** One rendered row: a record plus everything the registry says about it right now. */
interface MenuRow {
  command: AnyCommand;
  enabled: boolean;
  /** The `requires` sentence, printed as a greyed subtitle when the row is disabled. */
  reason: string | undefined;
  chord: string | undefined;
  /** Whether a divider opens this row's group. */
  dividerAbove: boolean;
}

let _ctxHandle: ReturnType<typeof renderPopover> | null = null;
let _rows: MenuRow[] = [];
let _activeIdx = 0;
/** Whatever owned the keyboard before the menu took it, so it can be handed back. */
let _opener: HTMLElement | null = null;

/** The rendered `sp-menu-item` elements, in row order. */
function itemElements(): HTMLElement[] {
  return _ctxHandle
    ? [..._ctxHandle.host.querySelectorAll<HTMLElement>("sp-menu-item[data-command-id]")]
    : [];
}

/** Move the roving tabindex (and the caret) to `index`, wrapping at both ends. */
function focusItem(index: number): void {
  const items = itemElements();
  if (items.length === 0) {
    return;
  }
  const next = ((index % items.length) + items.length) % items.length;
  for (const [at, item] of items.entries()) {
    item.tabIndex = at === next ? 0 : -1;
    item.toggleAttribute("focused", at === next);
  }
  _activeIdx = next;
  items[next]?.focus();
}

/** Run the row's command, then close. Disabled rows explain themselves and do nothing. */
function activateRow(index: number): void {
  const row = _rows[index];
  if (!row?.enabled) {
    return;
  }
  // Run BEFORE dismissing: every `run` reads `deps.target()` synchronously on entry, and dismissal
  // Clears the target.
  const result = contextMenuRegistry().run(row.command.id);
  dismissContextMenu();
  void result;
}

/**
 * The menu keyboard contract: Up/Down/Home/End move, Enter/Space activate, Escape and Tab dismiss.
 *
 * Bound on `document` in the CAPTURE phase, the same shape `editor/slash-menu.ts` uses: the app's
 * own Escape (which walks the selection ladder) and the canvas arrow-key nudges must not also fire,
 * and a bubble-phase handler on the popover would race Spectrum's own menu key handling.
 */
function onMenuKeydown(e: KeyboardEvent): void {
  if (!_ctxHandle) {
    return;
  }
  switch (e.key) {
    case "ArrowDown": {
      focusItem(_activeIdx + 1);
      break;
    }
    case "ArrowUp": {
      focusItem(_activeIdx - 1);
      break;
    }
    case "Home": {
      focusItem(0);
      break;
    }
    case "End": {
      focusItem(_rows.length - 1);
      break;
    }
    case "Enter":
    case " ": {
      activateRow(_activeIdx);
      break;
    }
    case "Escape":
    case "Tab": {
      dismissContextMenu();
      break;
    }
    default: {
      return;
    }
  }
  e.preventDefault();
  e.stopPropagation();
}

/** Drop the menu's global state and hand the keyboard back to whatever opened it. */
function teardownMenu(): void {
  document.removeEventListener("keydown", onMenuKeydown, true);
  const opener = _opener;
  _target = null;
  _rows = [];
  _activeIdx = 0;
  _opener = null;
  // Only when the menu still held the keyboard: an outside CLICK has already moved focus somewhere
  // The author chose, and yanking it back to the opener would fight them.
  const active = document.activeElement;
  if (opener?.isConnected && (!active || active === document.body)) {
    opener.focus();
  }
}

/** Dismiss the context menu if open. */
export function dismissContextMenu() {
  if (!_ctxHandle) {
    return;
  }
  const handle = _ctxHandle;
  _ctxHandle = null;
  handle.dismiss();
  teardownMenu();
}

/** Ask the registry what belongs in `placement` right now and decorate each record for rendering. */
function buildRows(placement: Placement): MenuRow[] {
  const registry = contextMenuRegistry();
  let group: string | undefined;
  return registry.forPlacement(placement).map((command, index) => {
    const dividerAbove = index > 0 && command.group !== group;
    ({ group } = command);
    const enabled = registry.isEnabled(command.id);
    const chord = registry.keymap.formatBinding(command.id);
    return {
      // A chord that just restates the row's own name ("Delete" bound to Delete) teaches nothing
      // And reads as a stutter, so it is not printed.
      chord: chord?.toLowerCase() === command.title.toLowerCase() ? undefined : chord,
      command,
      dividerAbove,
      enabled,
      reason: enabled ? undefined : registry.disabledReason(command.id),
    };
  });
}

/** One row. Everything it prints comes off the record — nothing is passed in per call site. */
function rowTemplate(row: MenuRow, index: number) {
  return html`${
      row.dividerAbove ? html`<sp-menu-divider role="separator"></sp-menu-divider>` : nothing
    }<sp-menu-item
      role="menuitem"
      data-command-id=${row.command.id}
      tabindex=${index === 0 ? 0 : -1}
      ?disabled=${!row.enabled}
      aria-disabled=${row.enabled ? "false" : "true"}
      style=${row.command.destructive && row.enabled ? "color: var(--danger)" : ""}
      @click=${() => activateRow(index)}
      >${row.command.title}${
        row.chord
          ? html`<kbd slot="value" style="color: var(--fg-dim)">${row.chord}</kbd>`
          : nothing
      }${
        row.reason ? html`<span slot="description">Needs ${row.reason}</span>` : nothing
      }</sp-menu-item
    >`;
}

/**
 * @param {MouseEvent} e
 * @param {JxPath} path
 * @param {{
 *   onEditComponent?: (path: string) => void;
 *   rerender?: () => void;
 *   placement?: Placement;
 * }} [opts]
 */
export function showContextMenu(
  e: MouseEvent,
  path: JxPath,
  opts: {
    onEditComponent?: (path: string) => void;
    rerender?: () => void;
    /** Which registry placement to render. The canvas and the outline are both element menus. */
    placement?: Placement;
  } = {},
) {
  e.preventDefault();
  dismissContextMenu();

  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }

  // Select the node — the menu addresses it, and so does everything the commands read. A
  // Right-click INSIDE an existing multi-selection keeps that selection, the way every list does:
  // Collapsing six selected cards to one because the user aimed at one of them would silently
  // Retarget the very batch commands the menu is about to offer.
  if (!isSelected(tab.session.selection, path)) {
    tab.session.selection = [path];
  }
  _target = { node, onEditComponent: opts.onEditComponent, path, rerender: opts.rerender };
  _rows = buildRows(opts.placement ?? "context/element");
  if (_rows.length === 0) {
    _target = null;
    return;
  }
  _activeIdx = 0;
  _opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  let x = e.clientX,
    y = e.clientY;

  _ctxHandle = renderPopover(
    html`<sp-popover
      open
      style="position:fixed;z-index:10000;left:${x}px;top:${y}px"
      ${ref((el) => {
        if (!el) {
          return;
        }
        requestAnimationFrame(() => {
          const popover = el as HTMLElement;
          const menuRect = rectOf(popover);
          if (x + menuRect.width > window.innerWidth) {
            x = window.innerWidth - menuRect.width - 4;
          }
          if (y + menuRect.height > window.innerHeight) {
            y = window.innerHeight - menuRect.height - 4;
          }
          popover.style.left = `${x}px`;
          popover.style.top = `${y}px`;
        });
      })}
    >
      <sp-menu role="menu" aria-label="Element actions">
        ${_rows.map((row, index) => rowTemplate(row, index))}
      </sp-menu>
    </sp-popover>`,
    {
      dismissOnOutsideClick: true,
      onDismiss: () => {
        _ctxHandle = null;
        teardownMenu();
      },
    },
  );

  document.addEventListener("keydown", onMenuKeydown, true);
  // A frame later: lit has committed the items, and focusing the first row is what makes the whole
  // Keyboard contract reachable at all (the menu used to open with focus left behind it).
  requestAnimationFrame(() => focusItem(0));
}
