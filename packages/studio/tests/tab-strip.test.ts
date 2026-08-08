/**
 * Tab strip — reactive rendering of open tabs, activation, dirty indicator, the close flow
 * (including the unsaved-changes confirm dialog), and the `context/tab` menu.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { confirmCloseAll, mount, unmount } from "../src/panels/tab-strip";
import { collabState } from "../src/collab/collab-state";
import {
  closeAllTabs,
  closePane,
  closeTab,
  focusPane,
  openTab,
  paneCommands,
  splitRight,
  tabCommands,
  workspace,
} from "../src/workspace/workspace";
import { initLayers } from "../src/ui/layers";
import { createCommandRegistry } from "../src/commands/registry";
import { setActiveRegistry } from "../src/commands/active-registry";
import { makeContext } from "../src/commands/context";
import { defaultCommands, noopCommandDeps } from "../src/commands/defaults";
import { contentCommands } from "../src/content/entry-commands";
import { BUFFER_COMMIT, bufferWrites } from "../src/services/monaco-buffer";
import { view } from "../src/view";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";
import { surfaceForPane } from "../src/canvas/surface-registry";

let host: HTMLElement;

function open(id: string, documentPath: string | null = `/project/${id}.json`) {
  return openTab({
    document: { children: [], tagName: "div" } as JxMutableNode,
    documentPath,
    id,
  });
}

function tabs(): HTMLElement[] {
  return [...host.querySelectorAll(".tab-strip-tab")] as HTMLElement[];
}

function strip(): HTMLElement {
  return host.querySelector(".tab-strip") as HTMLElement;
}

// Happy-dom performs no layout (scrollWidth/clientWidth are 0); stub them to fake overflow.
function stubMetrics(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
}

function wheel(target: HTMLElement, init: WheelEventInit = {}) {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // Happy-dom's WheelEvent constructor drops modifier-key init fields; force them.
  if (init.ctrlKey) {
    Object.defineProperty(e, "ctrlKey", { value: true });
  }
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="tab-strip"></div>
    <div id="layer-popover"></div>
    <div id="layer-modal"></div>
    <div id="layer-dialog"></div>
  `;
  initLayers();
  host = document.querySelector("#tab-strip") as HTMLElement;
  closeAllTabs();
  mount(host);
});

afterEach(() => {
  unmount();
  closeAllTabs();
  document.body.innerHTML = "";
});

describe("tab strip rendering", () => {
  test("renders nothing with no tabs", async () => {
    await flush();
    expect(host.querySelector(".tab-strip")).toBeNull();
  });

  test("renders a tab per open document with file-name labels", async () => {
    open("a", "/project/pages/home.json");
    open("b", "/project/about.json");
    await flush();
    const els = tabs();
    expect(els.length).toBe(2);
    expect(els[0]!.querySelector(".tab-strip-label")!.textContent).toBe("home.json");
    expect(els[1]!.querySelector(".tab-strip-label")!.textContent).toBe("about.json");
    expect(els[0]!.getAttribute("title")).toBe("/project/pages/home.json");
  });

  test("tab without a documentPath is labeled Untitled", async () => {
    open("untitled", null);
    await flush();
    expect(tabs()[0]!.querySelector(".tab-strip-label")!.textContent).toBe("Untitled");
    expect(tabs()[0]!.getAttribute("title")).toBe("Untitled");
  });

  test("active tab gets the active class and dirty tabs get the dot", async () => {
    const a = open("a");
    open("b");
    await flush();
    expect(tabs()[1]!.classList.contains("active")).toBe(true);
    expect(tabs()[0]!.classList.contains("active")).toBe(false);
    expect(host.querySelector(".tab-strip-dirty")).toBeNull();

    a.doc.dirty = true;
    await flush();
    expect(tabs()[0]!.querySelector(".tab-strip-dirty")).not.toBeNull();
    expect(tabs()[1]!.querySelector(".tab-strip-dirty")).toBeNull();
  });

  test("rerenders when tabs open and close", async () => {
    open("a");
    await flush();
    expect(tabs().length).toBe(1);
    open("b");
    await flush();
    expect(tabs().length).toBe(2);
    closeAllTabs();
    await flush();
    expect(host.querySelector(".tab-strip")).toBeNull();
  });

  test("unmount stops reactive rendering", async () => {
    open("a");
    await flush();
    unmount();
    open("b");
    await flush();
    expect(tabs().length).toBe(1);
  });
});

describe("tab strip interactions", () => {
  test("clicking a tab activates it", async () => {
    open("a");
    open("b");
    await flush();
    tabs()[0]!.click();
    expect(workspace.activeTabId).toBe("a");
    await flush();
    expect(tabs()[0]!.classList.contains("active")).toBe(true);
  });

  test("close button closes a clean tab without confirmation", async () => {
    open("a");
    open("b");
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    expect(workspace.tabs.has("a")).toBe(false);
    expect(tabs().length).toBe(1);
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
  });

  test("middle-click (auxclick) closes the tab", async () => {
    open("a");
    open("b");
    await flush();
    tabs()[0]!.dispatchEvent(
      new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true }),
    );
    await flush();
    expect(workspace.tabs.has("a")).toBe(false);
  });

  test("auxclick with a non-middle button does not close", async () => {
    open("a");
    await flush();
    tabs()[0]!.dispatchEvent(
      new MouseEvent("auxclick", { bubbles: true, button: 2, cancelable: true }),
    );
    await flush();
    expect(workspace.tabs.has("a")).toBe(true);
  });

  test("dirty tab prompts with all three ways out; cancel keeps it open", async () => {
    const a = open("a");
    a.doc.dirty = true;
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("headline")).toBe("Unsaved Changes");
    expect(dialog.textContent).toContain("a.json");
    // §8.7 assigns unsaved-work decisions to the three-way dialog. The two-way confirm this
    // Replaced said "Close without saving?" — the work-keeping answer was not on offer at all.
    expect(dialog.getAttribute("confirm-label")).toBe("Save");
    expect(dialog.getAttribute("secondary-label")).toBe("Close Without Saving");
    expect(dialog.getAttribute("cancel-label")).toBe("Cancel");
    dialog.dispatchEvent(new Event("cancel"));
    await flush();
    expect(workspace.tabs.has("a")).toBe(true);
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
  });

  test("dirty tab prompts; Close Without Saving discards the work", async () => {
    const a = open("a");
    a.doc.dirty = true;
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
    dialog.dispatchEvent(new Event("secondary"));
    await flush();
    expect(workspace.tabs.has("a")).toBe(false);
  });

  test("dirty tab prompts; Save writes the document, then closes it", async () => {
    const { state } = installMockPlatform();
    const a = open("a");
    a.doc.dirty = true;
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    (document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement).dispatchEvent(
      new Event("confirm"),
    );
    await flush(6);
    expect(state.files.get("/project/a.json")).toContain('"tagName": "div"');
    expect(workspace.tabs.has("a")).toBe(false);
  });

  test("a save that fails keeps the tab — and the work — open", async () => {
    installMockPlatform({
      writeFile: async () => {
        throw new Error("disk is on fire");
      },
    });
    const a = open("a");
    a.doc.dirty = true;
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    (document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement).dispatchEvent(
      new Event("confirm"),
    );
    await flush(6);
    // Closing on top of a failed write is the loss the prompt exists to prevent.
    expect(workspace.tabs.has("a")).toBe(true);
    expect(a.doc.dirty).toBe(true);
  });

  test("a co-edited dirty tab with peers still on the doc closes without a prompt", async () => {
    const a = open("a");
    a.doc.dirty = true;
    const state = collabState(a);
    state.active = true;
    state.peers = [{ clientId: 2, state: { focusedPath: "/project/a.json" } as never }];
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    // The shared session lives on with the remaining peer — closing is safe, no prompt.
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
    expect(workspace.tabs.has("a")).toBe(false);
  });

  test("the last collaborator on a dirty doc is still prompted before closing", async () => {
    const a = open("a");
    a.doc.dirty = true;
    const state = collabState(a);
    state.active = true;
    // A peer exists but is focused on a different doc — nobody else holds THIS doc.
    state.peers = [{ clientId: 2, state: { focusedPath: "/project/other.json" } as never }];
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).not.toBeNull();
    expect(workspace.tabs.has("a")).toBe(true);
  });

  /**
   * A read-only collaborator's edits are in the browser and NOWHERE else — `onTransact` gates both
   * the publish and the mirror behind `canWrite` — so the two comforts this flow relies on are both
   * false for them: "peers remain, the work is on the server" and "Save will persist it".
   */
  describe("a session this client cannot write to", () => {
    function openReadOnly(id: string) {
      const tab = open(id);
      tab.doc.dirty = true;
      const state = collabState(tab);
      state.active = true;
      state.readOnly = true;
      return tab;
    }

    test("is prompted even with peers still on the doc — nothing was published", async () => {
      const a = openReadOnly("a");
      collabState(a).peers = [{ clientId: 2, state: { focusedPath: "/project/a.json" } as never }];
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();
      expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).not.toBeNull();
      expect(workspace.tabs.has("a")).toBe(true);
    });

    test("is offered discard-or-keep, never a Save it cannot honour", async () => {
      openReadOnly("a");
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
      expect(dialog.getAttribute("headline")).toBe("Changes Cannot Be Saved");
      expect(dialog.textContent).toContain("read access");
      // The three-way dialog's Save would have called `saveFile`, which refuses this tab. A button
      // That cannot work has no place on the dialog whose job is to be trusted about lost work.
      expect(dialog.getAttribute("confirm-label")).toBe("Close Without Saving");
      expect(dialog.getAttribute("cancel-label")).toBe("Keep Editing");
      expect(dialog.getAttribute("secondary-label")).toBeNull();

      dialog.dispatchEvent(new Event("cancel"));
      await flush();
      expect(workspace.tabs.has("a")).toBe(true);
    });

    test("closes on the discard, and never reports a save", async () => {
      const { state } = installMockPlatform();
      openReadOnly("a");
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();
      (document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement).dispatchEvent(
        new Event("confirm"),
      );
      await flush(6);
      expect(workspace.tabs.has("a")).toBe(false);
      // The old flow's Save wrote nothing and said "Saved just now" anyway; this one writes nothing
      // And says so.
      expect(state.files.has("/project/a.json")).toBe(false);
    });
  });

  /**
   * THE LAST KEYSTROKE BEFORE ⌘W, which neither gate could see.
   *
   * A Monaco buffer carries the last 500ms (dock) / 600ms (source) of typing in an armed commit,
   * and nothing marks the document dirty for work it has not received. `shouldWarnOnClose` reads
   * `dirty`, so it said "nothing to lose" — no prompt, the tab closed, and the typing went with it.
   * No disposer can cover this: `closeTab` deletes the tab before any repaint disposes an editor,
   * and every commit then correctly refuses to write into a tab `tabIsLive` says is gone.
   */
  describe("a buffer holding work the document has not been given", () => {
    /** A Monaco stand-in mounted for `tab`, mid-debounce, exactly as both surfaces leave one. */
    function typingBuffer(tab: Tab, text: string, commit: (text: string) => void | Promise<void>) {
      const model: object | null = {};
      const buffer = {
        _editingTab: tab,
        getModel: () => model,
        getValue: () => text,
        hasTextFocus: () => false,
      };
      const writes = bufferWrites(buffer);
      writes.markTyped();
      writes.arm(BUFFER_COMMIT, 500, () => commit(buffer.getValue()));
      return buffer;
    }

    /** What `bodyWriter` does when the commit lands: the document has it, the buffer settles. */
    function landBody(tab: Tab, body: string) {
      (tab.doc.document as unknown as { body?: string }).body = body;
      tab.doc.dirty = true;
      view.functionEditor?._writes?.markSettled();
      surfaceForPane("primary").monacoEditor?._writes?.markSettled();
    }

    afterEach(() => {
      view.functionEditor = null;
      surfaceForPane("primary").monacoEditor = null;
    });

    test("the dock's armed commit runs before the gate, so ⌘W prompts and Save has the text", async () => {
      const a = open("a");
      view.functionEditor = typingBuffer(a, "typed();", (body) => landBody(a, body)) as never;
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();

      // The commit landed WHILE the tab was still open — which is the only moment it could.
      expect((a.doc.document as unknown as { body?: string }).body).toBe("typed();");
      expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).not.toBeNull();
      expect(workspace.tabs.has("a")).toBe(true);
    });

    test("the source view's commit is awaited — it parses before it assigns", async () => {
      const a = open("a");
      surfaceForPane("primary").monacoEditor = typingBuffer(a, "# Never saved", async (text) => {
        await Promise.resolve();
        landBody(a, text);
      }) as never;
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();

      expect((a.doc.document as unknown as { body?: string }).body).toBe("# Never saved");
      expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).not.toBeNull();
      expect(workspace.tabs.has("a")).toBe(true);
    });

    test("typing no commit could land still stops the close", async () => {
      const a = open("a");
      // Unparseable source: the commit ran, kept the buffer rather than resyncing over a half-typed
      // Heading, and deliberately did not settle. That text exists nowhere but the buffer.
      const buffer = {
        _editingTab: a,
        getModel: () => ({}),
        getValue: () => "# Half a headi",
        hasTextFocus: () => false,
      };
      bufferWrites(buffer).markTyped();
      surfaceForPane("primary").monacoEditor = buffer as never;
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();

      expect(a.doc.dirty).toBe(false); // Nothing made it dirty, and it is still unsaved work
      expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).not.toBeNull();
      expect(workspace.tabs.has("a")).toBe(true);
    });

    /**
     * …AND THE PROMPT MUST NOT OFFER TO SAVE IT, because Save writes the document and the document
     * is precisely what does not contain this text.
     *
     * The three-way dialog appeared, the author chose the careful answer, `saveFile` wrote the file
     * as it stood — without the half-typed heading — reported "Saved just now" and closed the tab.
     * §14.7: a dialog may not offer an answer the app cannot honour. `requestClose` has already run
     * every commit by the time it asks, so a buffer still marked `typed()` means the commit COULD
     * NOT land, and there is no version of Save that includes it.
     */
    test("…and is not offered a Save that would write the document without it", async () => {
      const a = open("a");
      a.doc.dirty = true; // Other, saveable edits exist — Save is still not honest about the text.
      const buffer = {
        _editingTab: a,
        getModel: () => ({}),
        getValue: () => "# Half a headi",
        hasTextFocus: () => false,
      };
      bufferWrites(buffer).markTyped();
      surfaceForPane("primary").monacoEditor = buffer as never;
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();

      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
      expect(dialog.getAttribute("headline")).toBe("Changes Cannot Be Saved");
      expect(dialog.getAttribute("secondary-label")).toBeNull();
      expect(dialog.getAttribute("confirm-label")).toBe("Close Without Saving");
      expect(dialog.getAttribute("cancel-label")).toBe("Keep Editing");
      expect(dialog.textContent).toContain("does not parse");
    });

    /**
     * THE AWAIT IS A WINDOW, and everything below it was addressed to a tab captured above it.
     *
     * The flush is new, and it made `requestClose` async before its first read of `tab`. A source
     * commit parses through the format host, and a project switch (`closeAllTabs`) or the preview
     * slot's replacement destroys tabs synchronously from an event this close is not ordered
     * against — so the tab can be gone by the time the promise resolves. What followed was a prompt
     * about a document nobody can see, whose **Save** button calls `saveFile(tab)`: a write of
     * `tab.documentPath`, which is project-relative, through a `platform.projectRoot` the switch
     * has already moved. The old project's document, into the new project, at the same path.
     */
    test("a tab destroyed inside the commit's await is not prompted about", async () => {
      const a = open("a");
      a.doc.dirty = true; // The gate fires on this, if it is ever reached.
      surfaceForPane("primary").monacoEditor = typingBuffer(a, "# Never saved", async (text) => {
        // The project switch, arriving mid-parse. It takes every tab with it, unprompted.
        closeAllTabs();
        await Promise.resolve();
        landBody(a, text);
      }) as never;
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();

      expect(workspace.tabs.has("a")).toBe(false);
      expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
    });

    /**
     * THE CONDITION THAT PRODUCES THE RESIDUE IS THE ONE THAT USED TO SUPPRESS THE WARNING.
     *
     * "Peers remain, so the edits are still on the server" holds only for a client whose edits
     * REACH the server, and `collabReadOnly` was carved out as the one exception. The
     * source-canonical freeze is the second: a refused `transactDoc` never reaches `onTransact`, so
     * nothing is published, nothing is mirrored, nothing is written — for EVERY client, not merely
     * a read-only one. And the two predicates are the same predicate, because the peer holding the
     * source lock is by definition a peer focused on this path: the busier the room, the quieter
     * the close became.
     */
    test("a co-edited tab with peers still loses the buffer's residue, so it prompts", async () => {
      const a = open("a");
      const state = collabState(a);
      state.active = true;
      state.peers = [{ clientId: 2, state: { focusedPath: "/project/a.json" } as never }];
      // What the freeze leaves: `bodyWriter` was refused, so the buffer never settled and the
      // Document is not even dirty.
      const buffer = {
        _editingTab: a,
        getModel: () => ({}),
        getValue: () => "state.count += 1;",
        hasTextFocus: () => false,
      };
      bufferWrites(buffer).markTyped();
      view.functionEditor = buffer as never;
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();

      expect(a.doc.dirty).toBe(false);
      expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).not.toBeNull();
      expect(workspace.tabs.has("a")).toBe(true);
    });

    test("a buffer that is merely AHEAD is not unsaved work, and closes without a word", async () => {
      const a = open("a");
      // Format-on-open, over a body `closeFunctionEditor` minified: the buffer differs from the
      // Document for as long as the editor is open, and an author loses nothing by leaving.
      const buffer = {
        _editingTab: a,
        getModel: () => ({}),
        getValue: () => "return 1;\n",
        hasTextFocus: () => false,
      };
      bufferWrites(buffer).markAhead();
      view.functionEditor = buffer as never;
      await flush();
      (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
      await flush();

      expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
      expect(workspace.tabs.has("a")).toBe(false);
    });
  });

  /**
   * THE ONE EXIT WITH NO GATE AT ALL, until now: activating another project.
   *
   * `closeAllTabs()` disposes every open document and asks nobody. ⌘W, the tab ×, quitting and the
   * preview slot's replacement each acquired a gate over eight rounds; the gesture that throws away
   * the WHOLE workspace at once never had one, so a project switch discarded every dirty document
   * silently and by design.
   */
  describe("closing the whole workspace at once", () => {
    afterEach(() => {
      view.functionEditor = null;
      surfaceForPane("primary").monacoEditor = null;
    });

    test("nothing unsaved needs no prompt", async () => {
      open("a");
      open("b");
      await flush();
      expect(await confirmCloseAll("Opening another project")).toBe(true);
      expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
    });

    test("one prompt for the set, naming how many documents are unsaved", async () => {
      open("a").doc.dirty = true;
      open("b").doc.dirty = true;
      open("c");
      await flush();
      const answering = confirmCloseAll("Opening another project");
      await flush();
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
      // ONE dialog for three tabs, and it counts only the two that would lose work.
      expect(document.querySelectorAll("#layer-dialog sp-dialog-wrapper")).toHaveLength(1);
      expect(dialog.textContent).toContain("2 documents have unsaved changes");
      expect(dialog.getAttribute("confirm-label")).toBe("Save All");

      dialog.dispatchEvent(new Event("cancel"));
      expect(await answering).toBe(false);
      // Cancel keeps the workspace exactly as it was — the switch has not started.
      expect(workspace.tabs.size).toBe(3);
    });

    test("a single unsaved document is named rather than counted", async () => {
      open("a").doc.dirty = true;
      await flush();
      const answering = confirmCloseAll("Opening another project");
      await flush();
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
      expect(dialog.textContent).toContain('"a.json" has unsaved changes');
      dialog.dispatchEvent(new Event("secondary"));
      expect(await answering).toBe(true);
    });

    test("Save All writes every one of them, and a failed write cancels the switch", async () => {
      const { state } = installMockPlatform();
      open("a").doc.dirty = true;
      open("b").doc.dirty = true;
      await flush();
      let answering = confirmCloseAll("Opening another project");
      await flush();
      (document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement).dispatchEvent(
        new Event("confirm"),
      );
      expect(await answering).toBe(true);
      expect(state.files.has("/project/a.json")).toBe(true);
      expect(state.files.has("/project/b.json")).toBe(true);

      // And when a write fails, the answer is "no" — an author who watched a save fail must not
      // Then watch the document be discarded because they asked to save it.
      installMockPlatform({
        writeFile: () => Promise.reject(new Error("disk full")),
      });
      const c = open("c");
      c.doc.dirty = true;
      await flush();
      answering = confirmCloseAll("Opening another project");
      await flush();
      (document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement).dispatchEvent(
        new Event("confirm"),
      );
      expect(await answering).toBe(false);
    });

    /** An unparseable source buffer on `id`, which is what makes a tab un-saveable. */
    function blockTab(id: string) {
      const tab = open(id);
      const buffer = {
        _editingTab: tab,
        getModel: () => ({}),
        getValue: () => "# Half a headi",
        hasTextFocus: () => false,
      };
      bufferWrites(buffer).markTyped();
      surfaceForPane("primary").monacoEditor = buffer as never;
      return tab;
    }

    /**
     * §14.7 SAYS A DIALOG MAY NOT OFFER AN ANSWER THE APP CANNOT HONOUR. It does not say to
     * withdraw one it can.
     *
     * The blocked check was all-or-nothing, so one unparseable source buffer among five dirty
     * documents left "Close Without Saving" as the only forward answer — and taking it threw away
     * four documents that would have written perfectly, none of them even named. The rule the
     * button actually has to satisfy is that its LABEL is true: "Save All" is a lie here, and "Save
     * 2 of 3" is not.
     */
    test("one blocked document does not take Save away from the ones that can be written", async () => {
      const { state } = installMockPlatform();
      open("a").doc.dirty = true;
      open("b").doc.dirty = true;
      blockTab("c");
      await flush();
      const answering = confirmCloseAll("Opening another project");
      await flush();
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;

      expect(dialog.getAttribute("headline")).toBe("Unsaved Changes");
      expect(dialog.getAttribute("confirm-label")).toBe("Save 2 of 3");
      expect(dialog.getAttribute("secondary-label")).toBe("Close Without Saving");
      // The split is named, so the honest answer is still a legible one.
      expect(dialog.textContent).toContain("3 documents have unsaved changes");
      expect(dialog.textContent).toContain('"c.json" cannot be saved at all');
      expect(dialog.textContent).toContain("saving writes the other 2 and discards that one");

      dialog.dispatchEvent(new Event("confirm"));
      expect(await answering).toBe(true);
      expect(state.files.has("/project/a.json")).toBe(true);
      expect(state.files.has("/project/b.json")).toBe(true);
      // And the blocked one is never attempted: `saveFile` would report success for a write that
      // Left the buffer's text behind, which is exactly why it was named on the button.
      expect(state.files.has("/project/c.json")).toBe(false);
    });

    test("two blocked documents are counted rather than named, and both are excluded", async () => {
      const { state } = installMockPlatform();
      open("a").doc.dirty = true;
      // A read-only session is the other way a tab cannot be saved — nothing was ever published.
      const b = open("b");
      b.doc.dirty = true;
      Object.assign(collabState(b), { active: true, readOnly: true });
      blockTab("c");
      await flush();
      const answering = confirmCloseAll("Opening another project");
      await flush();
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
      expect(dialog.getAttribute("confirm-label")).toBe("Save 1 of 3");
      expect(dialog.textContent).toContain("2 of them cannot be saved at all");
      expect(dialog.textContent).toContain("saving writes the other 1 and discards those");
      dialog.dispatchEvent(new Event("confirm"));
      expect(await answering).toBe(true);
      expect(state.files.has("/project/a.json")).toBe(true);
      expect(state.files.has("/project/b.json")).toBe(false);
      expect(state.files.has("/project/c.json")).toBe(false);
    });

    /** {@link shouldWarnOnClose} is the one definition, so the set inherits the freeze fix free. */
    test("a co-edited tab whose buffer the room never saw is counted in the set", async () => {
      const a = open("a");
      const state = collabState(a);
      state.active = true;
      state.peers = [{ clientId: 2, state: { focusedPath: "/project/a.json" } as never }];
      const buffer = {
        _editingTab: a,
        getModel: () => ({}),
        getValue: () => "state.count += 1;",
        hasTextFocus: () => false,
      };
      bufferWrites(buffer).markTyped();
      view.functionEditor = buffer as never;
      await flush();
      const answering = confirmCloseAll("Opening another project");
      await flush();
      // Without the freeze fix there is no prompt at all: the peer count answered for text the
      // Room was never told about, and the switch took it silently.
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
      expect(dialog).not.toBeNull();
      expect(dialog.textContent).toContain('"a.json" has unsaved changes');
      // And Save is not on offer, because the document does not contain the buffer's text either.
      expect(dialog.getAttribute("headline")).toBe("Changes Cannot Be Saved");
      dialog.dispatchEvent(new Event("confirm"));
      expect(await answering).toBe(true);
    });

    test("when NOTHING in the set can be saved the prompt drops to the honest pair", async () => {
      blockTab("b");
      await flush();
      const answering = confirmCloseAll("Opening another project");
      await flush();
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
      expect(dialog.getAttribute("headline")).toBe("Changes Cannot Be Saved");
      expect(dialog.getAttribute("secondary-label")).toBeNull();
      expect(dialog.textContent).toContain('"b.json" cannot be saved at all');
      dialog.dispatchEvent(new Event("confirm"));
      expect(await answering).toBe(true);
    });

    test("the buffers are committed before the count is taken", async () => {
      const a = open("a");
      const model: object | null = {};
      const buffer = {
        _editingTab: a,
        getModel: () => model,
        getValue: () => "typed();",
        hasTextFocus: () => false,
      };
      const writes = bufferWrites(buffer);
      writes.markTyped();
      writes.arm(BUFFER_COMMIT, 500, () => {
        a.doc.dirty = true;
        writes.markSettled();
      });
      view.functionEditor = buffer as never;
      await flush();

      const answering = confirmCloseAll("Opening another project");
      await flush();
      // The armed commit ran while the tab was still open, so the prompt is about a document that
      // Really does hold the typing — and Save All can therefore honour it.
      expect(a.doc.dirty).toBe(true);
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
      expect(dialog.getAttribute("confirm-label")).toBe("Save All");
      dialog.dispatchEvent(new Event("secondary"));
      expect(await answering).toBe(true);
    });
  });

  test("requestClose on a vanished tab id is a no-op", async () => {
    const a = open("a");
    a.doc.dirty = true;
    await flush();
    const closeBtn = tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement;
    // Remove the tab out from under the strip, then click the stale button.
    workspace.tabs.delete("a");
    closeBtn.click();
    await flush();
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
  });
});

describe("tab strip wheel scrolling", () => {
  test("vertical wheel scrolls the strip horizontally when tabs overflow", async () => {
    open("a");
    open("b");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    const e = wheel(el, { deltaY: 50 });
    expect(el.scrollLeft).toBe(50);
    expect(e.defaultPrevented).toBe(true);
    wheel(el, { deltaY: -30 });
    expect(el.scrollLeft).toBe(20);
  });

  test("the dominant axis wins when both deltas are present", async () => {
    open("a");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    wheel(el, { deltaX: 80, deltaY: 10 });
    expect(el.scrollLeft).toBe(80);
  });

  test("wheel is ignored when the strip does not overflow", async () => {
    open("a");
    await flush();
    const el = strip();
    stubMetrics(el, 100, 100);
    el.scrollLeft = 0;
    const e = wheel(el, { deltaY: 50 });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  test("ctrl+wheel (zoom gesture) is left alone", async () => {
    open("a");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    const e = wheel(el, { ctrlKey: true, deltaY: 50 });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  test("a wheel event with no delta does nothing", async () => {
    open("a");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    const e = wheel(el);
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("active tab reveal", () => {
  test("activating a different tab scrolls it into view", async () => {
    open("a");
    open("b");
    await flush();
    const revealed: Element[] = [];
    const spy = spyOn(Element.prototype, "scrollIntoView").mockImplementation(
      function captureReveal(this: Element) {
        revealed.push(this);
      },
    );
    tabs()[0]!.click();
    await flush();
    expect(revealed.length).toBe(1);
    expect(revealed[0]!.classList.contains("active")).toBe(true);
    expect(revealed[0]!.querySelector(".tab-strip-label")!.textContent).toBe("a.json");
    spy.mockRestore();
  });

  test("a re-render without an activation change does not re-reveal", async () => {
    const a = open("a");
    await flush();
    const spy = spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    a.doc.dirty = true;
    await flush();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("pin, reorder and preview", () => {
  test("the pin button moves a tab to the head and marks the chip", async () => {
    open("a");
    open("b");
    await flush();
    tabs()[1]!
      .querySelector(".tab-strip-pin")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    const els = tabs();
    expect(els[0]!.querySelector(".tab-strip-label")!.textContent).toBe("b.json");
    expect(els[0]!.classList.contains("pinned")).toBe(true);
    expect(els[0]!.querySelector(".tab-strip-pin")!.getAttribute("title")).toBe("Unpin");
  });

  test("clicking the pin does not also activate the tab", async () => {
    open("a");
    open("b");
    await flush();
    expect(workspace.activeTabId).toBe("b");
    tabs()[0]!
      .querySelector(".tab-strip-pin")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(workspace.activeTabId).toBe("b");
  });

  test("a preview chip renders italic-classed and double-clicking commits to it", async () => {
    openTab({
      document: { children: [], tagName: "div" } as JxMutableNode,
      documentPath: "/project/p.json",
      id: "p",
      preview: true,
    });
    await flush();
    expect(tabs()[0]!.classList.contains("preview")).toBe(true);
    expect(tabs()[0]!.getAttribute("title")).toContain("Preview — double-click to keep open");
    tabs()[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flush();
    expect(tabs()[0]!.classList.contains("preview")).toBe(false);
  });

  test("an edit promotes a preview tab without a click", async () => {
    const p = openTab({
      document: { children: [], tagName: "div" } as JxMutableNode,
      documentPath: "/project/p.json",
      id: "p",
      preview: true,
    });
    await flush();
    p.doc.dirty = true;
    await flush();
    expect(workspace.tabs.get("p")!.preview).toBe(false);
  });

  test("dragging a chip onto another reorders the pane", async () => {
    open("a");
    open("b");
    open("c");
    await flush();
    const [first, , third] = tabs();
    first!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    await flush();
    expect(tabs()[0]!.classList.contains("dragging")).toBe(true);
    third!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(tabs().map((el) => el.querySelector(".tab-strip-label")!.textContent)).toEqual([
      "b.json",
      "c.json",
      "a.json",
    ]);
  });

  test("a drop with no drag in flight changes nothing, and dragend clears the ghost", async () => {
    open("a");
    open("b");
    await flush();
    tabs()[0]!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(tabs().map((el) => el.querySelector(".tab-strip-label")!.textContent)).toEqual([
      "a.json",
      "b.json",
    ]);
    tabs()[0]!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    tabs()[0]!.dispatchEvent(new Event("dragend", { bubbles: true }));
    await flush();
    expect(host.querySelector(".tab-strip-tab.dragging")).toBeNull();
  });
});

describe("per-pane strips", () => {
  test("the strip renders only its own pane's tabs, and the focused pane is marked", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="tab-strip-2" data-jx-region="pane.secondary/tabs"></div>',
    );
    open("a");
    open("b", "/project/b.json");
    await flush();
    splitRight();
    await flush();

    const second = document.querySelector("#tab-strip-2") as HTMLElement;
    expect([...host.querySelectorAll(".tab-strip-label")].map((e) => e.textContent)).toEqual([
      "a.json",
    ]);
    expect([...second.querySelectorAll(".tab-strip-label")].map((e) => e.textContent)).toEqual([
      "b.json",
    ]);
    expect(second.querySelector(".tab-strip-row")!.classList.contains("focused")).toBe(true);
    expect(host.querySelector(".tab-strip-row")!.classList.contains("focused")).toBe(false);

    // Collapsing the pane blanks the host it left behind.
    closePane("secondary");
    await flush();
    expect(second.querySelector(".tab-strip-tab")).toBeNull();
    expect([...host.querySelectorAll(".tab-strip-label")].map((e) => e.textContent)).toEqual([
      "a.json",
      "b.json",
    ]);
  });

  /*
   * The shell has ONE strip host, exactly as it has one `#canvas-wrap`, and the stage is handed to
   * the focused pane. A strip that does not make the same handover prints a document that is not on
   * screen — which is what `⌘\` did: the tab moved into the side pane, the stage drew it, and the
   * strip went on rendering the PRIMARY pane's tabs with the primary's chip marked active.
   */
  test("with one host, the strip shows the pane that has the stage", async () => {
    open("a");
    open("b", "/project/b.json");
    await flush();
    splitRight();
    await flush();

    const labels = () => [...host.querySelectorAll(".tab-strip-label")].map((e) => e.textContent);
    expect(labels()).toEqual(["b.json"]);
    expect(host.querySelector(".tab-strip-row")!.classList.contains("focused")).toBe(true);
    expect(host.querySelector(".tab-strip-tab.active")!.textContent).toContain("b.json");

    // Focus back, and the one strip follows it back.
    focusPane("primary");
    await flush();
    expect(labels()).toEqual(["a.json"]);

    // Unsplit hands both documents to the pane that is left, and the strip prints both.
    closePane("secondary");
    await flush();
    expect(labels()).toEqual(["a.json", "b.json"]);
  });

  test("mousedown inside a strip focuses its pane", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="tab-strip-2" data-jx-region="pane.secondary/tabs"></div>',
    );
    open("a");
    open("b", "/project/b.json");
    await flush();
    splitRight();
    await flush();
    host
      .querySelector(".tab-strip-row")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(workspace.activePaneId).toBe("primary");
  });
});

// ─── Context menu ─────────────────────────────────────────────────────────────

/**
 * `context/tab` is a DECLARED placement, and six records declare it. Until the strip rendered it,
 * right-click — the gesture the placement exists to describe — reached none of them: `Set Draft`,
 * `Reopen Closed Document`, `Pin / Unpin Document`, `Keep Document Open`, `Split Right` and `Close
 * Document` all shipped with a menu entry no surface drew. Every case below goes through the real
 * records, so a record that loses its placement fails here rather than shipping unreachable.
 */
describe("tab context menu", () => {
  /** What the chip's own `closeDocument` dep did, and to which tab. */
  let closed: string[];
  /** Paths `document.reopenClosed` asked to open. */
  let reopened: string[];

  function menuItems(): HTMLElement[] {
    return [...document.querySelectorAll("#layer-popover sp-menu-item")] as HTMLElement[];
  }

  /** A row's label without the `Needs …` sentence a disabled row prints under it. */
  function labelOf(el: Element): string {
    const description = el.querySelector("[slot=description]")?.textContent ?? "";
    return (el.textContent ?? "").replace(description, "").trim();
  }

  function labels(): string[] {
    return menuItems().map((el) => labelOf(el));
  }

  function rowFor(label: string): HTMLElement {
    return menuItems().find((el) => labelOf(el) === label)!;
  }

  function rightClick(el: HTMLElement, init: MouseEventInit = {}) {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init }));
  }

  /**
   * The app's real `context/tab` records, in one registry.
   *
   * `closeDocument` is the one dep with a body: it does what `editor/shortcuts.ts` does — close
   * whatever is active when the command runs — so a test can tell WHICH tab the menu addressed.
   */
  function publishRegistry() {
    const registry = createCommandRegistry({
      getContext: () => makeContext({ document: { open: workspace.activeTabId !== null } }),
    });
    registry.registerAll([
      ...defaultCommands({
        ...noopCommandDeps(),
        closeDocument: () => {
          const id = workspace.activeTabId!;
          closed.push(id);
          closeTab(id);
        },
      }),
      ...tabCommands({
        openFile: (path: string) => {
          reopened.push(path);
        },
        openFileInPane: () => {},
      }),
      ...paneCommands({ openFile: () => {}, openFileInPane: () => {} }),
      ...contentCommands(),
    ]);
    setActiveRegistry(registry);
    return registry;
  }

  /** A project whose `posts` collection is JSON-backed, so `posts/*.json` is a content entry. */
  function siteWithPosts() {
    resetStudioState({
      projectConfig: {
        content: {
          posts: {
            format: "json",
            schema: { properties: { draft: { type: "boolean" }, title: { type: "string" } } },
            source: "./posts/",
          },
        },
        name: "Demo",
      },
    });
  }

  beforeEach(() => {
    closed = [];
    reopened = [];
    // `closeAllTabs()` feeds the reopen stack, and it runs between every case in this file — so
    // Without this, `document.reopenClosed`'s enablement is decided by the PREVIOUS test.
    workspace.closedTabs = [];
    siteWithPosts();
  });

  afterEach(() => {
    setActiveRegistry(null);
    resetStudioState();
  });

  test("every declared context/tab record is reachable by right-click, in the records' own order", async () => {
    open("posts/first.json", "posts/first.json");
    publishRegistry();
    await flush();

    rightClick(tabs()[0]!);
    await flush();

    // Sorted by `group` then title, by `forPlacement` — not by this file.
    expect(labels()).toEqual([
      "Close Document",
      "Keep Document Open",
      "Pin / Unpin Document",
      "Reopen Closed Document",
      "Set Draft",
      "Split Right",
    ]);
    // A group change draws a divider: 1_file → 3_document → 5_pane is two of them.
    expect(document.querySelectorAll("#layer-popover sp-menu-divider")).toHaveLength(2);
  });

  test("with no registry published there are no rows — so no menu opens at all", async () => {
    open("a");
    publishRegistry();
    await flush();
    rightClick(tabs()[0]!);
    await flush();
    expect(menuItems().length).toBeGreaterThan(0);

    // The defect this whole surface fixes, in reverse: every row came from the registry, so
    // Without one there is nothing to draw — and an empty popover is a dead control.
    setActiveRegistry(null);
    rightClick(tabs()[0]!);
    await flush();
    expect(document.querySelector("#layer-popover sp-popover")).toBeNull();
  });

  test("right-click activates the chip it was aimed at, so the rows describe THAT tab", async () => {
    const preview = openTab({
      document: { children: [], tagName: "div" } as JxMutableNode,
      documentPath: "/project/preview.json",
      id: "preview",
      preview: true,
    });
    open("other");
    publishRegistry();
    await flush();
    expect(workspace.activeTabId).toBe("other");

    rightClick(tabs()[0]!);
    await flush();

    // Every one of these records reads the ACTIVE document. Without activation the menu would
    // State `other`'s enablement — "Keep Document Open" greyed out over a preview tab.
    expect(workspace.activeTabId).toBe("preview");
    expect(rowFor("Keep Document Open").hasAttribute("disabled")).toBeFalse();
    expect(preview.preview).toBeTrue();
  });

  test("a row runs its command against the right-clicked tab", async () => {
    open("a");
    open("b", "/project/b.json");
    publishRegistry();
    await flush();

    rightClick(tabs()[0]!);
    await flush();
    rowFor("Pin / Unpin Document").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(workspace.tabs.get("a")!.pinned).toBeTrue();
    expect(workspace.tabs.get("b")!.pinned).toBeFalse();
    // Running a row dismisses the menu.
    expect(document.querySelector("#layer-popover sp-popover")).toBeNull();
  });

  test("Close Document closes the tab the menu was opened on, not the one that was active", async () => {
    open("a");
    open("b", "/project/b.json");
    publishRegistry();
    await flush();

    rightClick(tabs()[0]!);
    await flush();
    rowFor("Close Document").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(closed).toEqual(["a"]);
    expect([...workspace.tabs.keys()]).toEqual(["b"]);
  });

  test("Set Draft is offered only on a content entry, shows the state it is in, and lands on the other", async () => {
    const entry = open("posts/first.json", "posts/first.json");
    publishRegistry();
    await flush();

    rightClick(tabs()[0]!);
    await flush();
    const row = rowFor("Set Draft");
    // A setter names the state it REACHES, so the row says where the tab is now and the click
    // Takes it to the other one. Stated in the description rather than as a checkbox role:
    // Spectrum's `Menu` reassigns every item's role one frame after connect when the menu declares
    // No `selects`, so `menuitemcheckbox` does not survive in a real browser — and this test could
    // Not see that, because happy-dom never runs the reassignment.
    expect(row.querySelector('[slot="description"]')?.textContent).toBe("Draft: no");

    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect((entry.doc.document as unknown as Record<string, unknown>).draft).toBeTrue();

    rightClick(tabs()[0]!);
    await flush();
    // Re-opened, the row states the value the click produced — and now offers the way back.
    expect(rowFor("Set Draft").querySelector('[slot="description"]')?.textContent).toBe(
      "Draft: yes",
    );
  });

  test("a tab that is no collection's entry states no `draft`, so the row is absent, not refusing", async () => {
    open("styles/site.css", "styles/site.css");
    publishRegistry();
    await flush();

    rightClick(tabs()[0]!);
    await flush();
    expect(labels()).not.toContain("Set Draft");
    // The rows that need nothing of the tab are still there.
    expect(labels()).toContain("Close Document");
    // A no-arg row names no state, so it says nothing under its label — the description slot is
    // Reserved for a `requires` sentence or a stated value, and an empty one would be noise.
    expect(rowFor("Pin / Unpin Document").querySelector('[slot="description"]')).toBeNull();
  });

  test("a disabled row prints the record's own sentence and survives being clicked", async () => {
    open("a");
    publishRegistry();
    await flush();

    rightClick(tabs()[0]!);
    await flush();
    // Nothing has been closed in this session, so `document.reopenClosed` is visible-but-disabled.
    const row = rowFor("Reopen Closed Document");
    expect(row.hasAttribute("disabled")).toBeTrue();
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Needs a document closed in this session");

    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(reopened).toEqual([]);
    // A row that explains itself has to stay on screen long enough to be read.
    expect(document.querySelector("#layer-popover sp-popover")).not.toBeNull();
  });

  test("Reopen Closed Document is enabled once a document has been closed, and opens it", async () => {
    open("a", "/project/a.json");
    open("b", "/project/b.json");
    publishRegistry();
    await flush();
    closeTab("a");
    await flush();

    rightClick(tabs()[0]!);
    await flush();
    rowFor("Reopen Closed Document").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(reopened).toEqual(["/project/a.json"]);
  });

  test("the menu is clamped to the viewport, and a second right-click replaces the first", async () => {
    open("a");
    open("b", "/project/b.json");
    publishRegistry();
    await flush();

    rightClick(tabs()[0]!, { clientX: 2000, clientY: 2000 });
    await flush();
    const popover = document.querySelector("#layer-popover sp-popover") as HTMLElement;
    expect(popover.style.left).toBe(`${window.innerWidth - 4}px`);
    expect(popover.style.top).toBe(`${window.innerHeight - 4}px`);

    rightClick(tabs()[1]!);
    await flush();
    expect(document.querySelectorAll("#layer-popover sp-popover")).toHaveLength(1);
  });

  test("the overflow menu and the context menu never share the screen", async () => {
    open("a");
    open("b", "/project/b.json");
    publishRegistry();
    await flush();
    stubMetrics(strip(), 400, 100);
    // Re-render so the chevron is measured in.
    workspace.tabs.get("a")!.doc.dirty = true;
    await flush();
    (host.querySelector(".tab-strip-overflow") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();
    expect(document.querySelectorAll("#layer-popover sp-popover")).toHaveLength(1);

    rightClick(tabs()[0]!);
    await flush();
    expect(document.querySelectorAll("#layer-popover sp-popover")).toHaveLength(1);
    expect(labels()).toContain("Close Document");
  });

  test("unmounting the strip takes its menu with it", async () => {
    open("a");
    publishRegistry();
    await flush();
    rightClick(tabs()[0]!);
    await flush();
    expect(document.querySelector("#layer-popover sp-popover")).not.toBeNull();

    unmount();
    expect(document.querySelector("#layer-popover sp-popover")).toBeNull();
    mount(host);
  });
});
