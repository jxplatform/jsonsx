/**
 * ⑫ The status bar — three fields, in scope order, every interactive item a command.
 *
 * The bar's contract is what it CANNOT do as much as what it can: it holds no transient message, it
 * has no click handler of its own, and it renders no item whose command the registry does not
 * have.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { nothing, render as litRender } from "lit-html";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { initShellRefs, setProjectState, statusbarEl } from "../src/store";
import { closeAllTabs } from "../src/workspace/workspace";
import {
  aheadBehindLabel,
  documentLabel,
  forgetSavedTimes,
  mountStatusbar,
  noteDocumentSaved,
  renderStatusbar,
  selectionCrumbs,
  unmountStatusbar,
  viewLabel,
} from "../src/panels/statusbar";
import { resetProjectShell, shell } from "../src/shell";
import { setActiveRegistry } from "../src/commands/active-registry";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { notify, resetNotifications } from "../src/services/notify";
import { pinClock, unpinClock } from "../src/services/clock";
import { collabState } from "../src/collab/collab-state";
import type { CommandContext } from "../src/commands/context";
import type { AnyCommand } from "../src/commands/registry";

beforeAll(() => {
  const bar = document.createElement("div");
  bar.id = "statusbar";
  document.body.append(bar);
  initShellRefs();
});

let ctx: CommandContext = makeContext();
const ran: { id: string; args: unknown }[] = [];

/** One command record, as bare as the registry allows: the bar must not care what it does. */
function stub(id: string, title: string, level: AnyCommand["level"]): AnyCommand {
  return {
    category: "View",
    id,
    level,
    run: (_c, args) => {
      ran.push({ args, id });
    },
    title,
  } as AnyCommand;
}

function buildRegistry(ids?: readonly string[]) {
  const registry = createCommandRegistry({ getContext: () => ctx });
  const all: AnyCommand[] = [
    stub("project.open", "Open Project…", "project"),
    stub("project.openRecent", "Open Recent…", "project"),
    stub("panel.focus.git", "Show Source Control", "application"),
    stub("panel.focus.problems", "Show Problems", "application"),
    stub("palette.openFiles", "Go to File…", "application"),
    stub("file.save", "Save", "document"),
    stub("selection.set", "Select Element", "document"),
  ];
  registry.registerAll(ids ? all.filter((c) => ids.includes(c.id)) : all);
  return registry;
}

beforeEach(() => {
  closeAllTabs();
  // `projectState` is a module-level binding, not a per-test one: the bar's "No project" state has
  // To be stated rather than inherited from whichever test ran last.
  setProjectState(null as never);
  resetProjectShell();
  resetNotifications();
  forgetSavedTimes();
  ran.length = 0;
  ctx = makeContext();
  // Cleared THROUGH lit: assigning innerHTML behind its back strands the part markers and the
  // Next render walks a detached tree.
  litRender(nothing, statusbarEl);
  setActiveRegistry(buildRegistry());
});

afterEach(() => {
  unmountStatusbar();
  setActiveRegistry(null);
  resetNotifications();
  unpinClock();
});

const items = () => [...statusbarEl.querySelectorAll(".sb-item")].map((e) => e.textContent?.trim());
const field = (name: string) => statusbarEl.querySelector(`[data-jx-region="statusbar/${name}"]`);

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe("aheadBehindLabel", () => {
  test("says nothing when the branch is level with its upstream", () => {
    expect(aheadBehindLabel(0, 0)).toBe("");
  });

  test("names each direction only when it is non-zero", () => {
    expect(aheadBehindLabel(2, 0)).toBe(" ↑2");
    expect(aheadBehindLabel(0, 3)).toBe(" ↓3");
    expect(aheadBehindLabel(2, 3)).toBe(" ↑2 ↓3");
  });
});

describe("viewLabel", () => {
  test("a canvas pane reports its EFFECTIVE view, not its mode string", () => {
    expect(viewLabel("canvas", "edit")).toBe("Edit");
    expect(viewLabel("canvas", "design")).toBe("Design");
    expect(viewLabel("canvas", "preview")).toBe("Preview");
  });

  test("every other editor kind is named by its kind", () => {
    expect(viewLabel("code", "design")).toBe("Code");
    expect(viewLabel("grid", "design")).toBe("Grid");
    expect(viewLabel("diff", "design")).toBe("Diff");
    expect(viewLabel("library", "design")).toBe("Library");
    expect(viewLabel("config", "design")).toBe("Stylebook");
  });

  test("no editor means no label", () => {
    expect(viewLabel("none", "design")).toBe("");
  });
});

describe("documentLabel", () => {
  test("strips the project root, which is already field one", () => {
    resetStudioState({ name: "Site", projectRoot: "/home/k/site" });
    expect(documentLabel("/home/k/site/pages/index.json")).toBe("pages/index.json");
  });

  test("leaves a path outside the root alone, and names an unsaved document", () => {
    resetStudioState({ name: "Site", projectRoot: "/home/k/site" });
    expect(documentLabel("/elsewhere/x.json")).toBe("/elsewhere/x.json");
    expect(documentLabel(null)).toBe("Untitled");
  });
});

describe("selectionCrumbs", () => {
  test("one crumb per NODE, with the path that selects it", () => {
    const doc = {
      children: [{ children: [{ tagName: "li" }], tagName: "ul" }],
      tagName: "div",
    };
    expect(selectionCrumbs(doc, ["children", 0, "children", 0])).toEqual([
      { label: "ul", path: ["children", 0] },
      { label: "li", path: ["children", 0, "children", 0] },
    ]);
  });

  test("a repeater's lone `map` segment does not break the pairing", () => {
    const doc = {
      children: [{ $prototype: "Array", map: { tagName: "article" } }],
      tagName: "div",
    };
    expect(selectionCrumbs(doc, ["children", 0, "map"]).map((c) => c.label)).toEqual([
      "Repeater",
      "article",
    ]);
  });

  test("falls back to `tag`, then to a bracketed index", () => {
    const doc = { children: [{ tag: "h2" }, {}], tagName: "div" };
    expect(selectionCrumbs(doc, ["children", 0])[0]!.label).toBe("h2");
    expect(selectionCrumbs(doc, ["children", 1])[0]!.label).toBe("[1]");
  });

  test("a `cases` step is named by its case key", () => {
    const doc = { cases: { warm: {} }, tagName: "div" };
    expect(selectionCrumbs(doc, ["cases", "warm"])[0]!.label).toBe("warm");
  });
});

// ─── ⑫a PROJECT ──────────────────────────────────────────────────────────────

describe("the PROJECT field", () => {
  test("with no project it offers the one command that fixes that", () => {
    renderStatusbar();
    expect(field("project")?.textContent?.trim()).toBe("No project");
  });

  test("names the project, and the name is Open Recent…", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    renderStatusbar();
    const button = field("project")?.querySelector("button") as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("My Site");
    expect(button.title).toContain("Open Recent…");
    button.click();
    expect(ran).toEqual([{ args: {}, id: "project.openRecent" }]);
  });

  test("the branch item appears only for a repo, and carries ahead/behind", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    renderStatusbar();
    expect(items()).not.toContain("⑂ main");
    shell.git.status = { ahead: 1, behind: 2, branch: "main", files: [], isRepo: true } as never;
    renderStatusbar();
    expect(items()).toContain("⑂ main ↑1 ↓2");
  });

  test("the problems item counts `notify`'s Problems store, and appears only when non-zero", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    renderStatusbar();
    expect(items().some((t) => t?.startsWith("⚠"))).toBe(false);
    notify.error("Could not save.");
    notify.warn("Slots", { tier: "problem" });
    renderStatusbar();
    expect(items()).toContain("⚠ 2");
    (field("project")!.querySelectorAll("button")[1] as HTMLElement).click();
    expect(ran.at(-1)!.id).toBe("panel.focus.problems");
  });

  test("the peers item is silent until a `Collaborate:` command exists to name", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    const tab = resetWorkspaceWithTab();
    collabState(tab).peers = [{ color: "#f00", name: "Ada" }] as never;
    renderStatusbar();
    // The registry has no `collab.share`, so the item renders nothing rather than a dead label.
    expect(items().some((t) => t?.includes("peer"))).toBe(false);
  });
});

// ─── ⑫b DOCUMENT ─────────────────────────────────────────────────────────────

describe("the DOCUMENT field", () => {
  test("does not exist with no document open", () => {
    renderStatusbar();
    expect(field("document")).toBeNull();
  });

  test("names the path, and the path is Go to File…", () => {
    resetStudioState({ name: "Site", projectRoot: "/p" });
    resetWorkspaceWithTab(undefined, { documentPath: "/p/pages/index.json" });
    renderStatusbar();
    const button = field("document")?.querySelector("button") as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("pages/index.json");
    button.click();
    expect(ran.at(-1)!.id).toBe("palette.openFiles");
  });

  test("reports the EFFECTIVE view, so it cannot disagree with the Command Bar again", () => {
    resetWorkspaceWithTab();
    ctx = makeContext({ canvas: { view: "preview" }, editor: { kind: "canvas" } });
    renderStatusbar();
    expect(items()).toContain("Preview");
    // The old bar printed "Content Mode" off `tab.doc.mode` while the toolbar printed "Design".
    expect(items()).not.toContain("Content Mode");
  });

  test("the save state is worded, and while dirty it IS the save command", () => {
    const tab = resetWorkspaceWithTab();
    tab.doc.dirty = true;
    renderStatusbar();
    expect(items()).toContain("Unsaved changes");
    const save = [...statusbarEl.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Unsaved changes",
    )!;
    save.click();
    expect(ran.at(-1)!.id).toBe("file.save");
  });

  test("a clean document with no recorded write says only Saved", () => {
    resetWorkspaceWithTab();
    renderStatusbar();
    expect(items()).toContain("Saved");
  });

  test("a recorded write is worded relative to the clock seam", () => {
    resetStudioState({ name: "Site", projectRoot: "/p" });
    resetWorkspaceWithTab(undefined, { documentPath: "/p/index.json" });
    pinClock(1_000_000);
    noteDocumentSaved("/p/index.json");
    pinClock(1_000_000 + 120_000);
    renderStatusbar();
    expect(items()).toContain("Saved 2m ago");
  });

  test("noteDocumentSaved ignores an absent path, and forgetSavedTimes clears the record", () => {
    resetStudioState({ name: "Site", projectRoot: "/p" });
    resetWorkspaceWithTab(undefined, { documentPath: "/p/index.json" });
    noteDocumentSaved(null);
    pinClock(2_000_000);
    noteDocumentSaved("/p/index.json");
    forgetSavedTimes();
    renderStatusbar();
    expect(items()).toContain("Saved");
  });

  test("a read-only collab guest is told so, in words", () => {
    const tab = resetWorkspaceWithTab();
    tab.doc.dirty = true;
    collabState(tab).readOnly = true;
    renderStatusbar();
    expect(items()).toContain("Read-only");
    expect(items()).not.toContain("Unsaved changes");
  });
});

// ─── ⑫c SELECTION ────────────────────────────────────────────────────────────

describe("the SELECTION field", () => {
  test("is absent with nothing selected", () => {
    resetWorkspaceWithTab();
    renderStatusbar();
    expect(field("selection")).toBeNull();
  });

  test("renders the node label and one command per ancestor crumb", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ children: [{ tagName: "li", textContent: "Item" }], tagName: "ul" }],
      tagName: "div",
    });
    tab.session.selection = ["children", 0, "children", 0];
    renderStatusbar();
    const selection = field("selection")!;
    expect(selection.querySelector(".sb-state")?.textContent).toContain("li");
    expect([...selection.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual([
      "ul",
      "li",
    ]);
    expect(selection.querySelectorAll(".sb-sep")).toHaveLength(1);
  });

  test("a crumb click is `selection.set` with the crumb's path — no bespoke handler", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ children: [{ tagName: "li" }], tagName: "ul" }],
      tagName: "div",
    });
    ctx = makeContext({ document: { open: true } });
    tab.session.selection = ["children", 0, "children", 0];
    renderStatusbar();
    (field("selection")!.querySelector("button") as HTMLElement).click();
    expect(ran).toEqual([{ args: { path: ["children", 0] }, id: "selection.set" }]);
  });

  test("escaping is lit's job now, not a three-character escaper's", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "<b>&hi" }],
      tagName: "div",
    });
    tab.session.selection = ["children", 0];
    renderStatusbar();
    expect(statusbarEl.querySelector("b")).toBeNull();
    expect(field("selection")?.textContent).toContain("<b>&hi");
  });

  test("the stylebook selector is the field's content when no node is picked", () => {
    resetWorkspaceWithTab();
    shell.stylebook.selection = "ul li";
    renderStatusbar();
    expect(field("selection")?.textContent?.trim()).toBe("ul › li");
  });

  test("a node selection wins over the stylebook selector", () => {
    const tab = resetWorkspaceWithTab({ children: [{ tagName: "p" }], tagName: "div" });
    shell.stylebook.selection = "h1";
    tab.session.selection = ["children", 0];
    renderStatusbar();
    expect(field("selection")?.textContent).not.toContain("h1");
  });
});

// ─── The registry is the source of truth ─────────────────────────────────────

describe("items are a rendering of the registry", () => {
  test("no registry at all paints an empty bar rather than crashing", () => {
    setActiveRegistry(null);
    resetStudioState({ name: "Site", projectRoot: "/p" });
    resetWorkspaceWithTab();
    renderStatusbar();
    expect(statusbarEl.querySelectorAll("button")).toHaveLength(0);
  });

  test("an item whose command is unregistered disappears; the field survives", () => {
    setActiveRegistry(buildRegistry(["project.openRecent"]));
    resetStudioState({ name: "Site", projectRoot: "/p" });
    shell.git.status = { ahead: 0, behind: 0, branch: "main", files: [], isRepo: true } as never;
    renderStatusbar();
    expect(items()).toEqual(["Site"]);
  });

  test("a hidden command hides its item", () => {
    const registry = createCommandRegistry({ getContext: () => ctx });
    registry.register({
      ...stub("project.openRecent", "Open Recent…", "project"),
      when: () => false,
    });
    setActiveRegistry(registry);
    resetStudioState({ name: "Site", projectRoot: "/p" });
    renderStatusbar();
    expect(field("project")).toBeNull();
  });

  test("a disabled command renders disabled, with its own requires sentence", () => {
    const registry = createCommandRegistry({ getContext: () => ctx });
    registry.register({
      ...stub("file.save", "Save", "document"),
      enablement: () => false,
      requires: "a writable target",
    });
    setActiveRegistry(registry);
    const tab = resetWorkspaceWithTab();
    tab.doc.dirty = true;
    renderStatusbar();
    const save = statusbarEl.querySelector("button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toContain("a writable target");
  });
});

// ─── Mounting ────────────────────────────────────────────────────────────────

describe("mountStatusbar", () => {
  test("repaints when the state it renders changes", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    await flush();
    expect(field("selection")).toBeNull();
    tab.session.selection = ["children", 0];
    await flush();
    expect(field("selection")).not.toBeNull();
  });

  test("repaints when a problem arrives", async () => {
    resetStudioState({ name: "Site", projectRoot: "/p" });
    mountStatusbar();
    await flush();
    expect(items()).not.toContain("⚠ 1");
    notify.error("Broken");
    await flush();
    expect(items()).toContain("⚠ 1");
  });

  test("is idempotent — a second mount replaces the effect rather than stacking one", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    mountStatusbar();
    await flush();
    tab.session.selection = ["children", 0];
    await flush();
    expect(statusbarEl.querySelectorAll('[data-jx-region="statusbar/selection"]')).toHaveLength(1);
  });

  test("unmount stops the repaint", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    await flush();
    expect(field("selection")).toBeNull();
    unmountStatusbar();
    tab.session.selection = ["children", 0];
    await flush();
    expect(field("selection")).toBeNull();
  });
});
