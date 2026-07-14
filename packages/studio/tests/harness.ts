/**
 * Shared test harness for studio tests.
 *
 * Centralizes the DOM bootstrap, lit rendering, project/tab state resets, an in-memory
 * StudioPlatform mock, and happy-dom gap stubs so individual test files don't reinvent them. Import
 * this instead of ./with-dom.js when you need more than the bare DOM:
 *
 * Import { installMockPlatform, renderInto, resetStudioState } from "./harness";
 *
 * Harness rule: treat this file as read-only while a test-writing wave is in flight — extend it
 * between waves, not concurrently from several branches.
 */
import "./with-dom.js";
import { render } from "lit-html";
import type { TemplateResult } from "lit-html";
import { registerPlatform } from "../src/platform";
import { setProjectState } from "../src/store";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { DirEntry, ProjectState, RenameResult, StudioPlatform } from "../src/types";

// ─── Lit rendering ────────────────────────────────────────────────────────────

/** Render a lit template into a detached container and flush microtasks. */
export async function renderInto(
  template: TemplateResult,
  container: HTMLElement = document.createElement("div"),
): Promise<HTMLElement> {
  render(template, container);
  await flush();
  return container;
}

/**
 * Flush pending microtasks (and one macrotask turn) so lit directives and Spectrum components
 * finish their async updates before assertions run.
 */
export async function flush(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

// ─── State resets ─────────────────────────────────────────────────────────────

/** Reset the global project state to a minimal valid shape, with overrides. */
export function resetStudioState(overrides: Record<string, unknown> = {}): void {
  setProjectState({
    expanded: new Set(),
    projectConfig: null,
    ...overrides,
  } as unknown as ProjectState);
}

/** Close all tabs and open a fresh one so activeTab.value is populated. */
export function resetWorkspaceWithTab(
  doc?: JxMutableNode,
  opts: { id?: string; documentPath?: string } = {},
) {
  closeAllTabs();
  const document = doc ?? {
    children: [{ tagName: "p", textContent: "Hello" }],
    tagName: "div",
  };
  return openTab({
    document,
    documentPath: opts.documentPath ?? "/project/index.json",
    id: opts.id ?? "test-tab",
  });
}

// ─── Platform mock ────────────────────────────────────────────────────────────

export interface MockPlatformState {
  /** In-memory filesystem: absolute path → file contents. */
  files: Map<string, string>;
  /** Ordered log of platform calls for assertions: [method, ...args]. */
  calls: unknown[][];
}

function dirEntriesFor(files: Map<string, string>, dir: string): DirEntry[] {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const seen = new Map<string, DirEntry>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const rest = path.slice(prefix.length);
    const [head] = rest.split("/");
    if (!head || seen.has(head)) {
      continue;
    }
    seen.set(head, {
      name: head,
      path: prefix + head,
      type: rest.includes("/") ? "directory" : "file",
    } satisfies DirEntry);
  }
  return [...seen.values()];
}

/**
 * Build and register an in-memory StudioPlatform. Every method is overridable; unset git/ai methods
 * resolve with inert defaults. Returns the platform plus its backing state for direct manipulation
 * and call assertions.
 */
export function installMockPlatform(
  overrides: Partial<StudioPlatform> = {},
  seedFiles: Record<string, string> = {},
): { platform: StudioPlatform; state: MockPlatformState } {
  const state: MockPlatformState = {
    calls: [],
    files: new Map(Object.entries(seedFiles)),
  };
  const log =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      state.calls.push([name, ...args]);
      return fn(...args);
    };

  const platform: StudioPlatform = {
    activate: log("activate", async () => {}),
    addPackage: log("addPackage", async () => ({})),
    aiChatUrl: log("aiChatUrl", () => "/__mock/ai/chat"),
    codeService: log("codeService", async () => null),
    createDirectory: log("createDirectory", async () => {}),
    createProject: log("createProject", async (opts) => ({
      config: { name: opts.name },
      root: `${opts.directory}/${opts.name}`,
    })),
    deleteFile: log("deleteFile", async (path) => {
      state.files.delete(path);
    }),
    discoverComponents: log("discoverComponents", async () => []),
    fetchPluginSchema: log("fetchPluginSchema", async () => null),
    gitAddRemote: log("gitAddRemote", async () => {}),
    gitBranches: log("gitBranches", async () => ({ branches: [], current: "main" }) as never),
    gitCheckout: log("gitCheckout", async () => {}),
    gitCommit: log("gitCommit", async () => {}),
    gitCreateBranch: log("gitCreateBranch", async () => {}),
    gitDiff: log("gitDiff", async () => ""),
    gitDiscard: log("gitDiscard", async () => {}),
    gitFetch: log("gitFetch", async () => {}),
    gitInit: log("gitInit", async () => {}),
    gitLog: log("gitLog", async () => []),
    gitPull: log("gitPull", async () => {}),
    gitPush: log("gitPush", async () => {}),
    gitShow: log("gitShow", async () => ""),
    gitStage: log("gitStage", async () => {}),
    gitStatus: log("gitStatus", async () => ({ files: [] }) as never),
    gitUnstage: log("gitUnstage", async () => {}),
    id: "mock",
    listDirectory: log("listDirectory", async (dir) => dirEntriesFor(state.files, dir)),
    listPackages: log("listPackages", async () => []),
    locateFile: log("locateFile", async (name) => {
      for (const path of state.files.keys()) {
        if (path.endsWith(`/${name}`) || path === name) {
          return path;
        }
      }
      return null;
    }),
    openProject: log("openProject", async () => null),
    probeRootProject: log("probeRootProject", async () => null),
    projectRoot: "/project",
    readFile: log("readFile", async (path) => {
      const content = state.files.get(path);
      if (content === undefined) {
        throw new Error(`mock platform: no such file: ${path}`);
      }
      return content;
    }),
    removePackage: log("removePackage", async () => ({})),
    renameFile: log("renameFile", async (from, to): Promise<RenameResult> => {
      const content = state.files.get(from);
      if (content !== undefined) {
        state.files.delete(from);
        state.files.set(to, content);
      }
      return { from, ok: true, to };
    }),
    resolveSiteContext: log("resolveSiteContext", async () => ({ sitePath: null })),
    searchFiles: log("searchFiles", async (query) =>
      [...state.files.keys()]
        .filter((path) => path.includes(query))
        .map((path) => ({ name: path.split("/").pop()!, path, type: "file" }) satisfies DirEntry),
    ),
    uploadFile: log("uploadFile", async () => ({})),
    writeFile: log("writeFile", async (path, content) => {
      state.files.set(path, content);
    }),
    ...overrides,
  };

  registerPlatform(platform);
  return { platform, state };
}

// ─── Event helpers ────────────────────────────────────────────────────────────

/** Dispatch a bubbling pointer/mouse event of the given type. */
export function pointer(el: Element, type: string, opts: MouseEventInit = {}): void {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...opts }),
  );
}

/** Dispatch a bubbling keyboard event (keydown by default). */
export function key(
  el: Element,
  keyName: string,
  opts: KeyboardEventInit & { type?: string } = {},
): void {
  const { type = "keydown", ...init } = opts;
  el.dispatchEvent(
    new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: keyName,
      ...init,
    }),
  );
}

/** Dispatch an input + change pair after setting a form control's value. */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ─── happy-dom gap stubs ──────────────────────────────────────────────────────

/**
 * Happy-dom performs no layout, so getBoundingClientRect() returns zeros. Stub a fixed rect on an
 * element for code that branches on geometry.
 */
export function stubRect(el: Element, rect: Partial<DOMRect>): void {
  const full = {
    bottom: (rect.top ?? 0) + (rect.height ?? 0),
    height: 0,
    left: 0,
    right: (rect.left ?? 0) + (rect.width ?? 0),
    toJSON: () => ({}),
    top: 0,
    width: 0,
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    ...rect,
  } as DOMRect;
  (el as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => full;
}
