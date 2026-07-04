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

export type ShotAction =
  | { defName: string; do: "editDef" }
  | { do: "editFunction"; eventKey: string; path: (string | number)[] }
  | { do: "select"; path: (string | number)[] | null }
  | { do: "setActivity"; value: string }
  | { do: "setCanvasMode"; value: string }
  | { do: "setRightTab"; value: string }
  | { do: "setStatus"; value: string }
  | { do: "setTheme"; value: string }
  | { do: "setZoom"; value: number }
  | { do: "click"; selector: string }
  | { do: "wait"; ms: number };

export type ClipSpec =
  | "fullPage"
  | { selector: string }
  | {
      height: number;
      width: number;
      x: number;
      y: number;
    };

export interface ShotVariant {
  actions?: ShotAction[];
  suffix: string;
  theme?: string;
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
  file: string;
  name: string;
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
  "click",
  "editDef",
  "editFunction",
  "select",
  "setActivity",
  "setCanvasMode",
  "setRightTab",
  "setStatus",
  "setTheme",
  "setZoom",
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
  const names = new Set<string>();
  for (const shot of m.shots) {
    if (typeof shot.name !== "string" || !shot.name) {
      fail("every shot needs a name");
    }
    if (names.has(shot.name)) {
      fail(`duplicate shot name "${shot.name}"`);
    }
    names.add(shot.name);
    if (typeof shot.file !== "string" || !shot.file) {
      fail(`shot "${shot.name}": file is required`);
    }
    for (const action of shot.actions ?? []) {
      if (!ACTION_KINDS.has(action.do)) {
        fail(`shot "${shot.name}": unknown action "${action.do}"`);
      }
    }
    for (const wait of shot.waitFor ?? []) {
      if (!WAIT_KINDS.has(wait.type)) {
        fail(`shot "${shot.name}": unknown wait "${wait.type}"`);
      }
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
