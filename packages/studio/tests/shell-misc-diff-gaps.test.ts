/**
 * Shell-misc diff gaps — one refusal apiece, in six modules the named-shell change touched.
 *
 * Every case here is a guard: the branch that says "not this one". They are the branches nothing
 * else in the suite reaches, because reaching a refusal takes a caller that asks for the thing the
 * guard exists to withhold — a scope stack for a pane no engine owns, a session for a project that
 * is not open, a second read of a collection already being read, a re-join for a tab that never
 * left. Each test therefore asserts what did NOT happen, and pairs it with the neighbouring call
 * that DOES happen, so "nothing" is the guard talking rather than a dead fixture.
 */
import {
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  mountOverlayLayers,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { html, nothing, render } from "lit-html";
import { notifyModule } from "./notify-mock";
import { createMockCollabHub, settleCollab, waitForCollab } from "./collab-mock";
import { mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import { keyScopeStack, makeContext } from "../src/commands/context";
import { persistedSession } from "../src/shell";
import { renderForm } from "../src/ui/schema-form";
import { invalidateReferenceEntries } from "../src/ui/form-controls";
import { seedPublishConnected } from "../src/publish/publish-panel";
import { initLayers } from "../src/ui/layers";
import {
  PROJECT_CONFIG_PATH,
  projectConfigDocument,
  resetProjectConfigDocument,
} from "../src/tabs/project-config";
import { projectState } from "../src/store";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { resetCollabForTests, setCollabEnabled } from "../src/collab/collab-session";
import { collabState } from "../src/collab/collab-state";
import type { MockPlatformState } from "./harness";
import type { EditorKind } from "../src/commands/context";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { StudioPlatform } from "../src/types";

mountOverlayLayers(document.body);
initLayers();

// ─── commands/context.ts — the pane no engine owns ───────────────────────────

describe("keyScopeStack — surfaces that are not an editing engine", () => {
  test("every non-engine editor kind gets the bare global stack, and the engines do not", () => {
    const bare: EditorKind[] = ["none", "config", "diff", "entry", "library"];
    for (const kind of bare) {
      expect(keyScopeStack(makeContext({ editor: { kind } })), kind).toEqual(["global"]);
    }
    // The switch's other arms, so "global" is a decision this branch makes rather than the only
    // Answer the function can give.
    expect(keyScopeStack(makeContext({ editor: { kind: "grid" } }))).toEqual(["grid", "global"]);
    expect(keyScopeStack(makeContext({ editor: { kind: "code" } }))).toEqual(["code", "global"]);
    expect(keyScopeStack(makeContext({ editor: { kind: "canvas" } }))).toEqual([
      "canvas",
      "global",
    ]);
  });
});

// ─── shell.ts — a session for a project that is not open ─────────────────────

const SESSION = {
  focusedPane: "primary",
  panes: [{ activeFile: "pages/index.json", files: ["pages/index.json"], id: "primary" }],
  ui: {},
};

describe("persistedSession — no project root", () => {
  afterEach(() => {
    localStorage.clear();
  });

  test('a null root reads nothing, not the record stored under the key "…::null"', () => {
    // The key `${PREFIX}${root}` interpolates a null root as the four characters "null", so a
    // Reader without the guard would restore whatever a project literally named that had left.
    localStorage.setItem("jx-studio-project::null", JSON.stringify({ session: SESSION }));
    localStorage.setItem("jx-studio-project::/tmp/site", JSON.stringify({ session: SESSION }));

    expect(persistedSession(null)).toBeNull();
    // The same bytes under a real root ARE a session the reader accepts, so the null answer above
    // Is the guard rather than a session shape `readSession` would have rejected anyway.
    expect(persistedSession("/tmp/site")?.panes[0]?.files).toEqual(["pages/index.json"]);
  });
});

// ─── ui/form-controls.ts — one read per collection ───────────────────────────

const AUTHOR_CONFIG = {
  content: {
    authors: { format: "Markdown", schema: {}, source: "./content/authors/" },
  },
};

function mountReference(container: HTMLElement): void {
  const redraw = () => {
    render(
      html`${renderForm(
        { properties: { author: { $ref: "#/content/authors" } } },
        { author: "" },
        {
          onChange: () => {
            /* Not committed here */
          },
          rerender: () => redraw(),
        },
      )}`,
      container,
    );
  };
  redraw();
}

function optionsIn(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll("sp-menu-item")].map((item) => item.textContent);
}

function directoryReads(state: MockPlatformState): unknown[] {
  return state.calls.filter((call) => call[0] === "listDirectory").map((call) => call[1]);
}

/**
 * Poll until `cond()` holds. The control reaches its collection reader through a DYNAMIC import, so
 * the first paint waits on a real module load rather than on a fixed number of microtasks.
 */
async function waitFor(cond: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries && !cond(); i += 1) {
    await flush(1);
  }
}

describe("the reference control reads a collection once", () => {
  test("a second field drawn while the first read is still in flight starts no second read", async () => {
    const { state } = installMockPlatform(
      { formatAction: mockFormatAction } as unknown as Partial<StudioPlatform>,
      {
        "content/authors/ada.md": "---\ntitle: Ada\n---\n",
        "content/authors/grace.md": "---\ntitle: Grace\n---\n",
      },
    );
    seedMarkdownFormat();
    resetStudioState({ projectConfig: AUTHOR_CONFIG });
    invalidateReferenceEntries();

    // Both mounts happen in the same tick: the cache holds an UNSETTLED promise, which is the only
    // Moment the in-flight branch is reachable (a settled collection renders straight from
    // `entryIdResult` and never asks again).
    const first = document.createElement("div");
    const second = document.createElement("div");
    mountReference(first);
    mountReference(second);
    await waitFor(() => optionsIn(first).length > 0);

    expect(directoryReads(state)).toEqual(["content/authors"]);
    expect(optionsIn(first)).toEqual(["—", "ada", "grace"]);
    expect(optionsIn(second)).toEqual(["—", "ada", "grace"]);
  });
});

// ─── publish/publish-panel.ts — Refresh re-asks Cloudflare ───────────────────

function publishBodyText(): string {
  return (
    document.querySelector("#layer-modal .publish-modal")?.textContent?.replaceAll(/\s+/g, " ") ??
    ""
  );
}

function publishButton(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("#layer-modal sp-button")].find((button) =>
      button.textContent?.includes(label),
    ) ?? null
  );
}

describe("the publish panel's Refresh button", () => {
  test("re-reads the connection and repaints when Cloudflare no longer knows us", async () => {
    resetStudioState({
      projectConfig: {
        build: {
          adapter: "cloudflare-pages",
          deploy: {
            accountId: "a".repeat(32),
            projectName: "my-site",
            provider: "cloudflare-pages",
          },
        },
        name: "My Site",
      },
    });
    // The credential was revoked since the panel was seeded: the refresh must find that out.
    const cfConnection = mock(() => Promise.resolve(null));
    installMockPlatform({ cfApi: mock(async () => ({})), cfConnection } as never);

    seedPublishConnected({
      deployment: {
        createdOn: "2026-07-06T00:00:00Z",
        environment: "production",
        id: "d1",
        stage: "deploy",
        status: "success",
        url: "https://main.my-site.pages.dev",
      },
    });
    await flush();
    // The seam bypasses loadConnection entirely, so nothing has asked Cloudflare yet.
    expect(publishBodyText()).toContain("Connected to Pages project");
    expect(cfConnection).not.toHaveBeenCalled();

    pointer(publishButton("Refresh")!, "click");
    await flush();

    expect(cfConnection).toHaveBeenCalledTimes(1);
    expect(publishBodyText()).not.toContain("Connected to Pages project");
    expect(publishBodyText()).toContain("Cloudflare API token");
  });
});

// ─── tabs/project-config.ts — the unbound document stops syncing ─────────────

describe("the project.json bind effect", () => {
  beforeEach(() => {
    resetProjectConfigDocument();
    closeAllTabs();
    installMockPlatform();
  });

  afterEach(() => {
    resetProjectConfigDocument();
    closeAllTabs();
  });

  test("a document that is no longer the bound one stops writing into projectState", () => {
    const alpha = { name: "Alpha" };
    resetStudioState({ projectConfig: alpha });
    const tab = openTab({
      document: alpha as unknown as Record<string, unknown>,
      documentPath: PROJECT_CONFIG_PATH,
      id: PROJECT_CONFIG_PATH,
    });
    projectConfigDocument();

    /* Unbinding leaves the tab — and therefore its effect scope — alive: the tab belongs to the
       workspace, not to this module. So the effect still fires on the next document swap, and the
       guard is the only thing between a stale binding and a project state pointing at a document
       nobody adopted. */
    resetProjectConfigDocument();
    const stateBefore = projectState!.projectConfig;
    tab.doc.document = { name: "Beta" } as unknown as JxMutableNode;
    expect(projectState!.projectConfig).toBe(stateBefore);
    expect((projectState!.projectConfig as { name?: string } | null)?.name).not.toBe("Beta");

    // Re-bound, the very same swap DOES land — the effect was live all along.
    projectConfigDocument();
    tab.doc.document = { name: "Gamma" } as unknown as JxMutableNode;
    expect((projectState!.projectConfig as unknown as { name: string }).name).toBe("Gamma");
  });
});

// ─── collab/collab-session.ts — joining a session already joined ─────────────

const COLLAB_DOC: JxMutableNode = {
  children: [{ tagName: "p", textContent: "Hello" }],
  tagName: "div",
};
const COLLAB_PATH = "pages/shell-misc.json";

describe("setCollabEnabled is idempotent", () => {
  beforeEach(() => {
    closeAllTabs();
    resetCollabForTests();
  });

  afterEach(() => {
    closeAllTabs();
    resetCollabForTests();
  });

  test("sharing a document that was never opted out installs nothing", async () => {
    // Opened while the platform could not collaborate: `ensureCollab` refused, so no watcher.
    installMockPlatform();
    const tab = openTab({
      document: structuredClone(COLLAB_DOC),
      documentPath: COLLAB_PATH,
      id: COLLAB_PATH,
    });

    // The platform gains the capability afterwards — a room is now reachable for this path.
    const hub = createMockCollabHub();
    installMockPlatform({ collab: hub.capability });

    setCollabEnabled(tab, true);
    await settleCollab();
    // Already enabled, so this said nothing and nothing happened.
    expect(collabState(tab).active).toBe(false);
    expect(hub.connectionCount(COLLAB_PATH)).toBe(0);

    /* A real change of value does reach the room, which is what makes the silence above a refusal
       rather than a platform that cannot connect.

       `waitForCollab`, not `settleCollab`, and the difference is why this test flaked in CI and
       nowhere else: a disable-then-enable flip is the longest attach chain in the suite — a
       teardown and then a connect — and `settleCollab`'s six turns covered it on a developer's
       machine and not on a loaded runner. The claim is about the end state, so the wait is too. */
    setCollabEnabled(tab, false);
    setCollabEnabled(tab, true);
    await waitForCollab(() => collabState(tab).active);
    expect(collabState(tab).active).toBe(true);
    expect(hub.connectionCount(COLLAB_PATH)).toBe(1);

    setCollabEnabled(tab, false);
    await settleCollab();
  });
});

// ─── studio.ts — the save hook takes no target ───────────────────────────────

/**
 * LAST in the file, deliberately. Booting `src/studio.ts` needs a dozen leaf modules mocked, and
 * `mock.module` is process-wide and permanent — every describe above must have run against the real
 * ones first.
 */
describe("the bootstrap's saveDocument hook", () => {
  test("saves the active document, never the argument the registry happened to pass", async () => {
    const noop = () => {
      /* Stub */
    };
    class StubEventSource {
      addEventListener = noop;
      removeEventListener = noop;
      close = noop;
    }
    (globalThis as Record<string, unknown>).EventSource = StubEventSource;
    (globalThis as Record<string, unknown>).requestIdleCallback = (cb: (d: unknown) => void) =>
      setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
    (globalThis as Record<string, unknown>).cancelIdleCallback = (id: number) => {
      clearTimeout(id);
    };
    globalThis.fetch = mock(
      async () => new Response("{}", { status: 404 }),
    ) as unknown as typeof fetch;

    document.body.innerHTML = `
      <div id="app">
        <div id="toolbar"></div>
        <div id="tab-strip"></div>
        <div id="activity-bar"></div>
        <div id="left-panel"></div>
        <div id="resize-left" class="resize-handle"></div>
        <div class="pane-stage" data-jx-region="pane.primary"></div>
        <div id="resize-right" class="resize-handle"></div>
        <div id="right-panel"></div>
        <div id="statusbar"></div>
      </div>
      <div id="layer-popover"></div>
      <div id="layer-modal"></div>
      <div id="layer-dialog"></div>
    `;

    void mock.module("../src/services/monaco-setup.js", () => ({}));
    void mock.module("monaco-editor/editor", () => ({
      KeyCode: {},
      KeyMod: {},
      MarkerSeverity: { Error: 8, Warning: 4 },
      Uri: { parse: (u: string) => ({ toString: () => u }) },
      editor: { setModelMarkers: mock(() => {}) },
      languages: {
        CompletionItemKind: { Function: 1, Property: 9, Variable: 4 },
        registerCompletionItemProvider: mock(() => ({ dispose: noop })),
      },
    }));
    void mock.module("../src/panels/statusbar.ts", () => ({
      forgetSavedTimes: mock(() => {}),
      mountStatusbar: mock(() => {}),
      noteDocumentSaved: mock(() => {}),
      renderStatusbar: mock(() => {}),
      unmountStatusbar: mock(() => {}),
    }));
    void mock.module("../src/services/notify.ts", () => notifyModule(() => {}));
    void mock.module("../src/panels/toolbar.ts", () => ({
      mount: mock(() => {}),
      render: mock(() => {}),
      unmount: mock(() => {}),
    }));
    void mock.module("../src/panels/welcome-screen.ts", () => ({
      initWelcome: mock(() => {}),
      renderWelcome: mock(() => {}),
    }));
    void mock.module("../src/panels/block-action-bar.ts", () => ({
      commandIcon: mock(() => nothing),
      commandTooltip: mock(() => ""),
      dismissBlockActionBar: mock(() => {}),
      dismissLinkPopover: mock(() => {}),
      initBlockActionBar: mock(() => {}),
      formatCommands: mock(() => []),
      isEditChromeTarget: mock(() => false),
      registerSelectionCommands: mock(() => {}),
      releaseBlockActionBar: mock(() => {}),
      renderBlockActionBar: mock(() => {}),
      runCommand: mock(() => {}),
      selectionCommandRegistry: () => ({
        disabledReason: () => {},
        forPlacement: () => [],
        keymap: { formatBinding: () => {} },
      }),
      showCommandOverflow: mock(() => {}),
      suppressBlockActionBar: mock(() => {}),
      withCommandTarget: <T>(_path: unknown, fn: () => T) => fn(),
    }));
    void mock.module("../src/canvas/canvas-render.ts", () => ({
      handOverCanvasStage: mock(() => {}),
      initCanvasRender: mock(() => {}),
      registerSelectionSetCommand: mock(() => {}),
      renderCanvas: mock(() => {}),
      renderOverlays: mock(() => {}),
      scheduleCanvasRender: mock(() => {}),
    }));
    void mock.module("../src/canvas/canvas-patcher.ts", () => ({
      applyPatchBatch: mock(() => {}),
      classifyOps: mock(() => ({ patchable: false, reason: "mock" })),
      consumePatchedDocument: mock(() => false),
      escalateToFullRender: mock(() => {}),
      initCanvasPatcher: mock(() => {}),
    }));

    /* The module under assertion. `saveFile` is the only export the hook touches; the other seven
       exist because a `mock.module` replaces the WHOLE module for every importer in the boot
       graph. */
    const saveFileSpy = mock(async (..._args: unknown[]) => true);
    void mock.module("../src/files/file-ops.ts", () => ({
      confirmFileDelete: mock(async () => false),
      exportFile: mock(async () => {}),
      openFile: mock(async () => {}),
      parseFormatSource: mock(async () => ({})),
      parseSourceForPath: mock(async () => ({})),
      renamePromptMessage: mock(async () => ""),
      saveFile: saveFileSpy,
      serializeDocument: mock(async () => ""),
    }));

    let hooks: { saveDocument: (...args: unknown[]) => Promise<unknown> } | null = null;
    void mock.module("../src/editor/shortcuts.ts", () => ({
      initShortcuts: mock(() => {}),
      installStageGestures: () => () => {},
      registerStudioCommands: (_registry: unknown, given: unknown) => {
        hooks = given as { saveDocument: (...args: unknown[]) => Promise<unknown> };
      },
    }));

    installMockPlatform();
    await import("../src/studio");
    await flush();

    const hook = hooks as unknown as {
      saveDocument: (...args: unknown[]) => Promise<unknown>;
    } | null;
    expect(hook).not.toBeNull();

    /* The registry calls its hooks with whatever a command's argument record carried. `saveFile`
       takes an OPTIONAL tab and would treat that as the document to write, so the wrapper's job is
       to arrive empty-handed. */
    const sentinel = { id: "not-a-tab" };
    const answer = await hook!.saveDocument(sentinel, "and-another");

    expect(saveFileSpy).toHaveBeenCalledTimes(1);
    expect(saveFileSpy.mock.calls[0]).toEqual([]);
    // And it does not forward the verdict either — the hook's contract is Promise<void>.
    expect(answer).toBeUndefined();
  });
});
