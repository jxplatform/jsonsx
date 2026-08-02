/**
 * Manifest schema for the declarative studio screenshot runner.
 *
 * A manifest is a list of shots. Each shot opens a project/file in Studio (via the deep-link params
 * studio.ts already supports), drives UI state through the gated `window.__jxAutomation` hook
 * (packages/studio/src/services/automation.ts), waits for deterministic readiness signals, and
 * captures a clipped PNG.
 */

export interface Viewport {
  height: number;
  width: number;
}

export type WaitCondition =
  | { type: "canvasReady"; timeoutMs?: number }
  | { type: "fonts" }
  | { frames: number; type: "settle" }
  | { selector: string; timeoutMs?: number; type: "selector" }
  | { ms: number; type: "timeout" };

/** A canned chat message for the `seedAssistant` action (ai-panel seedAssistantMessages). */
export interface SeededChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Rendered as tool chips on assistant messages; `arguments` is a JSON string. */
  toolCalls?: { name: string; arguments: string }[];
}

/** A canned Pages deployment for the `seedPublish` action (publish-panel seedPublishConnected). */
export interface SeededDeployment {
  id: string;
  url: string;
  environment: string;
  stage: string;
  status: string;
  createdOn: string;
}

/** A canned collab peer for the `seedCollab` action (collabState on the active tab). */
export interface SeededPeer {
  clientId: number;
  state: {
    user: { login: string; name?: string; color: string; avatarUrl?: string };
    /** Defaults to the active tab's documentPath inside the seedCollab verb. */
    focusedPath?: string | null;
    structuralSelection?: (string | number)[] | null;
    mode?: "structure" | "source";
  };
}

export type ShotAction =
  /**
   * Command-addressed step: names a Studio command id (`<category>.<verb>`) rather than a CSS
   * selector, and lets `window.__jxAutomation.run` decide how to fire it. This is how a shot should
   * drive the shell — chrome refactors move selectors, not command ids. Unknown ids throw inside
   * the page, so a stale step fails the shot instead of silently capturing the wrong state.
   */
  | { args?: Record<string, unknown>; do: "run"; id: string }
  | { defName: string; do: "editDef" }
  | { do: "editFunction"; eventKey: string; path: (string | number)[] }
  | { do: "openBrowse" }
  | { connection?: string; do: "openDataGrid"; table: string }
  | { do: "openNewProject" }
  | { do: "openQuickSearch" }
  | { do: "openSettings"; section?: string }
  | { do: "seedAssistant"; messages: SeededChatMessage[] }
  | { do: "seedCollab"; peers: SeededPeer[] }
  | { deployment: SeededDeployment; do: "seedPublish" }
  | { do: "showWelcome"; projects?: { name: string; root: string; description?: string }[] }
  | { do: "select"; path: (string | number)[] | null }
  | { do: "setActivity"; value: string }
  | { do: "setCanvasMode"; value: string }
  | { do: "setRightTab"; value: string }
  | { do: "setStatus"; value: string }
  | { do: "setTheme"; value: string }
  | { do: "setZoom"; value: number }
  // Generic DOM interactions (main frame). Selectors may use puppeteer handlers
  // Like `pierce/` to reach into Spectrum shadow DOM.
  | { button?: "left" | "right"; do: "click"; selector: string }
  // Synthetic dragover on a main-frame element (e.g. the browse drop zone's highlight state).
  | { do: "dispatchDragOver"; selector: string }
  | { do: "hover"; selector: string }
  | { do: "type"; selector: string; text: string }
  // Canvas-iframe interactions — real clicks/keys inside the preview document,
  // The faithful way to start inline editing or open the slash menu.
  | { button?: "left" | "right"; clickCount?: number; do: "canvasClick"; selector: string }
  | { do: "canvasType"; text: string }
  | { do: "canvasKey"; key: string }
  | { do: "wait"; ms: number };

export type ClipSpec =
  | "fullPage"
  | "none"
  | { selector: string }
  | {
      height: number;
      width: number;
      x: number;
      y: number;
    };

/**
 * A cropped sub-capture of the same shot. One shot boots Studio once, drives its state, then emits
 * each region as its own PNG (`<region.name>.png`) — ideal for tight crops of individual control
 * surfaces (a panel, an inspector section, a toolbar) to embed in docs.
 */
export interface ShotRegion {
  /** Output basename (without .png); must be unique across the whole manifest, like a shot name. */
  name: string;
  /** CSS selector, resolved in the main frame (Studio panels are light DOM). */
  selector: string;
  /** CSS px of breathing room added on every side before clipping (default 0). */
  padding?: number;
}

export interface ShotVariant {
  actions?: ShotAction[];
  suffix: string;
  theme?: string;
  /**
   * Overrides the shot's waitFor for this variant. A cleanup variant (actions that revert the
   * staged document state after the primary capture, under a region-only shot's `clip: "none"`)
   * needs this — the shot's own waitFor typically asserts UI the cleanup just dismissed.
   */
  waitFor?: WaitCondition[];
}

export interface ShotDefaults {
  clip?: ClipSpec;
  deviceScaleFactor?: number;
  project?: string;
  theme?: string;
  viewport?: Viewport;
  waitFor?: WaitCondition[];
}

export interface Shot extends ShotDefaults {
  actions?: ShotAction[];
  canvasMode?: string;
  /**
   * Boot Studio without a project/file deep link (the welcome screen). Skips the Canvas-readiness
   * baseline — there is no canvas without a project.
   */
  noProject?: boolean;
  /** Skip the canvas-readiness baseline for files that never render a canvas (CSV grids). */
  noCanvas?: boolean;
  /**
   * Docs-page slugs this shot illustrates (e.g. "studio/design"). Inert to capture;
   * Scripts/docs/check-doc-refs.ts uses it to report shots no docs page references.
   */
  docs?: string[];
  /** Project-relative file to open. Required unless `noProject` is set. */
  file?: string;
  name: string;
  regions?: ShotRegion[];
  variants?: ShotVariant[];
}

export interface Manifest {
  defaults: ShotDefaults;
  outDir: string;
  server: { studioPath: string; url: string };
  shots: Shot[];
}

/** A shot with all defaults folded in. */
export interface ResolvedShot extends Shot {
  clip: ClipSpec;
  deviceScaleFactor: number;
  project: string;
  theme: string;
  viewport: Viewport;
  waitFor: WaitCondition[];
}

const ACTION_KINDS = new Set([
  "canvasClick",
  "canvasKey",
  "canvasType",
  "click",
  "dispatchDragOver",
  "editDef",
  "editFunction",
  "hover",
  "openBrowse",
  "openDataGrid",
  "openNewProject",
  "openQuickSearch",
  "openSettings",
  "run",
  "seedAssistant",
  "seedCollab",
  "seedPublish",
  "select",
  "setActivity",
  "setCanvasMode",
  "setRightTab",
  "setStatus",
  "setTheme",
  "setZoom",
  "showWelcome",
  "type",
  "wait",
]);

const WAIT_KINDS = new Set(["canvasReady", "fonts", "selector", "settle", "timeout"]);

function fail(message: string): never {
  throw new Error(`manifest: ${message}`);
}

export function validateManifest(raw: unknown): Manifest {
  if (typeof raw !== "object" || raw === null) {
    fail("root must be an object");
  }
  const m = raw as Partial<Manifest>;
  if (typeof m.outDir !== "string" || !m.outDir) {
    fail("outDir must be a non-empty string");
  }
  if (typeof m.server?.url !== "string" || typeof m.server?.studioPath !== "string") {
    fail("server.url and server.studioPath are required");
  }
  if (!Array.isArray(m.shots) || m.shots.length === 0) {
    fail("shots must be a non-empty array");
  }
  // Two namespaces: shot names (for --only targeting) and output basenames (the PNGs actually
  // Written). A shot with `clip: "none"` writes no `<shot.name>.png`, so a region may reuse the
  // Shot's name for the primary crop (e.g. a git-panel shot whose git-panel.png comes from a region).
  const shotNames = new Set<string>();
  const outputNames = new Set<string>();
  const claimOutput = (name: string, where: string) => {
    if (outputNames.has(name)) {
      fail(`duplicate output name "${name}" (${where})`);
    }
    outputNames.add(name);
  };
  for (const shot of m.shots) {
    if (typeof shot.name !== "string" || !shot.name) {
      fail("every shot needs a name");
    }
    if (shotNames.has(shot.name)) {
      fail(`duplicate shot name "${shot.name}"`);
    }
    shotNames.add(shot.name);
    if (!shot.noProject && (typeof shot.file !== "string" || !shot.file)) {
      fail(`shot "${shot.name}": file is required (or set noProject for the welcome screen)`);
    }
    for (const action of shot.actions ?? []) {
      if (!ACTION_KINDS.has(action.do)) {
        fail(`shot "${shot.name}": unknown action "${action.do}"`);
      }
      if (action.do === "run" && (typeof action.id !== "string" || !action.id)) {
        fail(`shot "${shot.name}": a run action needs a command id`);
      }
    }
    for (const wait of shot.waitFor ?? []) {
      if (!WAIT_KINDS.has(wait.type)) {
        fail(`shot "${shot.name}": unknown wait "${wait.type}"`);
      }
    }
    const effectiveClip = shot.clip ?? m.defaults?.clip;
    if (effectiveClip !== "none") {
      claimOutput(shot.name, `shot "${shot.name}"`);
    }
    for (const region of shot.regions ?? []) {
      if (typeof region.name !== "string" || !region.name) {
        fail(`shot "${shot.name}": every region needs a name`);
      }
      if (typeof region.selector !== "string" || !region.selector) {
        fail(`shot "${shot.name}": region "${region.name}" needs a selector`);
      }
      claimOutput(region.name, `region in shot "${shot.name}"`);
    }
  }
  return m as Manifest;
}

export function resolveShot(manifest: Manifest, shot: Shot): ResolvedShot {
  const d = manifest.defaults;
  return {
    clip: shot.clip ?? d.clip ?? { selector: "#app" },
    deviceScaleFactor: shot.deviceScaleFactor ?? d.deviceScaleFactor ?? 2,
    project: shot.project ?? d.project ?? "examples",
    theme: shot.theme ?? d.theme ?? "dark",
    viewport: shot.viewport ?? d.viewport ?? { height: 1000, width: 1600 },
    waitFor: shot.waitFor ??
      d.waitFor ?? [{ type: "canvasReady" }, { type: "fonts" }, { frames: 2, type: "settle" }],
    ...shot,
  } as ResolvedShot;
}
