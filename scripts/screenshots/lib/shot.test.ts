import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootUrl, DOCK_COMMAND, frameBlockers, matchState, OPEN_COMMANDS } from "./shot";
import { resolveShot, validateManifest } from "./types";
import type { ShotContext } from "./shot";
import type { Manifest, ResolvedOpen } from "./types";

const ctx: ShotContext = {
  force: false,
  log: () => {},
  outDir: "/repo/docs/images",
  projectRoot: "/repo/.cache/screenshots/projects/packages-starters-sites-restaurant",
  repoRoot: "/repo",
  serverUrl: "http://127.0.0.1:3000",
  studioPath: "/packages/studio/index.html",
};

function open(patch: Partial<ResolvedOpen> = {}): ResolvedOpen {
  const m = validateManifest({
    contract: 1,
    outDir: "docs/images",
    shots: [{ capture: [{ image: "x" }], name: "x" }],
  }) as Manifest;
  return { ...resolveShot(m, m.shots[0]!).open, ...patch };
}

describe("bootUrl", () => {
  test("carries the four fields that are genuinely boot state", () => {
    const url = new URL(
      bootUrl(ctx, open({ clock: "2026-01-15T09:30:00Z", file: "pages/index.md" })),
    );
    expect(url.pathname).toBe("/packages/studio/index.html");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      automation: "1",
      clock: "2026-01-15T09:30:00Z",
      file: "pages/index.md",
      profile: "fresh",
      project: ctx.projectRoot!,
    });
  });

  test("opens the OVERLAY, never the repo-relative path the manifest wrote", () => {
    const url = new URL(bootUrl(ctx, open({ project: "packages/starters/sites/restaurant" })));
    expect(url.searchParams.get("project")).toBe(ctx.projectRoot!);
    expect(url.searchParams.get("project")).toContain(".cache/screenshots");
  });

  test("a shot with no project boots the welcome screen — no project, no file", () => {
    const bare: ShotContext = { ...ctx };
    delete bare.projectRoot;
    const url = new URL(bootUrl(bare, open()));
    expect(url.searchParams.has("project")).toBe(false);
    expect(url.searchParams.has("file")).toBe(false);
    expect(url.searchParams.get("profile")).toBe("fresh");
  });

  test("the profile is always stated — it replaced reaching around the app to clear an origin", () => {
    expect(bootUrl(ctx, open({ profile: "default" }))).toContain("profile=default");
  });
});

describe("the open→command mapping", () => {
  test("names one idempotent command per app-owned field", () => {
    expect(OPEN_COMMANDS).toEqual({
      fit: { arg: "fit", id: "canvas.setFit" },
      theme: { arg: "color", id: "view.setTheme" },
      view: { arg: "mode", id: "canvas.setMode" },
    });
    expect(DOCK_COMMAND).toBe("view.setDock");
  });

  test("no open field is applied through a toggle", () => {
    for (const { id } of Object.values(OPEN_COMMANDS)) {
      expect(id).not.toMatch(/\.toggle[A-Z]/);
    }
    expect(DOCK_COMMAND).not.toMatch(/\.toggle[A-Z]/);
  });
});

describe("matchState", () => {
  const state = {
    document: { dirty: false, mode: "md", open: true },
    git: { ahead: 0, dirtyCount: 3 },
    selection: { count: 1, kind: "p" },
  };

  test("a partial match reports nothing", () => {
    expect(matchState({ git: { dirtyCount: 3 } }, state)).toEqual([]);
    expect(matchState({}, state)).toEqual([]);
    expect(matchState({ document: { mode: "md" }, selection: { count: 1 } }, state)).toEqual([]);
  });

  test("a mismatch names the path, what it is and what was wanted", () => {
    expect(matchState({ document: { dirty: true } }, state)).toEqual([
      "document.dirty is false, expected true",
    ]);
  });

  test("every mismatch is reported, not just the first", () => {
    expect(matchState({ document: { dirty: true, mode: "json" } }, state)).toHaveLength(2);
  });

  test("a key the state does not carry is a mismatch, not a pass", () => {
    expect(matchState({ shell: { leftTab: "git" } }, state)).toEqual([
      "shell is undefined, expected an object",
    ]);
    expect(matchState({ git: { behind: 0 } }, state)).toEqual([
      "git.behind is undefined, expected 0",
    ]);
  });

  test("arrays compare by value, so a path assertion is exact", () => {
    expect(matchState({ sel: [1, 2] }, { sel: [1, 2] })).toEqual([]);
    expect(matchState({ sel: [1, 2] }, { sel: [1, 3] })).toEqual(["sel is [1,3], expected [1,2]"]);
  });

  test("expecting an object where the state holds a scalar says so", () => {
    expect(matchState({ git: { ahead: 0 } }, { git: 3 })).toEqual(["git is 3, expected an object"]);
  });
});

// ─── Where the pointer parks ─────────────────────────────────────────────────

describe("resetPointerAndFocus", () => {
  test("parks the cursor INSIDE the viewport", () => {
    /*
     * It used to move to `(-1, -1)` — off-canvas, so nothing matched `:hover`. CDP accepted that;
     * **WebDriver BiDi refuses it**: `input.performActions` rejects a move beyond the viewport with
     * "move target out of bounds", and every shot failed the moment the pipeline spoke the
     * standard's protocol. The bottom-right corner has the same property — no panel's interactive
     * content occupies it — in coordinates the standard allows.
     */
    const source = readFileSync(join(import.meta.dir, "shot.ts"), "utf8");
    expect(source).not.toContain("mouse.move(-1, -1)");
    expect(source).toContain("viewport.width - 1");
    expect(source).toContain("viewport.height - 1");
  });
});

// ─── frameBlockers ────────────────────────────────────────────────────────────

/**
 * A stand-in for one `@font-face` in a frame's `document.fonts`.
 *
 * `load()` moving the face to "loading" synchronously is the behaviour the predicate leans on, and
 * it is what the CSS Font Loading spec requires of an unloaded face, so the fake owes it too.
 */
class FakeFace {
  status: string;
  loads = 0;
  constructor(status: string) {
    this.status = status;
  }
  load(): Promise<unknown> {
    this.loads += 1;
    if (this.status === "unloaded") {
      this.status = "loading";
    }
    return Promise.resolve(this);
  }
}

/** Install the three globals `frameBlockers` reads, as a frame would present them. */
function installFrame(faces: FakeFace[], setStatus = "loaded"): void {
  const g = globalThis as Record<string, unknown>;
  g.document = {
    activeElement: null,
    fonts: { status: setStatus, [Symbol.iterator]: () => faces[Symbol.iterator]() },
    getAnimations: () => [],
  };
  g.window = {};
}

/** Only the font clause; the focus clause reports once on first sight by design. */
const fontLines = () => frameBlockers().filter((line) => line.includes("font face"));

describe("frameBlockers", () => {
  test("triggers a declared-but-unstarted face and blocks on it", () => {
    const face = new FakeFace("unloaded");
    installFrame([face]);

    // The window the runner used to fall through: the stylesheet has parsed, nothing is in flight,
    // And `document.fonts.status` reads "loaded" over a set that has not begun.
    expect(fontLines()).toEqual(["1 font face(s) loading"]);
    expect(face.loads).toBe(1);
    expect(face.status).toBe("loading");
  });

  test("keeps blocking while a face is loading", () => {
    installFrame([new FakeFace("loading")]);
    expect(fontLines()).toEqual(["1 font face(s) loading"]);
  });

  test("clears once every face has resolved", () => {
    installFrame([new FakeFace("loaded"), new FakeFace("loaded")]);
    expect(fontLines()).toEqual([]);
  });

  test("a face that cannot load stops blocking, so an offline container terminates", () => {
    // "error" is where an unreachable webfont lands. Blocking on it would hang the shot until the
    // Idle timeout and then fail a capture that was never going to get its font.
    installFrame([new FakeFace("error")]);
    expect(fontLines()).toEqual([]);
  });

  test("honours the set's own aggregate status", () => {
    installFrame([], "loading");
    expect(fontLines()).toEqual(["1 font face(s) loading"]);
  });
});
