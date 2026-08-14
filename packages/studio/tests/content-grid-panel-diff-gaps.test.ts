/**
 * Diff-gap coverage for the content / grid / panel surfaces: the branches each module takes when
 * the thing it was drawn for is NOT there.
 *
 * Every test here is about a refusal rather than a happy path — the entry editor's door out of a
 * document that belongs to no collection, a saved view that was never saved, a CSV row with nothing
 * on it, a grid tab that is already open, a turn whose ledger summarises to nothing, the Logic
 * tab's Close, and a repaint that lands after the stage has taken its host away. Each one is paired
 * with the positive case it is the negation of, so inverting the guard in the source fails a test
 * in BOTH directions.
 */
import {
  flush,
  installMockPlatform,
  pointer,
  registerPrimaryStage,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
  surfaceOf,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render as litRender } from "lit-html";
import type { AiWrite } from "../src/services/ai-writes";
import type { AnyCommand } from "../src/commands/registry";
import type { Message } from "@jxsuite/ai/chat-state";
import type { Tab } from "../src/tabs/tab";

// ─── The one mocked collaborator ─────────────────────────────────────────────
//
// `chat-view.ts` asks `ai-writes.ts` two questions per assistant turn: what did it change, and how
// Does that read as a sentence. The real ledger can never answer "something, but no sentence" — a
// Non-empty write list always summarises to either "Changed N files" or "N changes failed" — so the
// Stub is the only way to state what the view does with a summary it cannot print, which is a
// Contract between the two modules rather than an invented state.

let stubWrites: AiWrite[] = [];
let stubSummary = "";

void mock.module("../src/services/ai-writes", () => ({
  MAX_TURNS: 50,
  beginTurn: () => {},
  endTurn: () => [],
  recordWrite: () => {},
  resetAiWrites: () => {},
  summarizeWrites: () => stubSummary,
  writesForTurn: () => stubWrites,
}));

const { activeTab, closeAllTabs, openTab, workspace } = await import("../src/workspace/workspace");
const { createCommandRegistry } = await import("../src/commands/registry");
const { makeContext } = await import("../src/commands/context");
const { setActiveRegistry } = await import("../src/commands/active-registry");
const { detachEntryPane, renderEntryMode, setEntryDraft } =
  await import("../src/content/entry-editor");
const { getGridController } = await import("../src/grid/grid-controller");
const {
  activeViewName,
  clearGridLayout,
  deleteSavedView,
  listSavedViews,
  saveGridLayout,
  saveViewAs,
} = await import("../src/grid/grid-layout");
const { parseRedirectsCsv } = await import("../src/grid/redirects");
const { REDIRECTS_TAB_ID, openRedirectsGrid } = await import("../src/grid/redirects-grid");
const { logicPanelBody, logicTarget } = await import("../src/panels/formula-workspace");
const { renderMessageList } = await import("../src/panels/ai-chat/chat-view");
const { initShellRefs, registerRenderer } = await import("../src/store");
const frontmatterPanel = await import("../src/panels/frontmatter-panel");

/** What the click handlers under test asked the registry to run, in order. */
const ran: [string, unknown][] = [];

/** One record, as bare as the registry allows — the view must not care what it does. */
function stub(id: string, title: string): AnyCommand {
  return {
    category: "Settings",
    id,
    level: "application",
    run: (_ctx: unknown, args: unknown) => {
      ran.push([id, args]);
    },
    title,
  } as unknown as AnyCommand;
}

function installRegistry(): void {
  const registry = createCommandRegistry({ getContext: () => makeContext(), mac: true });
  registry.registerAll([stub("settings.open", "Project Settings")]);
  setActiveRegistry(registry);
}

/** A detached host lit can paint into, fresh per test so no render part is reused. */
function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

beforeEach(() => {
  ran.length = 0;
  closeAllTabs();
  resetStudioState();
  installRegistry();
});

afterEach(() => {
  detachEntryPane("primary");
  setActiveRegistry(null);
  closeAllTabs();
  document.body.replaceChildren();
});

// ─── The entry editor, on a document that is in no collection ────────────────

describe("the entry editor's way out of a document with no schema", () => {
  /** Mount the entry form for a path no `content` block claims. */
  async function mountNotAnEntry(): Promise<HTMLElement> {
    resetStudioState({ projectConfig: { name: "Demo" } });
    const tab = resetWorkspaceWithTab(undefined, {
      documentPath: "pages/index.json",
      id: "c7-entry-tab",
    }) as unknown as Tab;
    const el = host();
    renderEntryMode(surfaceOf(el), tab);
    await flush();
    return el;
  }

  test("Content types… opens Project Settings AT the content section", async () => {
    const el = await mountNotAnEntry();
    const button = el.querySelector("sp-action-button");
    expect(button?.textContent).toContain("Content types");
    expect(el.textContent).toContain("is not an entry of any content collection");

    pointer(button!, "click");

    // The section is the whole point of the button: `settings.open` with no argument lands on
    // Whichever section was last open, which is not the one that would fix this document.
    expect(ran).toEqual([["settings.open", { section: "content" }]]);
  });

  test("with no registry composed yet the button is inert rather than a crash", async () => {
    setActiveRegistry(null);
    const el = await mountNotAnEntry();
    pointer(el.querySelector("sp-action-button")!, "click");
    expect(ran).toEqual([]);
  });

  test("that inertness is a no-op, not an exception the DOM swallowed", async () => {
    setActiveRegistry(null);
    const el = await mountNotAnEntry();
    const button = el.querySelector("sp-action-button")!;

    // Happy-dom catches whatever a dispatched listener throws and re-raises it as an `error` event
    // On the window, so "nothing ran" and "it threw a TypeError" are the SAME observation from
    // `ran` alone. Without this listener, dropping the `?.` from `activeRegistry()?.run(...)` is
    // Invisible: the crash is caught, the command still does not run, and the test still passes.
    const escaped: unknown[] = [];
    const onError = (event: Event) => {
      escaped.push((event as ErrorEvent).error ?? event);
    };
    globalThis.addEventListener("error", onError);
    try {
      pointer(button, "click");
    } finally {
      globalThis.removeEventListener("error", onError);
    }
    expect(escaped).toEqual([]);
    expect(ran).toEqual([]);

    // And the SAME button works the moment a registry exists: the missing registry was read at
    // Click time, so the empty pane is not a button that has to be re-rendered to come back.
    installRegistry();
    pointer(button, "click");
    expect(ran).toEqual([["settings.open", { section: "content" }]]);
  });
});

// ─── The entry form's own repaint loop ───────────────────────────────────────

describe("the entry form's repaints, and the pane that stops owning it", () => {
  /** A project with one JSON collection that has a draft axis, and a tab holding an entry of it. */
  function mountEntry(): { el: HTMLElement; tab: Tab } {
    resetStudioState({
      projectConfig: {
        content: {
          notes: {
            format: "json",
            schema: {
              properties: { draft: { type: "boolean" }, title: { type: "string" } },
              type: "object",
            },
            source: "notes",
          },
        },
        name: "Demo",
      },
    });
    const tab = resetWorkspaceWithTab(undefined, {
      documentPath: "notes/hello.json",
      id: "c7-note-tab",
    }) as unknown as Tab;
    const el = host();
    renderEntryMode(surfaceOf(el), tab);
    return { el, tab };
  }

  test("a field commit repaints the form, and detaching the pane ends that for good", async () => {
    const { el, tab } = mountEntry();
    expect(el.querySelector(".entry-editor-collection")?.textContent).toContain("notes");
    expect(el.querySelector(".entry-editor-note")).toBeNull();

    // The form's effect owns the repaint: nothing calls `draw()` after a commit, the entry's own
    // Fields do. Inverting the effect's `activeIn(paneId) !== panel` guard blanks the pane on the
    // FIRST render, so both this line and the one above it fail.
    setEntryDraft(tab, true);
    await flush();
    expect(el.querySelector(".entry-editor-note")?.textContent).toContain("Marked a draft");
    expect(el.querySelector(".entry-draft-switch")).not.toBeNull();

    detachEntryPane("primary");
    setEntryDraft(tab, false);
    await flush();
    // Frozen exactly as the pane left it. A detached form is not merely skipped when it repaints —
    // Its scope is stopped, so it never repaints at all, which is why the effect's own guard cannot
    // Be reached from here: an effect that has been stopped is not re-run to see it.
    expect(el.querySelector(".entry-editor-note")).not.toBeNull();
  });
});

// ─── Saved grid views ────────────────────────────────────────────────────────

describe("deleting a saved grid view", () => {
  const GRID = "c7-grid";

  beforeEach(() => {
    clearGridLayout(GRID);
  });

  afterEach(() => {
    clearGridLayout(GRID);
  });

  test("a name the grid never saved deletes nothing and reports that it did not", () => {
    saveGridLayout(GRID, { hidden: ["body"] });
    saveViewAs(GRID, "Wide");
    expect(activeViewName(GRID)).toBe("Wide");

    expect(deleteSavedView(GRID, "Narrow")).toBeFalse();
    // Nothing was rewritten: the view is still there and it is still the applied one.
    expect(listSavedViews(GRID).map((view) => view.name)).toEqual(["Wide"]);
    expect(activeViewName(GRID)).toBe("Wide");

    // The same call for a name the grid DOES hold is the other half of the answer.
    expect(deleteSavedView(GRID, "Wide")).toBeTrue();
    expect(listSavedViews(GRID)).toEqual([]);
    expect(activeViewName(GRID)).toBeNull();
  });
});

// ─── The CSV redirect reader ─────────────────────────────────────────────────

describe("importing redirects from CSV", () => {
  test("a row with nothing on it is skipped in silence, not accused of being half-filled", () => {
    const result = parseRedirectsCsv("source,destination,status\n/old,/new,302\n,,\n/a,/b,\n");
    expect(result.format).toBe("csv");
    expect(result.rules).toEqual([
      { destination: "/new", source: "/old", status: 302 },
      { destination: "/b", source: "/a", status: 301 },
    ]);
    // The blank row must produce NO finding: an author who pasted a file with a spacer line in it
    // Has done nothing wrong, and "Row 3: both a source and a destination are required" is the
    // Complaint that would make them go looking for a mistake they did not make.
    expect(result.errors).toEqual([]);
  });

  test("a row with only one of the two IS reported, by its row number", () => {
    const result = parseRedirectsCsv("source,destination\n,,\n/old,\n");
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual(["Row 3: both a source and a destination are required."]);
  });

  test("a paste that is nothing but spacer rows imports nothing and complains about nothing", () => {
    const result = parseRedirectsCsv("source,destination\n,\n,\n,\n");
    expect(result.rules).toEqual([]);
    // EVERY blank row is skipped, not just the first — three spacer lines are three silences, and
    // A file of them is an empty import rather than a list of three things the author did wrong.
    expect(result.errors).toEqual([]);
  });
});

// ─── The redirects grid tab ──────────────────────────────────────────────────

describe("opening the redirects grid", () => {
  test("a second open hands back the controller the tab already has", async () => {
    const redirects = { "/old": "/new" };
    installMockPlatform({}, { "project.json": JSON.stringify({ name: "site", redirects }) });
    resetStudioState({ projectConfig: { name: "site", redirects } });

    const first = await openRedirectsGrid();
    expect(first.state.rows.map((row) => row.cells.source)).toEqual(["/old"]);

    const second = await openRedirectsGrid();
    // The SAME controller, so a staged import or a pending cell edit survives re-opening the tab
    // From the palette — a fresh controller would silently drop the edit buffer.
    expect(second).toBe(first);
    expect([...workspace.tabs.keys()].filter((id) => id === REDIRECTS_TAB_ID)).toHaveLength(1);
    expect(activeTab.value?.id).toBe(REDIRECTS_TAB_ID);
  });

  test("a tab that outlived its controller is reused, not replaced", async () => {
    const redirects = { "/old": "/new" };
    installMockPlatform({}, { "project.json": JSON.stringify({ name: "site", redirects }) });
    resetStudioState({ projectConfig: { name: "site", redirects } });

    const first = await openRedirectsGrid();

    // `openTab` on an id the workspace already holds DISPOSES the sitting tab and builds a new one
    // Under the same id — and the controller registry is keyed on the tab object and torn down with
    // Its scope, so the id survives and the controller does not. That is the state between the two
    // Guards: a tab is there, `getGridController` answers null, and neither returning early nor
    // Opening a second tab is the right move.
    const rebuilt = openTab({
      capabilities: { modes: ["grid"] },
      document: { children: [], tagName: "div" },
      documentPath: null,
      id: REDIRECTS_TAB_ID,
    });
    (rebuilt.doc.document as Record<string, unknown>).marker = "the tab the author is looking at";
    expect(getGridController(rebuilt)).toBeNull();

    const third = await openRedirectsGrid();
    expect(third).not.toBe(first);
    // A fresh controller, and a LOADED one: returning before `load()` hands back a grid with no
    // Columns and no rows, which is what a staged import would then be staged against.
    expect(third.state.rows.map((row) => row.cells.source)).toEqual(["/old"]);
    expect(third.state.columns.map((column) => column.field)).toEqual([
      "source",
      "destination",
      "status",
    ]);
    // And it is the SAME tab: opening a second one would throw away the document above with the
    // Author's place in it.
    const open = workspace.tabs.get(REDIRECTS_TAB_ID);
    expect((open?.doc.document as Record<string, unknown> | undefined)?.marker).toBe(
      "the tab the author is looking at",
    );
    expect([...workspace.tabs.keys()].filter((id) => id === REDIRECTS_TAB_ID)).toHaveLength(1);
  });
});

// ─── The assistant's changed-files summary ───────────────────────────────────

describe("the changed-files summary of an assistant turn", () => {
  const turn: Message = {
    content: "Done.",
    id: "c7-msg",
    role: "assistant",
    timestamp: 1,
  } as Message;

  const list = () =>
    renderMessageList({
      error: null,
      listRef: () => {},
      messages: [turn],
      onScroll: () => {},
      status: "idle",
    });

  afterEach(() => {
    stubWrites = [];
    stubSummary = "";
  });

  test("a summary that has something to say is drawn above the file list", async () => {
    stubWrites = [{ disk: false, ok: true, path: "pages/index.json", tool: "write_file" }];
    stubSummary = "Changed 1 file";
    const el = await renderInto(list());
    expect(el.querySelector(".ai-msg-changes > summary")?.textContent).toContain("Changed 1 file");
    expect(el.querySelectorAll(".ai-msg-changes-list li")).toHaveLength(1);
  });

  test("writes that summarise to nothing draw no expander at all", async () => {
    stubWrites = [{ disk: false, ok: true, path: "pages/index.json", tool: "write_file" }];
    stubSummary = "";
    const el = await renderInto(list());
    // An empty <summary> over a file list is a disclosure widget whose label is a blank line.
    expect(el.querySelector(".ai-msg-changes")).toBeNull();
    // The message itself is untouched — only its footer is withheld.
    expect(el.querySelector(".ai-msg-md")?.textContent).toContain("Done.");
  });
});

// ─── The Logic tab's function surface ────────────────────────────────────────

describe("closing the function body in the Logic tab", () => {
  function openFunctionPane(): { dock: HTMLElement; tab: Tab } {
    const tab = resetWorkspaceWithTab(
      {
        children: [],
        state: { greet: { $function: { body: "return 1;" } } },
        tagName: "div",
      } as never,
      { id: "c7-logic-tab" },
    ) as unknown as Tab;
    tab.session.ui.editingFunction = { defName: "greet", type: "def" } as never;
    const dock = host();
    litRender(
      logicPanelBody(() => {}),
      dock,
    );
    return { dock, tab };
  }

  test("Close clears the target, so the tab stops claiming to hold one", async () => {
    const { dock, tab } = openFunctionPane();
    expect(dock.querySelector(".fw-code")).not.toBeNull();
    expect(dock.querySelector(".fw-title")?.textContent).toContain("greet");
    expect(logicTarget(tab)?.surface).toBe("function");

    pointer(dock.querySelector(".fw-close")!, "click");
    await flush();

    expect(tab.session.ui.editingFunction).toBeNull();
    expect(logicTarget(tab)).toBeNull();
    // And the tab redraws as what it now is: nothing open, with the sentence that says so.
    litRender(
      logicPanelBody(() => {}),
      host(),
    );
    const repainted = document.body.lastElementChild as HTMLElement;
    expect(repainted.querySelector(".fw-code")).toBeNull();
    expect(repainted.textContent).toContain("Open a formula or a function to edit it here");
  });
});

// ─── The Document Header card's host ─────────────────────────────────────────

describe("a Document Header repaint that lands after the host is gone", () => {
  const realRaf = globalThis.requestAnimationFrame;
  let frameErrors: unknown[] = [];

  beforeEach(() => {
    frameErrors = [];
    // Happy-dom has no frames; the card's scheduler is driven off a timer instead, and the errors
    // A frame would swallow are captured so a repaint that threw is an assertable fact.
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => {
        try {
          callback(0);
        } catch (error) {
          frameErrors.push(error);
        }
      }, 0)) as unknown as typeof requestAnimationFrame;
    installMockPlatform();
    registerRenderer("frontmatterPanel", () => {
      frontmatterPanel.render();
    });
  });

  afterEach(() => {
    frontmatterPanel.unmount();
    globalThis.requestAnimationFrame = realRaf;
  });

  test("paints the card while the stage hosts one, and nothing once it does not", async () => {
    resetStudioState({ projectConfig: {} });
    document.body.innerHTML = `<div id="app">
      <div class="pane-stage" data-jx-region="pane.primary">
        <div class="doc-header-host"></div>
      </div>
    </div>`;
    initShellRefs();
    registerPrimaryStage();
    const tab = resetWorkspaceWithTab(undefined, {
      documentPath: "pages/index.json",
      id: "c7-fm-tab",
    });
    tab.doc.document.title = "Hello";

    const el = document.querySelector<HTMLElement>(".doc-header-host")!;
    frontmatterPanel.attachDocumentHeaderHost("primary", el);
    await flush(4);
    expect(el.querySelector(".doc-header")).not.toBeNull();
    expect(el.hidden).toBeFalse();

    // The stage asks for a repaint and then redraws itself without a header slot before the frame
    // Lands. The queued repaint still runs, and it has nowhere to paint.
    frontmatterPanel.render();
    frontmatterPanel.attachDocumentHeaderHost("primary", null);
    await flush(4);

    expect(frontmatterPanel.documentHeaderHost("primary")).toBeNull();
    expect(frameErrors).toEqual([]);
    // The element the stage took back is left exactly as it was — the orphaned repaint neither
    // Cleared it nor hid it, because it never ran against it.
    expect(el.querySelector(".doc-header")).not.toBeNull();
    expect(el.hidden).toBeFalse();
  });
});
