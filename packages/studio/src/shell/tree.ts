/**
 * The shell's mount tree — the one definition of what the application frame IS.
 *
 * It was `index.html`'s body, and, in drifted copies, the body of twenty-three test files. The copy
 * in `tests/studio-shell-fixture.ts` had lost `#resize-bottom`, `#bottom-dock` and `#layer-toast`,
 * so every shell-boot test ran against a shell with no bottom dock and no toast host — a difference
 * no test could report, because the fixture WAS the thing under test.
 *
 * Nothing here is dynamic: `mountShellTree()` renders once at boot, before `initShellRefs()` adopts
 * the hosts, and each region then renders into its own host through its own effect (see
 * studio-ui-guidelines.md §9.3). It is a lit template rather than a string because that makes the
 * region attributes bindings the tree owns, and because the twenty-three test files can now ask for
 * the real shell instead of describing one.
 */

import { html, render as litRender } from "lit-html";
import type { TemplateResult } from "lit-html";

/**
 * Render a frame template into `host`, surviving a host that was emptied since the last mount.
 *
 * `textContent = ""` (or `innerHTML = ""`) removes the comment nodes lit uses as a ChildPart's
 * markers but leaves lit's private `_$litPart$` reference behind, so the next render reuses a part
 * whose markers are detached from the DOM and throws — or, worse, quietly renders nothing. Test
 * fixtures clear the body between cases constantly, and the app does the same thing to a stage on
 * every mode transition; `canvas/canvas-render.ts`'s hardClearCanvasWrap carries the same ejection
 * for the same reason.
 *
 * Mounting is a one-shot, so ejecting unconditionally costs nothing and makes it idempotent.
 */
function mountInto(host: ParentNode, tpl: TemplateResult): void {
  /* Both halves, in this order. Clearing alone leaves lit's private part reference pointing at
     comment markers that are no longer in the document, so the next render throws or paints
     nothing. Ejecting alone leaves the OLD nodes in place and lit starts a fresh part beside them,
     so a second mount produces two frames rather than one. */
  (host as HTMLElement).textContent = "";
  // @ts-expect-error -- _$litPart$ is lit's private render-part marker, not in the DOM types
  delete (host as HTMLElement)["_$litPart$"];
  litRender(tpl, host as HTMLElement);
}

/**
 * The four overlay layers that `ui/layers.ts` renders into, in stacking order.
 *
 * Exported apart from {@link shellTree} because it is the piece a unit test usually wants alone
 * (through `mountOverlayLayers` in the test harness) — twenty fixtures were describing this set by
 * hand, and they had already stopped agreeing: most carried three layers and one carried four, so
 * whether a toast host existed at all depended on which test file you happened to be in.
 */
export function overlayLayers(): TemplateResult {
  return html`
    <!-- The four overlay layers, in stacking order. Their z-indices were inline style
       attributes, which put the one piece of ordering the whole overlay system depends on
       outside the reach of check-styles.ts's stacking rule — the check that exists because a
       blocking progress modal once shipped above its own scrim with no reachable exit. They are
       classes in styles/overlays.css now, and the toast host is ABOVE the dialog host because
       an operation started from a dialog reports its outcome to the person still looking at
       it. -->
    <div id="layer-popover" class="jx-layer jx-layer--popover"></div>
    <div id="layer-modal" class="jx-layer jx-layer--modal"></div>
    <div id="layer-dialog" class="jx-layer jx-layer--dialog"></div>
    <!-- role="status" sits on the HOST, so a stack of toasts is announced as one live region
       rather than one region per notification. It carries its region id whether or not a toast
       has ever been raised: a region that only exists once something has gone wrong is one a
       screenshot cannot address and focus cannot be moved into. -->
    <div
      id="layer-toast"
      class="jx-layer jx-layer--toast"
      role="status"
      aria-live="polite"
      data-jx-region="overlay.toasts"
    ></div>
  `;
}

/**
 * The application frame: the Spectrum theme wrapper, the app grid, and the four overlay layers.
 *
 * The theme's three attributes are BINDINGS rather than literals, and that is not decoration. A
 * literal lives in the template lit clones with `importNode`, and cloning a registered custom
 * element makes the DOM fire `attributeChangedCallback` before its constructor has run — Spectrum's
 * Theme then reaches for `_provideSystemContext` and finds nothing. A binding is applied after the
 * element exists. `shell.ts` overwrites `color` on the first theme effect anyway, so the literal
 * was never the source of truth.
 *
 * Region ids are stamped HERE. They used to live in a selector-to-id map in `ui/regions.ts`, whose
 * comment gave the reason plainly — these were "bare `<div id>` in index.html, so it cannot stamp
 * itself". A template can, so the map is gone and the id sits on the element it names.
 */
export function shellTree(): TemplateResult {
  return html`
    <div id="app">
      <div id="toolbar" data-jx-region="commandbar"></div>
      <!-- The PANE GRID (studio.md §18.1). One cell per pane, each holding that pane's own strip,
             jump bar, chrome layer and stage — the four surfaces that used to be flat siblings of
             THIS grid, which is to say application rows that only ever described one pane. There is
             nothing to see here in markup: panels/pane-grid.ts reconciles the cells against
             workspace.panes, because how many there are is a fact about the workspace and a
             single div can only ever be one of them. -->
      <div id="pane-grid"></div>
      <div id="activity-bar" data-jx-region="rail"></div>
      <div id="left-panel" data-jx-region="navigator"></div>
      <div id="resize-left" class="resize-handle"></div>
      <!-- The Bottom dock (⌘J). It sits in the PANE's column, under the stage and above the
             status bar, so opening it never narrows the Navigator or the Inspector (studio.md §12
             region ⑪). Its handle resizes on the other axis; panels/bottom-dock.ts stamps
             dock.bottom on this host while it is open, and nothing while it is closed. -->
      <div id="resize-bottom" class="resize-handle resize-handle-row"></div>
      <div id="bottom-dock"></div>
      <div id="resize-right" class="resize-handle"></div>
      <!-- The Inspector dock. Four tabs — Content · Style · Logic · Assistant (studio.md §12
             region ⑨) — all inside this one host. -->
      <div id="right-panel" data-jx-region="inspector"></div>
      <!-- The app's only status channel: announce what lands in it (studio.md §12 region ⑫). -->
      <div id="statusbar" role="status" aria-live="polite" data-jx-region="statusbar"></div>
    </div>
    ${overlayLayers()}
  `;
}

/**
 * Render {@link shellTree} into `host`.
 *
 * The entry calls this once, before `initShellRefs()`. Tests call it instead of pasting an
 * approximation of the frame — which is the whole reason it is a function.
 *
 * @param host Where the frame goes. Defaults to the document body.
 */
export function mountShellTree(host: ParentNode = document.body): void {
  mountInto(themeHost(host), shellTree());
}

/**
 * The Spectrum theme wrapper, created once and reused.
 *
 * It is NOT part of {@link shellTree}, and the reason is a real constraint rather than taste. lit
 * instantiates a template by cloning it with `importNode`, and cloning a registered custom element
 * enqueues its `attributeChangedCallback` before the constructor body has run — Spectrum's Theme
 * then reaches for a field it assigns in that body and throws. `createElement` runs the constructor
 * first, so the attributes are safe to set afterwards.
 *
 * `shell.ts` rewrites `color` on the first theme effect, so the value here is only the first frame.
 */
function themeHost(host: ParentNode): HTMLElement {
  const existing = host.querySelector?.("sp-theme");
  if (existing) {
    return existing as HTMLElement;
  }
  const theme = document.createElement("sp-theme");
  theme.setAttribute("color", "dark");
  theme.setAttribute("scale", "medium");
  theme.setAttribute("system", "spectrum");
  (host as HTMLElement).append(theme);
  return theme;
}
