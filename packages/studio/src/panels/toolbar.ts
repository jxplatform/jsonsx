/// <reference lib="dom" />
/**
 * The Command Bar — region ① of UX-REDESIGN-PLAN §3.2, rendered FROM the registry.
 *
 * Every control in this band used to be hand-authored twice: once in `toolbarTemplate` and once in
 * `minimalToolbarTemplate`, a retyped copy of the same buttons with `disabled` hard-coded on each
 * one for the no-project case. That second copy is the canonical example of the defect §2 principle
 * 1 names — a hand-maintained list of actions beside the definition site — and §2 principle 4 says
 * enablement is a PREDICATE with a sentence, never a duplicated template. It is deleted. With no
 * project open the same bar renders; the records' own `when` clauses empty it.
 *
 * What is left is four things, none of which decides what an action is called:
 *
 * - {@link tbCmd} renders one command: title, icon, `title="Save (⌘S)"` with the chord formatted for
 *   THIS platform by `keymap.format` (the predecessor hardcoded `⌘P` and showed it to Windows and
 *   Linux users), disabled state from `enablement`, and the `requires` sentence in the tooltip when
 *   it is off — so no control is ever permanently dead with no explanation.
 * - The primary verb cluster is `forPlacement("commandbar/primary")`, capped at five by
 *   `scripts/check-chrome-budget.ts`; the ⬢ menu is `forPlacement("commandbar/overflow")`.
 * - The **Command Center pill** (①a) is the app's address bar: `◈ project › document › selection`,
 *   right-aligned ⌘K, each segment opening the palette pre-scoped. It replaces the Open Project
 *   split button, the recents dropdown and the `Search files… ⌘P` trigger, and it gives Studio a
 *   persistent project name for the first time — today it renders only in the Files panel header,
 *   and the desktop titlebar is `titleBarStyle:"hidden"`.
 * - The window controls, which are the one thing in here that is not an action.
 *
 * **Retired here, with a name, a chord and a residue** (§2 principle 9): Open Project + New Project
 * + recents → the pill and `Project: Open Recent…`; `Manage` → `File: Browse Library`; `Publish` →
 * the `Publish:` family; `Sync Project` → Source Control. The five-mode switcher leaves for the
 * pane context bar (region ⑦) and is reachable meanwhile as `View: Set Canvas Mode` in the palette,
 * which prompts for the mode from the record's own `args` enum.
 */

import { html, render as litRender, nothing } from "lit-html";
import { presenceChipsTemplate } from "../collab/presence-chips";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { shell } from "../shell";
import { openQuickSearch } from "./quick-search";
import { inspectorTab } from "./right-panel";
import { canvasBaseOrigin } from "../canvas/canvas-origin";
import { getPreviewNavigateHandler } from "../canvas/preview-navigate";
import { documentUrlPattern, dynamicRouteParams } from "../page-params";
import { getNodeAtPath, nodeLabel, projectState } from "../store";
import { activeRegistry } from "../commands/active-registry";
import { statusMessage } from "./statusbar";
import type { Tab } from "../tabs/tab";
import type { CommandRegistry } from "../commands/registry";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

/**
 * What the Command Bar is handed at mount.
 *
 * HANDOFF: **nothing here is read any more** — every control in the band is a command, so the bar
 * asks the registry rather than the bootstrap. The fields stay declared, and optional, so
 * `studio.ts`'s `toolbarPanel.mount(toolbarEl, { … })` object literal keeps type-checking; deleting
 * them is one edit in that file, which is another workstream's this wave.
 */
export interface ToolbarCtx {
  openProject?: () => void;
  openFile?: (path: string) => void;
  saveFile?: () => void;
  getCanvasMode?: () => string;
  setCanvasMode?: (mode: string) => void;
  renderCanvas?: () => void;
  safeRenderRightPanel?: () => void;
  openRecentProject?: (root: string) => Promise<void>;
  closeFunctionEditor?: () => void;
}

let _rootEl: HTMLElement | null = null;

/** Test override for the mac CSD layout — happy-dom forbids redefining navigator.platform. */
let _isMacOverride: boolean | null = null;

/** Force (or restore, with null) the mac/non-mac window-control layout detection. */
export function setMacPlatformForTests(value: boolean | null): void {
  _isMacOverride = value;
}

/** True on macOS — picks the CSD window-control order (close-first, toolbar-leading). */
function isMacPlatform(): boolean {
  return _isMacOverride ?? navigator.platform.startsWith("Mac");
}

let _scope: EffectScope | null = null;

/**
 * Icon key → Spectrum icon, for the `icon` a command record declares.
 *
 * The RECORD names the icon; this map only knows how to draw one. Keys are the record's vocabulary
 * ("save", "undo"), not Spectrum tag names, so swapping the icon set is a change here and nowhere
 * else — and a record that names an icon this bar cannot draw renders as a labelled button rather
 * than as an empty one.
 */
const COMMAND_ICONS: Readonly<Record<string, TemplateResult>> = {
  browser: html`<sp-icon-export slot="icon"></sp-icon-export>`,
  redo: html`<sp-icon-redo slot="icon"></sp-icon-redo>`,
  save: html`<sp-icon-save-floppy slot="icon"></sp-icon-save-floppy>`,
  undo: html`<sp-icon-undo slot="icon"></sp-icon-undo>`,
};

// ─── One command, one control ─────────────────────────────────────────────────

/** How {@link tbCmd} draws a record. Presentation only — never what the record means. */
export interface TbCmdOptions {
  /** Icon-only, with the title as the accessible name. Used by the dock toggles. */
  compact?: boolean;
  /** Rendered pressed. The dock toggles are the only controls with an on-state. */
  selected?: boolean;
  /** Override the record's icon — a dock toggle's glyph depends on which way the dock is. */
  icon?: TemplateResult;
}

/**
 * The tooltip a control shows: the action's name, plus its chord, or plus WHY it is off.
 *
 * One string, three sources, all from the record: `title`, `keymap.formatBinding` and `requires`.
 * `tbBtnTpl(label, onClick, icon)` — the predecessor — could express none of them, which is why
 * "Open in Browser" had to hand-build its own disabled variant with a bespoke reason string.
 */
export function commandTooltip(registry: CommandRegistry, id: string): string {
  const command = registry.get(id);
  if (!command) {
    return "";
  }
  const reason = registry.disabledReason(id);
  if (reason) {
    return `${command.title} — requires ${reason}`;
  }
  const chord = registry.keymap.formatBinding(id);
  return chord ? `${command.title} (${chord})` : command.title;
}

/**
 * Render one command as a Command Bar button, or `nothing` when its `when` hides it.
 *
 * This is the whole of §5.5's first row: label, icon, tooltip, chord, disabled state and disabled
 * reason all come off the record, so the bar cannot disagree with the palette, the keymap or the
 * agent about any of them.
 */
export function tbCmd(registry: CommandRegistry, id: string, options: TbCmdOptions = {}) {
  const command = registry.get(id);
  if (!command || !registry.isVisible(id)) {
    return nothing;
  }
  const enabled = registry.isEnabled(id);
  const icon = options.icon ?? (command.icon ? COMMAND_ICONS[command.icon] : undefined);
  return html`
    <sp-action-button
      size="s"
      ?quiet=${options.compact === true}
      ?selected=${options.selected === true}
      title=${commandTooltip(registry, id)}
      aria-label=${command.title}
      ?disabled=${!enabled}
      @click=${() => {
        void registry.run(id);
      }}
    >
      ${icon ?? nothing}
      ${options.compact ? nothing : html`<span class="tb-label">${command.title}</span>`}
    </sp-action-button>
  `;
}

// ─── View: Open in Browser ───────────────────────────────────────────────────

/** Where `View: Open in Browser` would go, or the sentence explaining why it cannot go anywhere. */
export type BrowserTarget = { url: string } | { reason: string };

/**
 * Resolve the active document's built page to a URL on the server already serving this project.
 *
 * The origin is the canvas's own ({@link canvasBaseOrigin}) — the one a Preview link click resolves
 * against — and the path mirrors the compiler's `routeToOutputPath` exactly, so `/blog/hello/` asks
 * for `dist/blog/hello/index.html` under `trailingSlash: "always"` and `dist/blog/hello.html` under
 * `"never"`. Every server Studio runs against (the monorepo dev server via its active-project
 * fallback, `jx dev` via its root, the desktop loopback project server) serves that path.
 *
 * Everything that is not a page resolves to a REASON rather than to nothing: a disabled control the
 * user can hover is discoverable, an absent one is not.
 */
export function openInBrowserTarget(tab: Tab | null): BrowserTarget {
  const documentPath = tab?.documentPath?.replace(/^\.\//, "");
  if (!documentPath) {
    return { reason: "Open a page to view it in a browser." };
  }
  if (!projectState?.isSiteProject) {
    return { reason: "This project does not build a site." };
  }
  if (!documentPath.startsWith("pages/")) {
    return { reason: `Only pages have a route — ${documentPath} is not under pages/.` };
  }
  let route = documentUrlPattern(documentPath);
  if (route.includes("*")) {
    return { reason: "Catch-all routes match many pages — open a generated one instead." };
  }
  const params = dynamicRouteParams(documentPath);
  if (params.length > 0) {
    const chosen = (tab?.session.ui.previewParams ?? {}) as Record<string, string>;
    const missing = params.filter((name) => !chosen[name]);
    if (missing.length > 0) {
      const names = missing.map((name) => `:${name}`).join(", ");
      return { reason: `Pick a value for ${names} to open one of this route's pages.` };
    }
    route = route.replaceAll(/:(\w+)/g, (_m, name: string) => encodeURIComponent(chosen[name]!));
  }
  const origin = canvasBaseOrigin();
  if (!origin.startsWith("http://") && !origin.startsWith("https://")) {
    return { reason: "No local server is serving this project yet." };
  }
  const trailingSlash = projectState.projectConfig?.build?.trailingSlash ?? "always";
  const output =
    route === "/"
      ? "/index.html"
      : trailingSlash === "always"
        ? `${route}/index.html`
        : `${route}.html`;
  return { url: `${origin}/dist${output}` };
}

/**
 * Hand a URL to the user's real browser.
 *
 * Reuses the seam the desktop launchers already register for Preview link clicks
 * (`canvas/preview-navigate.ts`), which routes through the OS rather than navigating a webview with
 * no address bar; the browser build falls back to a new tab.
 */
function openUrlExternally(url: string) {
  const override = getPreviewNavigateHandler();
  if (override) {
    override(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Run `View: Open in Browser`, reporting the blocking reason when there is one.
 *
 * Exported as the implementation the bootstrap hands to the record — the ⌘⇧O chord is the record's
 * `keybinding` now, so the bespoke `document.addEventListener("keydown", …)` this file used to
 * install (with its own `isModalOpen()` guard, its own shift test and no way to be rebound) is
 * deleted.
 */
export function runOpenInBrowser() {
  const target = openInBrowserTarget(activeTab.value ?? null);
  if ("url" in target) {
    openUrlExternally(target.url);
    return;
  }
  statusMessage(target.reason);
}

// ─── ①a The Command Center pill ──────────────────────────────────────────────

/** One segment of the address, and the palette mode it opens. */
interface PillSegment {
  key: string;
  label: string;
  title: string;
  onClick: () => void;
}

/** The document's label: its path without the project root, which is already segment one. */
export function documentSegmentLabel(tab: Tab | null): string {
  const path = tab?.documentPath;
  if (!path) {
    return "No document";
  }
  const root = projectState?.projectRoot;
  const trimmed = path.replace(/^\.\//, "");
  return root && trimmed.startsWith(`${root}/`) ? trimmed.slice(root.length + 1) : trimmed;
}

/** The selection's label — the Outline's own `nodeLabel`, so the two never disagree. */
export function selectionSegmentLabel(tab: Tab | null): string {
  if (shell.layoutSelection) {
    return "layout";
  }
  const selection = tab?.session.selection;
  if (!tab || !selection) {
    return "";
  }
  return nodeLabel(getNodeAtPath(tab.doc.document, selection));
}

/**
 * `◈ project › document › selection`, right-aligned ⌘K.
 *
 * Four facts about where you are, in non-collapsible chrome (§4.4), each one click-through to the
 * surface that owns it. The empty space between the segments opens the mode picker, which is what
 * makes the pill an address bar rather than three buttons.
 */
function commandCenterTpl(registry: CommandRegistry | null) {
  const tab = activeTab.value ?? null;
  const chord = registry?.keymap.formatBinding("palette.open") ?? "";
  const selection = selectionSegmentLabel(tab);
  const segments: PillSegment[] = [
    {
      key: "project",
      label: projectState?.name ?? "No project",
      title: "Switch project — opens Project: Open Recent…",
      onClick: () => openQuickSearch("projects"),
    },
    {
      key: "document",
      label: documentSegmentLabel(tab),
      title: "Go to a file",
      onClick: () => openQuickSearch("files"),
    },
  ];
  if (selection) {
    segments.push({
      key: "selection",
      label: selection,
      title: "Go to an element in this document",
      onClick: () => openQuickSearch("nodes"),
    });
  }
  return html`
    <div
      class="tb-center"
      role="group"
      aria-label="Command Center"
      @click=${() => openQuickSearch("picker")}
    >
      <span class="tb-center-mark" aria-hidden="true">◈</span>
      ${segments.map(
        (segment, index) => html`
          ${index > 0 ? html`<span class="tb-center-sep" aria-hidden="true">›</span>` : nothing}
          <button
            class="tb-center-seg"
            type="button"
            title=${segment.title}
            @click=${(e: Event) => {
              e.stopPropagation();
              segment.onClick();
            }}
          >
            ${segment.label}
          </button>
        `,
      )}
      ${chord ? html`<kbd class="tb-center-chord">${chord}</kbd>` : nothing}
    </div>
  `;
}

// ─── The ⬢ app menu (commandbar/overflow) ────────────────────────────────────

/**
 * Everything that declared `commandbar/overflow` — the chrome's residue for retired controls.
 *
 * Rendered as a menu of the records themselves, so a command that moves from the primary cluster to
 * the overflow keeps its name, its chord and its gate, and the move is one edit to its `menus`.
 */
function appMenuTpl(registry: CommandRegistry) {
  const commands = registry.forPlacement("commandbar/overflow");
  return html`
    <overlay-trigger placement="bottom-start" triggered-by="click">
      <sp-action-button size="s" quiet slot="trigger" title="Studio menu" aria-label="Studio menu">
        <sp-icon-show-menu slot="icon"></sp-icon-show-menu>
      </sp-action-button>
      <sp-popover slot="click-content" tip>
        <sp-menu
          @change=${(e: Event) => {
            const id = (e.target as unknown as HTMLInputElement).value;
            if (registry.isEnabled(id)) {
              void registry.run(id);
            }
          }}
        >
          ${commands.map(
            (command) => html`
              <sp-menu-item
                value=${command.id}
                ?disabled=${!registry.isEnabled(command.id)}
                title=${commandTooltip(registry, command.id)}
              >
                ${command.title}
                <span slot="value">${registry.keymap.formatBinding(command.id) ?? ""}</span>
              </sp-menu-item>
            `,
          )}
        </sp-menu>
      </sp-popover>
    </overlay-trigger>
  `;
}

// ─── Window controls ──────────────────────────────────────────────────────────

interface WindowControls {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

function windowControls(): WindowControls | undefined {
  return (globalThis as unknown as { __jxPlatform?: { windowControls?: WindowControls } })
    .__jxPlatform?.windowControls;
}

/** Client-side decorations. Mac puts them leading and close-first; everything else trailing. */
function csdTpl(controls: WindowControls, mac: boolean) {
  const minimize = html`
    <sp-action-button
      quiet
      size="s"
      title="Minimize"
      class="csd-minimize"
      @click=${() => controls.minimize()}
    >
      <sp-icon-remove slot="icon"></sp-icon-remove>
    </sp-action-button>
  `;
  const maximize = html`
    <sp-action-button
      quiet
      size="s"
      title="Maximize"
      class="csd-maximize"
      @click=${() => controls.maximize()}
    >
      <sp-icon-rectangle slot="icon"></sp-icon-rectangle>
    </sp-action-button>
  `;
  const close = html`
    <sp-action-button
      quiet
      size="s"
      title="Close"
      class="csd-close"
      @click=${() => controls.close()}
    >
      <sp-icon-close slot="icon"></sp-icon-close>
    </sp-action-button>
  `;
  return mac
    ? html`<sp-action-group class="window-controls mac" size="s">
        ${close}${minimize}${maximize}
      </sp-action-group>`
    : html`<sp-action-group class="window-controls" size="s">
        ${minimize}${maximize}${close}
      </sp-action-group>`;
}

// ─── The three dock toggles ───────────────────────────────────────────────────

const RAIL_RIGHT_OPEN = html`<sp-icon-rail-right-open slot="icon"></sp-icon-rail-right-open>`;
const RAIL_RIGHT_CLOSE = html`<sp-icon-rail-right-close slot="icon"></sp-icon-rail-right-close>`;
const RAIL_LEFT_OPEN = html`<sp-icon-rail-left-open slot="icon"></sp-icon-rail-left-open>`;
const RAIL_LEFT_CLOSE = html`<sp-icon-rail-left-close slot="icon"></sp-icon-rail-left-close>`;
const CHAT_ICON = html`<sp-icon-chat slot="icon"></sp-icon-chat>`;

/**
 * Whether the assistant is on screen: its dock open, and its tab the one selected.
 *
 * Two reads, because a tab that is selected inside a collapsed dock is not showing. This is the
 * state the third toggle reports and the state `view.setAssistant { open }` names.
 */
function assistantShowing(): boolean {
  return !shell.docks.right.collapsed && inspectorTab() === "assistant";
}

/**
 * ▤▥▦ — the three docks, each rendered from its own record.
 *
 * The glyph flips with the dock's state and `?selected` reports it, so the control says which way
 * it will go; the NAME and the chord still come from the record, which is why ⌘B and this button
 * cannot drift apart the way ⌘W and the tab strip's × did.
 */
function dockTogglesTpl(registry: CommandRegistry) {
  return html`
    ${tbCmd(registry, "view.toggleNavigator", {
      compact: true,
      icon: shell.docks.left.collapsed ? RAIL_LEFT_OPEN : RAIL_LEFT_CLOSE,
      selected: !shell.docks.left.collapsed,
    })}
    ${tbCmd(registry, "view.toggleInspector", {
      compact: true,
      icon: shell.docks.right.collapsed ? RAIL_RIGHT_OPEN : RAIL_RIGHT_CLOSE,
      selected: !shell.docks.right.collapsed,
    })}
    ${tbCmd(registry, "view.toggleBottomDock", {
      compact: true,
      icon: CHAT_ICON,
      selected: assistantShowing(),
    })}
  `;
}

// ─── Mount ────────────────────────────────────────────────────────────────────

/**
 * Mount the Command Bar.
 *
 * @param rootEl The `#toolbar` host, stamped `commandbar` by `stampShellRegions()`.
 * @param _ctx Ignored — see {@link ToolbarCtx}.
 */
export function mount(rootEl: HTMLElement, _ctx: ToolbarCtx = {}) {
  _rootEl = rootEl;
  if (windowControls()) {
    rootEl.classList.add("electrobun-webkit-app-region-drag");
  }
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      // Dock visibility, source control and the project are shell state, tracked here so the band
      // Follows a flip made from anywhere — the automation runner, the New Project agent hand-off,
      // The boot-time restore — not just this module's click handlers.
      void shell.docks.left.collapsed;
      void shell.docks.right.collapsed;
      // The assistant is an Inspector TAB now, so "is the assistant showing" is a tab selection
      // Rather than a dock flag — read through the accessor so the button follows either store.
      void assistantShowing();
      void shell.git.status;
      void shell.layoutSelection;
      // The registry itself is reactive state: it is composed AFTER this mount runs, and reading it
      // Here is what repaints the band from a skeleton into the real bar.
      void activeRegistry();
      const tab = activeTab.value;
      if (tab) {
        void tab.doc.document;
        void tab.doc.dirty;
        void tab.doc.mode;
        void tab.session.selection;
        void tab.session.ui.canvasMode;
        // Open in Browser needs a value for every route param before it can resolve a page.
        void tab.session.ui.previewParams;
        void tab.history.index;
        void tab.history.snapshots.length;
      }
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _rootEl = null;
}

export function render() {
  if (!_rootEl) {
    return;
  }
  try {
    litRender(toolbarTemplate(), _rootEl);
  } catch (error) {
    console.error("toolbar render error:", error);
  }
}

/**
 * The band.
 *
 * ONE template for every state. With no project open the records' `when` clauses empty the primary
 * cluster and the pill reads "No project"; there is no second variant to keep in step.
 */
function toolbarTemplate() {
  const registry = activeRegistry();
  const controls = windowControls();
  const mac = isMacPlatform();
  const csd = controls ? csdTpl(controls, mac) : nothing;
  const tab = activeTab.value ?? null;
  return html`
    ${mac ? csd : nothing} ${registry ? appMenuTpl(registry) : nothing}
    <div class="tb-spacer"></div>
    ${commandCenterTpl(registry)}
    <div class="tb-spacer"></div>
    ${
      registry
        ? html`<sp-action-group compact size="s">
            ${registry
              .forPlacement("commandbar/primary")
              .map((command) => tbCmd(registry, command.id))}
          </sp-action-group>`
        : nothing
    }
    ${tab ? presenceChipsTemplate(tab) : nothing} ${registry ? dockTogglesTpl(registry) : nothing}
    ${mac ? nothing : csd}
  `;
}
