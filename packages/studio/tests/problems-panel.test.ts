/**
 * Problems (`panels/problems-panel.ts`) — the surface that keeps `notify`'s promise.
 *
 * Three things are worth pinning: that the list is a RENDERING of `services/notify.ts`'s store
 * (nobody pushes rows at it), that the recovery button is a projection of a command record — its
 * label, its disabled state and its refusal sentence all come off the registry — and that there is
 * exactly ONE record, hosted in the Bottom dock (§7.2), whose badge the rail borrows.
 */
import { flush, installMockPlatform, renderInto } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  groupProblems,
  registerProblemsPanel,
  renderProblemsList,
  UNGROUPED_SOURCE,
} from "../src/panels/problems-panel";
import { getPanel, panelContext, resetPanels } from "../src/panels/panel-registry";
import { notify, problems, resetNotifications } from "../src/services/notify";
import { setActiveRegistry } from "../src/commands/active-registry";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext, makeContext } from "../src/commands/context";
import type { CommandContext } from "../src/commands/context";
import type { TemplateResult } from "lit-html";

let ctx: CommandContext = emptyContext();
const ran: { id: string; args: unknown }[] = [];

/** A registry with one command that is visible, and refused when there is nothing to undo. */
function buildRegistry() {
  const registry = createCommandRegistry({ getContext: () => ctx });
  registry.register({
    category: "File",
    id: "file.save",
    level: "document",
    requires: "an open document",
    run: (_c, args) => {
      ran.push({ args, id: "file.save" });
    },
    title: "Save",
    when: () => true,
    enablement: (c) => c.document.open,
  });
  return registry;
}

beforeEach(() => {
  // The path button hands off to `files/files.ts`'s `openFileInTab` through a lazy import, which
  // Reaches the PAL. Registering the in-memory platform is what keeps that click inert here
  // Instead of rejecting into whichever test happens to be running when the import resolves.
  installMockPlatform();
  resetNotifications();
  resetPanels();
  ran.length = 0;
  ctx = makeContext({ document: { open: true } });
  setActiveRegistry(buildRegistry());
});

afterEach(() => {
  resetNotifications();
  resetPanels();
  setActiveRegistry(null);
});

function body(): TemplateResult {
  return renderProblemsList() as TemplateResult;
}

describe("groupProblems", () => {
  test("groups by source in first-seen order, and names the ungrouped group", () => {
    notify.error("A", { source: "Save" });
    notify.error("B", {});
    notify.warn("C", { source: "Save", tier: "problem" });
    const groups = groupProblems();
    expect(groups.map((group) => group.source)).toEqual(["Save", UNGROUPED_SOURCE]);
    expect(groups[0]!.records.map((record) => record.message)).toEqual(["A", "C"]);
  });

  test("reads the live store by default", () => {
    notify.error("live");
    expect(groupProblems()).toHaveLength(1);
    expect(groupProblems([])).toEqual([]);
  });
});

describe("rendering", () => {
  test("an empty list says nothing needs fixing, in the words of what the region is for", async () => {
    const host = await renderInto(body());
    expect(host.textContent).toContain("Nothing needs fixing");
    expect(host.querySelector(".problem-row")).toBeNull();
  });

  test("a row carries severity, message, source, path and detail", async () => {
    notify.error("project.json:14 unknown key", {
      detail: "at $.adaptor",
      path: "project.json",
      source: "Validation",
    });
    const host = await renderInto(body());
    const row = host.querySelector(".problem-row") as HTMLElement;
    expect(row.classList.contains("problem-row--error")).toBe(true);
    expect(host.querySelector(".problem-group-title")?.textContent).toContain("Validation");
    expect(host.querySelector(".problem-message")?.textContent).toContain("unknown key");
    expect(host.querySelector(".problem-path")?.textContent).toContain("project.json");
    expect(host.querySelector(".problem-detail")?.textContent).toContain("at $.adaptor");
  });

  test("a problem with no path and no detail renders neither", async () => {
    notify.error("bare");
    const host = await renderInto(body());
    expect(host.querySelector(".problem-path")).toBeNull();
    expect(host.querySelector(".problem-detail")).toBeNull();
  });

  test("clicking a path hands off to the file opener without throwing", async () => {
    notify.error("bad", { path: "pages/index.md" });
    const host = await renderInto(body());
    expect(() => (host.querySelector(".problem-path") as HTMLElement).click()).not.toThrow();
    await flush();
  });

  test("dismissing a row takes it off the store", async () => {
    notify.error("go away");
    const host = await renderInto(body());
    (host.querySelector(".problem-dismiss") as HTMLElement).click();
    expect(problems).toHaveLength(0);
  });

  test("Clear takes the whole list", async () => {
    notify.error("one");
    notify.error("two");
    const host = await renderInto(body());
    const clear = host.querySelector(".problems-clear") as HTMLElement;
    expect(clear.textContent).toContain("Clear 2");
    clear.click();
    expect(problems).toHaveLength(0);
  });
});

describe("the recovery button is the command record", () => {
  test("its label is the command's title, and clicking it runs the command with its args", async () => {
    notify.error("Save failed", { action: "file.save", actionArgs: { path: "a.md" } });
    const host = await renderInto(body());
    const action = host.querySelector(".problem-action") as HTMLButtonElement;
    expect(action.textContent?.trim()).toBe("Save");
    expect(action.disabled).toBe(false);
    action.click();
    expect(ran).toEqual([{ args: { path: "a.md" }, id: "file.save" }]);
  });

  test("a refused command renders disabled, with the requires sentence as its tooltip", async () => {
    ctx = makeContext({ document: { open: false } });
    notify.error("Save failed", { action: "file.save" });
    const host = await renderInto(body());
    const action = host.querySelector(".problem-action") as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.getAttribute("title")).toContain("requires an open document");
  });

  test("a command the registry does not have renders no button at all", async () => {
    notify.error("Attach failed", { action: "collab.retry" });
    const host = await renderInto(body());
    expect(host.querySelector(".problem-action")).toBeNull();
  });

  test("no registry at all is a row with no button, not a crash", async () => {
    setActiveRegistry(null);
    notify.error("Save failed", { action: "file.save" });
    const host = await renderInto(body());
    expect(host.querySelector(".problem-row")).not.toBeNull();
    expect(host.querySelector(".problem-action")).toBeNull();
  });

  test("a problem that named no command renders no button", async () => {
    notify.error("nothing to do");
    const host = await renderInto(body());
    expect(host.querySelector(".problem-action")).toBeNull();
  });
});

describe("the panel record", () => {
  test("is the Bottom dock's project-level Problems tab, with the count as its badge", () => {
    registerProblemsPanel();
    const panel = getPanel("problems")!;
    expect(panel.dock).toBe("bottom");
    // Rail-able all the same: the badge and ⌘4 are what §7.2 keeps on the rail.
    expect(panel.rail).toBeUndefined();
    expect(panel.level).toBe("project");
    expect(panel.title).toBe("Problems");
    // P3 registered this id with `when: () => false`. The predicate is what P4.2 deleted.
    expect(panel.when).toBeUndefined();

    const pctx = panelContext();
    expect(panel.badge?.(pctx)).toBeNull();
    notify.error("one");
    expect(panel.badge?.(pctx)).toBe(1);
  });

  test("renders through the record with no document — it is project level", () => {
    registerProblemsPanel();
    const panel = getPanel("problems")!;
    expect(() => panel.render({ deps: {} as never, doc: null, rerender: () => {} })).not.toThrow();
  });

  test("has exactly one registration site — a second call is a duplicate, and throws", () => {
    // The guard that used to make this idempotent existed because two hosts registered the record.
    // One host, one caller: a second call is a genuine second definition and must fail loudly.
    registerProblemsPanel();
    expect(() => registerProblemsPanel()).toThrow(/already registered/);
  });
});
