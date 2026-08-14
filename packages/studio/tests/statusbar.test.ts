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
  forgetSavedTimes,
  mountStatusbar,
  noteDocumentSaved,
  renderStatusbar,
  unmountStatusbar,
  viewLabel,
} from "../src/panels/statusbar";
import { resetProjectShell, shell } from "../src/shell";
import { readFileSync } from "node:fs";
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
    stub("git.init", "Initialize Repository", "project"),
    // `view.setBottomTab`, not `panel.focus.problems` — that record is generated from the rail
    // Roster and Problems is off the rail.
    stub("view.setBottomTab", "Show Bottom Dock Tab", "application"),
    stub("palette.openFiles", "Go to File…", "application"),
    stub("file.save", "Save", "document"),
    stub("selection.set", "Select Element", "document"),
    stub("collab.showStatus", "Collaborate: What is happening in this document?", "document"),
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
    // One label map in commands/context.ts: the status bar and the pane context bar cannot print
    // Different words for the same editor kind. The wire value is still `stylebook`.
    expect(viewLabel("config", "design")).toBe("Project Styles");
  });

  test("no editor means no label", () => {
    expect(viewLabel("none", "design")).toBe("");
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

  /*
   * Plan §12 P1 workstream 9: "repo state becomes a persistent status-bar field".
   *
   * It reads like a request for a "not tracked" twin of the branch item, and it is not: the field
   * already states an untracked project, one item along, because `deployStatusItem()`'s first link
   * is `repo` — label "Track this project with git", command `git.init`. Two items saying that with
   * the same verb is the adjacent-duplicate chrome §2 principle 9 forbids.
   *
   * So the invariant worth pinning is the PAIRING, and it is asserted from both ends: exactly one
   * item names `git.init`, and it is there at all. Deleting the checklist's repo step takes the
   * state off the bar and fails here; adding a second one fails here too.
   */
  test("an untracked project is stated ONCE, by the item whose command initializes the repo", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    shell.git.status = { ahead: 0, behind: 0, files: [], isRepo: false, remotes: [] } as never;
    renderStatusbar();
    // No branch to name, so the branch item is absent — and the state is said anyway.
    expect(items().some((t) => t?.startsWith("⑂"))).toBe(false);
    expect(items()).toContain("Track this project with git");

    const buttons = [...field("project")!.querySelectorAll("button")];
    for (const button of buttons) {
      button.click();
    }
    expect(ran.filter((r) => r.id === "git.init")).toHaveLength(1);
  });

  test("once tracked, the field stops offering to track it and names the branch instead", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    shell.git.status = {
      ahead: 0,
      behind: 0,
      branch: "main",
      files: [],
      isRepo: true,
      remotes: [],
    } as never;
    renderStatusbar();
    expect(items()).toContain("⑂ main");
    expect(items()).not.toContain("Track this project with git");
  });

  test("the problems item counts `notify`'s Problems store, and appears only when non-zero", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    renderStatusbar();
    expect(items().some((t) => t?.startsWith("⚠"))).toBe(false);
    notify.error("Could not save.");
    notify.warn("Slots", { tier: "problem" });
    renderStatusbar();
    expect(items()).toContain("⚠ 2");
    // By LABEL, not by index: the field's item count moves with the deploy checklist and the peer
    // Count, and a positional lookup here would silently start clicking whichever item grew in
    // Front of it (it did — the deploy item's `git.init` link took slot 1).
    const problems = [...field("project")!.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "⚠ 2",
    )!;
    problems.click();
    // The one door the other three Bottom-dock tabs use, carrying which tab it means.
    expect(ran.at(-1)!.id).toBe("view.setBottomTab");
    expect(ran.at(-1)!.args).toEqual({ tab: "problems" });
  });

  test("the peers item counts them, and opens what is happening in this document", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    const tab = resetWorkspaceWithTab();
    collabState(tab).peers = [{ color: "#f00", name: "Ada" }] as never;
    renderStatusbar();
    expect(items()).toContain("1 peer");
    const buttons = [...field("project")!.querySelectorAll("button")];
    (buttons.at(-1) as HTMLElement).click();
    expect(ran.at(-1)!.id).toBe("collab.showStatus");
  });

  test("it stays silent with nobody there", () => {
    resetStudioState({ name: "My Site", projectRoot: "/p" });
    resetWorkspaceWithTab();
    renderStatusbar();
    expect(items().some((t) => t?.includes("peer"))).toBe(false);
  });

  /*
   * The gate that was missing, and the reason this readout was blank for two phases.
   *
   * The item named `collab.share`. The `Collaborate:` family then shipped under five ids, with
   * `share` renamed `collab.setEnabled` on the way, and `itemTpl` renders `nothing` for an id the
   * registry does not have — so the peer count silently stopped existing, while a comment in the
   * file promised it would appear "with no edit to this file". Every test above builds a STUB
   * registry, so none of them could see it: they prove the bar renders what it is given, not that
   * what it names exists.
   */
  test("every command the bar names is one the real app declares", async () => {
    const { appCommandSet } = await import("../src/commands/app-commands");
    const declared = new Set(appCommandSet().map((c) => c.id));
    const source = readFileSync(new URL("../src/panels/statusbar.ts", import.meta.url), "utf8");
    const named = [...source.matchAll(/command:\s*"([\w.]+)"/g)].map((m) => m[1] as string);
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((id) => !declared.has(id))).toEqual([]);
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

  test("holds NO ancestor trail — the address is the jump bar's, and one copy is the point", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ children: [{ tagName: "li", textContent: "Item" }], tagName: "ul" }],
      tagName: "div",
    });
    ctx = makeContext({ document: { open: true } });
    tab.session.selection = [["children", 0, "children", 0]];
    renderStatusbar();
    // A single selection leaves the field empty: the jump bar's leaf segment states it, with its
    // Ancestors, and the bar that carries ambient state has nothing left to add.
    expect(field("selection")).toBeNull();
    expect(statusbarEl.querySelectorAll(".sb-sep")).toHaveLength(0);
    expect(items()).not.toContain("ul");
    expect(items()).not.toContain("li");
  });

  test("a batch says its SIZE, which is the one selection fact an address cannot state", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p" }, { tagName: "p" }, { tagName: "p" }],
      tagName: "div",
    });
    tab.session.selection = [
      ["children", 0],
      ["children", 2],
    ];
    renderStatusbar();
    expect(field("selection")?.textContent?.trim()).toBe("2 selected");
    // A count is a readout, not a control: there is no command that "selects two things".
    expect(field("selection")?.querySelectorAll("button")).toHaveLength(0);
  });

  test("the stylebook selector is the field's content when no node is picked", () => {
    resetWorkspaceWithTab();
    shell.stylebook.selection = "ul li";
    renderStatusbar();
    expect(field("selection")?.textContent?.trim()).toBe("ul › li");
  });

  test("a node selection wins over the stylebook selector, even printing nothing", () => {
    const tab = resetWorkspaceWithTab({ children: [{ tagName: "p" }], tagName: "div" });
    shell.stylebook.selection = "h1";
    tab.session.selection = [["children", 0]];
    renderStatusbar();
    // Two answers to "what is selected" is the defect; the document's answer wins, and when it has
    // Nothing ambient to add the field is absent rather than falling through to the other one.
    expect(field("selection")).toBeNull();
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
    tab.session.selection = [
      ["children", 0],
      ["children", 1],
    ];
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

  test("a multi-selection says its SIZE — the one selection fact this bar still owns (§6.5)", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    await flush();
    tab.session.selection = [["children", 0]];
    await flush();
    expect(items()).not.toContain("2 selected");
    tab.session.selection = [
      ["children", 0],
      ["children", 1],
    ];
    await flush();
    expect(items()).toContain("2 selected");
  });

  test("is idempotent — a second mount replaces the effect rather than stacking one", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    mountStatusbar();
    await flush();
    tab.session.selection = [
      ["children", 0],
      ["children", 1],
    ];
    await flush();
    expect(statusbarEl.querySelectorAll('[data-jx-region="statusbar/selection"]')).toHaveLength(1);
  });

  test("unmount stops the repaint", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    await flush();
    expect(field("selection")).toBeNull();
    unmountStatusbar();
    // A BATCH, not a single node: a single selection leaves this field empty either way, so it
    // Could not tell a stopped effect from a live one.
    tab.session.selection = [
      ["children", 0],
      ["children", 1],
    ];
    await flush();
    expect(field("selection")).toBeNull();
  });
});
