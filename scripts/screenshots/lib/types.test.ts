// oxlint-disable unicorn/no-thenable -- `then` is a manifest KEY (§13.2, the verb that replaced
// `variants`). These are inert JSON literals; nothing awaits a shot.
import { describe, expect, test } from "bun:test";
import {
  CONTRACT_VERSION,
  DEFAULT_DEVICE_SCALE_FACTOR,
  DEFAULT_PROFILE,
  DEFAULT_VIEWPORT,
  isCaptureTarget,
  isCommandStep,
  isInputStep,
  isRegionExpectation,
  isRegionId,
  isSeedStep,
  resolveShot,
  shotImages,
  validateManifest,
} from "./types";
import type { Manifest, Shot } from "./types";

/** A minimal manifest that passes, so each test can state exactly one deviation from it. */
function manifest(shots: unknown[], defaults?: unknown): unknown {
  return {
    contract: CONTRACT_VERSION,
    outDir: "docs/images",
    ...(defaults === undefined ? {} : { defaults }),
    shots,
  };
}

const HERO = {
  capture: [{ image: "hero" }],
  name: "hero",
  open: { file: "pages/index.md", project: "packages/starters/sites/real-estate" },
};

describe("the region grammar", () => {
  test.each([
    "rail",
    "navigator",
    "navigator/panel:git",
    "navigator/panel:git/commit",
    "inspector/tab:style",
    "inspector/field:href",
    "pane",
    "pane.primary/tabs",
    "dock.bottom",
    "dock.bottom/activity",
    "overlay.dialog:settings",
    "statusbar/selection",
    "commandbar",
  ])("%s is a region id", (id) => {
    expect(isRegionId(id)).toBe(true);
  });

  test.each([
    "#app",
    ".git-panel",
    "xpath//div",
    "#right-panel [data-prop='href']",
    "",
    "navigator/",
    "pane.",
    "sidebar",
    "sp-popover[open]",
  ])("%s is not a region id — a selector can never resolve", (id) => {
    expect(isRegionId(id)).toBe(false);
  });

  test('"viewport" is a capture target but not a region — it names the camera, not a node', () => {
    expect(isCaptureTarget("viewport")).toBe(true);
    expect(isRegionId("viewport")).toBe(false);
  });
});

describe("validateManifest", () => {
  test("accepts the §13.2 shape", () => {
    const ok = validateManifest(
      manifest([
        {
          capture: [
            { image: "git-panel", of: "navigator/panel:git" },
            { image: "git-commit", of: "navigator/panel:git/commit", padding: 16 },
          ],
          docs: ["studio/publish"],
          expect: [{ region: "navigator/panel:git" }, { state: { git: { dirtyCount: 3 } } }],
          name: "git-panel",
          open: {
            clock: "2026-01-15T09:30:00Z",
            docks: { chat: { collapsed: true } },
            file: "pages/index.md",
            fit: "width",
            profile: "fresh",
            project: "scripts/screenshots/fixtures/repos/showcase",
            view: "design",
          },
          steps: [
            { args: { panel: "git" }, cmd: "view.showPanel" },
            { args: { fixture: "dirty-3" }, seed: "seed.git" },
          ],
          then: [{ capture: [{ image: "git-panel-light" }], steps: [{ cmd: "view.setTheme" }] }],
        },
      ]),
    );
    expect(ok.shots).toHaveLength(1);
  });

  test("a contract mismatch is refused before anything else is read", () => {
    expect(() => validateManifest({ contract: 2, outDir: "x", shots: [HERO] })).toThrow(
      "this runner implements 1",
    );
  });

  test.each([
    ["actions", "steps — one of cmd | seed | input per entry"],
    ["canvasMode", "open.view"],
    ["clip", "capture[].of"],
    ["regions", "capture"],
    ["variants", "then"],
    ["waitFor", "expect"],
    ["noProject", "omit open.project"],
    ["project", "open.project"],
  ])("a shot still carrying %s names its replacement", (key, replacement) => {
    expect(() => validateManifest(manifest([{ ...HERO, [key]: [] }]))).toThrow(replacement);
  });

  test("a step may never name a selector", () => {
    expect(() =>
      validateManifest(manifest([{ ...HERO, steps: [{ cmd: "x.y", selector: ".git-panel" }] }])),
    ).toThrow("a step may never name a selector");
  });

  test("a step carries exactly one verb", () => {
    expect(() => validateManifest(manifest([{ ...HERO, steps: [{}] }]))).toThrow("found none");
    expect(() =>
      validateManifest(manifest([{ ...HERO, steps: [{ cmd: "a.b", seed: "seed.git" }] }])),
    ).toThrow("cmd + seed");
  });

  test("input steps are checked kind by kind, and their region must be a region id", () => {
    const step = (s: unknown) => () => validateManifest(manifest([{ ...HERO, steps: [s] }]));
    expect(step({ input: "press" })).toThrow("input must be one of");
    expect(step({ input: "hover" })).toThrow('input "hover" needs a region id');
    expect(step({ input: "type" })).toThrow('input "type" needs text');
    expect(step({ input: "caret" })).toThrow('input "caret" needs a JxPath');
    expect(step({ input: "hover", region: ".git-panel" })).toThrow("is not a region id");
    expect(step({ input: "caret", path: ["children", 3] })).not.toThrow();
  });

  test("an expect entry carries exactly one of region | state, and the region is an id", () => {
    const entry = (e: unknown) => () => validateManifest(manifest([{ ...HERO, expect: [e] }]));
    expect(entry({})).toThrow("exactly one of region | state");
    expect(entry({ region: "rail", state: {} })).toThrow("exactly one of region | state");
    expect(entry({ region: "#tab-strip" })).toThrow("is not a region id");
    expect(entry({ state: { document: { dirty: true } } })).not.toThrow();
  });

  test("a capture names a region or the viewport, never a selector", () => {
    expect(() =>
      validateManifest(manifest([{ ...HERO, capture: [{ image: "x", of: "#tab-strip" }] }])),
    ).toThrow('neither a region id nor "viewport"');
  });

  test("image names are unique across the whole manifest, then-segments included", () => {
    expect(() => validateManifest(manifest([HERO, { ...HERO, name: "hero-2" }]))).toThrow(
      'duplicate image name "hero"',
    );
    expect(() =>
      validateManifest(manifest([{ ...HERO, then: [{ capture: [{ image: "hero" }] }] }])),
    ).toThrow('duplicate image name "hero"');
  });

  test("shot names are unique", () => {
    expect(() =>
      validateManifest(manifest([HERO, { ...HERO, capture: [{ image: "hero-2" }] }])),
    ).toThrow('duplicate shot name "hero"');
  });

  test("open fields are typed, and an unknown one is a failure rather than a silent no-op", () => {
    const open = (o: unknown) => () => validateManifest(manifest([{ ...HERO, open: o }]));
    expect(open({ project: 3 })).toThrow("open.project must be a non-empty string");
    expect(open({ fit: "cover" })).toThrow("open.fit must be");
    expect(open({ fit: 0.75 })).not.toThrow();
    expect(open({ viewport: { width: 1280 } })).toThrow("open.viewport must be");
    expect(open({ deviceScaleFactor: 0 })).toThrow("open.deviceScaleFactor");
    expect(open({ docks: [] })).toThrow("open.docks must be an object");
    expect(open({ zoom: 0.9 })).toThrow('unknown open field "zoom"');
  });

  test("the root itself is validated", () => {
    expect(() => validateManifest(null)).toThrow("root must be an object");
    expect(() => validateManifest({ contract: 1, shots: [] })).toThrow("outDir");
    expect(() => validateManifest({ contract: 1, outDir: "x", shots: [] })).toThrow(
      "non-empty array",
    );
    expect(() => validateManifest(manifest([{ capture: [] }]))).toThrow("needs a name");
    expect(() => validateManifest(manifest([HERO], { theme: 4 }))).toThrow(
      "manifest defaults: open.theme",
    );
  });

  test("then segments are validated like the shot body", () => {
    expect(() =>
      validateManifest(
        manifest([{ ...HERO, then: [{ steps: [{ cmd: "a.b", input: "hover" }] }] }]),
      ),
    ).toThrow('shot "hero" then[0] step 1');
    expect(() => validateManifest(manifest([{ ...HERO, then: [{ variants: [] }] }]))).toThrow(
      "then[0]",
    );
  });
});

describe("resolveShot", () => {
  const defaults = {
    deviceScaleFactor: 1.5,
    docks: { chat: { collapsed: false } },
    project: "packages/starters/sites/real-estate",
    theme: "dark",
    viewport: { height: 1000, width: 1920 },
  };

  test("folds defaults in and leaves every field decided", () => {
    const m = validateManifest(manifest([HERO], defaults)) as Manifest;
    const resolved = resolveShot(m, m.shots[0]!);
    expect(resolved.open).toEqual({
      clock: null,
      deviceScaleFactor: 1.5,
      docks: { chat: { collapsed: false } },
      file: "pages/index.md",
      fit: null,
      profile: DEFAULT_PROFILE,
      project: "packages/starters/sites/real-estate",
      theme: "dark",
      view: null,
      viewport: { height: 1000, width: 1920 },
    });
  });

  test("the shot wins over defaults, and docks merge per dock id", () => {
    const shot: Shot = {
      capture: [{ image: "x" }],
      name: "x",
      open: { docks: { problems: { collapsed: true } }, project: "examples", theme: "light" },
    };
    const m = validateManifest(manifest([shot], defaults)) as Manifest;
    const resolved = resolveShot(m, m.shots[0]!);
    expect(resolved.open.project).toBe("examples");
    expect(resolved.open.theme).toBe("light");
    expect(resolved.open.docks).toEqual({
      chat: { collapsed: false },
      problems: { collapsed: true },
    });
  });

  test("with no defaults at all the boot state is still total", () => {
    const m = validateManifest(
      manifest([{ capture: [{ image: "w" }], name: "welcome" }]),
    ) as Manifest;
    const resolved = resolveShot(m, m.shots[0]!);
    expect(resolved.open.project).toBeNull();
    expect(resolved.open.profile).toBe(DEFAULT_PROFILE);
    expect(resolved.open.viewport).toEqual(DEFAULT_VIEWPORT);
    expect(resolved.open.deviceScaleFactor).toBe(DEFAULT_DEVICE_SCALE_FACTOR);
    expect(resolved.open.docks).toEqual({});
  });
});

describe("step and expectation predicates", () => {
  test("classify the three verbs", () => {
    expect(isCommandStep({ cmd: "a.b" })).toBe(true);
    expect(isSeedStep({ seed: "seed.git" })).toBe(true);
    expect(isInputStep({ input: "hover", region: "rail" })).toBe(true);
    expect(isCommandStep({ seed: "seed.git" })).toBe(false);
    expect(isInputStep({ cmd: "a.b" })).toBe(false);
    expect(isSeedStep({ input: "hover", region: "rail" })).toBe(false);
  });

  test("classify the two assertions", () => {
    expect(isRegionExpectation({ region: "rail" })).toBe(true);
    expect(isRegionExpectation({ state: {} })).toBe(false);
  });
});

describe("shotImages", () => {
  test("lists every image the shot writes, body then segments, in capture order", () => {
    expect(
      shotImages({
        capture: [{ image: "a" }, { image: "b" }],
        name: "s",
        then: [{ capture: [{ image: "c" }] }, {}],
      }),
    ).toEqual(["a", "b", "c"]);
  });
});
