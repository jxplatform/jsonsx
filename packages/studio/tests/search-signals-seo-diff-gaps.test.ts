/**
 * Diff gaps across the jump bar, the State editor's rename field and the Search-appearance command.
 *
 * Three refusals and one no-op that nothing else exercised:
 *
 * - `attachJumpBarHost` handed the host it already has must keep the painted bar rather than tear it
 *   down and build it again — the pane grid re-runs its `ref()` on every cell repaint.
 * - The rename field's "you typed the name it already has" case, which has to CLEAR a standing
 *   refusal instead of reporting the entry as colliding with itself.
 * - `document.openSeo` over no document, which refuses by name rather than opening an empty modal.
 */
import {
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { PRIMARY_PANE, activeTab, closeAllTabs } from "../src/workspace/workspace";
import { attachJumpBarHost, renderJumpBar, unmountJumpBar } from "../src/panels/jump-bar";
import { renderSignalsTemplate } from "../src/panels/signals-panel";
import { seoCommands } from "../src/panels/seo-modal";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { setActiveRegistry } from "../src/commands/active-registry";
import type { JxMutableNode } from "@jxsuite/schema/types";

beforeEach(() => {
  resetStudioState({ name: "My Site", projectRoot: "/p" });
  installMockPlatform();
});

afterEach(() => {
  unmountJumpBar();
  closeAllTabs();
  setActiveRegistry(null);
});

// ─── The jump bar's host handover ─────────────────────────────────────────────

describe("attachJumpBarHost", () => {
  /**
   * A host inside a pane cell, which is where the grid puts it.
   *
   * The offset variable is written on the host's `.pane` ancestor when it has one, so a bar that is
   * taken away has to give its own cell's band back — not the root's, which the other pane is
   * reading.
   */
  function makeHost(id: string): HTMLElement {
    const pane = document.createElement("div");
    pane.className = "pane jb-pane";
    const el = document.createElement("div");
    el.id = id;
    pane.append(el);
    document.body.append(pane);
    return el;
  }

  function bandOf(el: HTMLElement): string {
    return el.closest<HTMLElement>(".pane")!.style.getPropertyValue("--jump-bar-h");
  }

  function crumbsIn(el: HTMLElement): (string | undefined)[] {
    return [...el.querySelectorAll(".jb-crumb")].map((c) => c.textContent?.trim());
  }

  beforeEach(() => {
    resetWorkspaceWithTab({ children: [], tagName: "div" } as unknown as JxMutableNode, {
      documentPath: "/p/index.json",
    });
  });

  afterEach(() => {
    for (const el of document.querySelectorAll(".jb-pane")) {
      el.remove();
    }
  });

  test("handed the host it already has, it keeps the painted bar node for node", async () => {
    const host = makeHost("jb-host-a");
    attachJumpBarHost(PRIMARY_PANE, host);
    await flush(1);
    const painted = host.querySelector(".jump-bar");
    expect(crumbsIn(host)).toEqual(["My Site", "index.json"]);

    attachJumpBarHost(PRIMARY_PANE, host);
    await flush(1);
    // The SAME element, not an equal one: the grid re-runs its `ref()` on every cell repaint, so a
    // Re-attach that blanked the host and painted it again would throw the bar's DOM away on every
    // Unrelated repaint of the pane.
    expect(host.querySelector(".jump-bar")).toBe(painted);
    expect(crumbsIn(host)).toEqual(["My Site", "index.json"]);
    expect(bandOf(host)).toBe("24px");
  });

  test("handed a DIFFERENT host, it blanks the old one and paints the new", async () => {
    const first = makeHost("jb-host-a");
    const second = makeHost("jb-host-b");
    attachJumpBarHost(PRIMARY_PANE, first);
    await flush(1);
    expect(crumbsIn(first)).toEqual(["My Site", "index.json"]);

    attachJumpBarHost(PRIMARY_PANE, second);
    await flush(1);
    // The cell being disposed still holds this bar's DOM, and the lit part that owns it is about to
    // Be unreachable — so the handover blanks it and gives its band back.
    expect(first.querySelector(".jump-bar")).toBeNull();
    expect(bandOf(first)).toBe("0px");
    expect(crumbsIn(second)).toEqual(["My Site", "index.json"]);
    expect(bandOf(second)).toBe("24px");
  });

  test("handed null, it detaches the pane and never paints it again", async () => {
    const host = makeHost("jb-host-a");
    attachJumpBarHost(PRIMARY_PANE, host);
    await flush(1);
    expect(crumbsIn(host)).toEqual(["My Site", "index.json"]);

    attachJumpBarHost(PRIMARY_PANE, null);
    expect(host.querySelector(".jump-bar")).toBeNull();
    expect(bandOf(host)).toBe("0px");
    // Detached means forgotten: a later repaint has no host to find.
    renderJumpBar();
    expect(host.querySelector(".jump-bar")).toBeNull();
  });
});

// ─── The State editor's rename field ─────────────────────────────────────────

describe("the rename field's own name", () => {
  interface Mounted {
    container: HTMLElement;
    repaint: () => void;
  }

  /** Mount the signals template over the active tab, repainting into the same container. */
  function mountSignals(): Mounted {
    const container = document.createElement("div");
    const tab = activeTab.value;
    if (!tab) {
      throw new Error("no active tab");
    }
    const S: Record<string, unknown> = { document: tab.doc.document };
    const ctx = {
      renderLeftPanel: () => {
        S.document = activeTab.value?.doc.document;
        render(renderSignalsTemplate(S as never, ctx), container);
      },
    };
    ctx.renderLeftPanel();
    return { container, repaint: ctx.renderLeftPanel };
  }

  function findRow(container: HTMLElement, name: string): HTMLElement {
    const row = [...container.querySelectorAll(".signal-row")].find(
      (r) => r.querySelector(".signal-name")?.textContent === name,
    );
    if (!row) {
      throw new Error(`no row for ${name}`);
    }
    return row as HTMLElement;
  }

  /** Expand a signal row (idempotent) and return THIS row's editor. */
  async function expand(h: Mounted, name: string): Promise<HTMLElement> {
    let row = findRow(h.container, name);
    if (!row.classList.contains("expanded")) {
      pointer(row, "click");
      await flush(1);
      row = findRow(h.container, name);
    }
    const editor = row.nextElementSibling;
    if (!editor?.classList.contains("signal-editor")) {
      throw new Error(`no editor rendered for ${name}`);
    }
    return editor as HTMLElement;
  }

  function commitName(editor: HTMLElement, value: string): void {
    const field = editor.querySelector('[data-prop="Name"] sp-textfield');
    if (!field) {
      throw new Error("no Name field");
    }
    (field as HTMLElement & { value: string }).value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function alertText(editor: HTMLElement): string | undefined {
    return editor.querySelector('[data-prop="Name"] [role="alert"]')?.textContent?.trim();
  }

  test("re-committing the same name (padded) is accepted, and clears a standing refusal", async () => {
    // The whitespace is what makes this a COMMIT at all — the field only fires when the string
    // Differs from the one it was rendered with. What the author typed still names this entry, so
    // The panel must neither rename anything nor report the entry as colliding with itself.
    const h = mountSignals();
    let editor = await expand(h, "$a");
    commitName(editor, "$b");
    editor = await expand(h, "$a");
    expect(alertText(editor)).toBe('"$b" is already defined by this document.');

    commitName(editor, "  $a  ");
    // The accepted case commits nothing and repaints nothing, so the refusal is cleared in state
    // And the panel shows it on its next paint.
    h.repaint();
    await flush(1);
    editor = await expand(h, "$a");
    expect(alertText(editor)).toBeUndefined();
    expect(editor.querySelector('[data-prop="Name"] [role="alert"]')).toBeNull();
  });

  test("it leaves the document exactly as it found it — no second entry, no reorder", async () => {
    const h = mountSignals();
    let editor = await expand(h, "$a");
    commitName(editor, " $a ");
    await flush(1);
    const state = (activeTab.value?.doc.document.state ?? {}) as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(["$a", "$b"]);
    expect(state.$a).toEqual({ default: 1 } as never);
    // And it is not refused either: an entry cannot collide with itself, which is what a fall
    // Through into the collision check would report.
    h.repaint();
    await flush(1);
    editor = await expand(h, "$a");
    expect(alertText(editor)).toBeUndefined();
  });

  beforeEach(() => {
    resetWorkspaceWithTab({
      children: [],
      state: { $a: { default: 1 }, $b: { default: 2 } },
      tagName: "div",
    } as unknown as JxMutableNode);
  });
});

// ─── document.openSeo over nothing ───────────────────────────────────────────

describe("document.openSeo with no document", () => {
  test("it refuses by name rather than opening a modal about nothing", () => {
    // The gate says a document is open; the run body does not take its word for it. Without the
    // Guard the modal opens over `null`, paints nothing into it, and reports success.
    const registry = createCommandRegistry({
      getContext: () => makeContext({ document: { open: true } }),
    });
    registry.register(seoCommands()[0]!);
    closeAllTabs();
    expect(() => registry.run("document.openSeo")).toThrow(
      'command "document.openSeo" needs an open document',
    );
    expect(document.querySelector(".seo-modal")).toBeNull();
  });
});
