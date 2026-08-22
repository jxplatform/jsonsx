/**
 * The dist gate proves itself before it gates anything.
 *
 * `dist/` is gitignored and the test matrix never builds, so every rule is a pure function over an
 * injected listing and these run against fixture trees. What is asserted is not "the current build
 * is clean" — the gated `studio-dist` job says that — but that each rule fires on the shape it
 * exists for, starting with the one that let Monaco's icon font go missing from three distributions
 * at once.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  accountedFor,
  analyze,
  report,
  cssUrls,
  danglingUrls,
  emittedFiles,
  UNREACHABLE_CSS,
  unaccounted,
  unreachableStylesheets,
} from "../scripts/check-studio-dist";
import { STUDIO_ASSETS, STUDIO_WORKERS } from "../src/hosting/layout";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { force: true, recursive: true });
  }
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jx-dist-"));
  temps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** A build output that satisfies every required manifest entry. */
function completeBuild(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  for (const a of STUDIO_ASSETS.filter((x) => x.required)) {
    if (a.dir) {
      files[`${a.path}/.keep`] = "";
    } else {
      files[a.path] = `/* ${a.path} */`;
    }
  }
  for (const w of STUDIO_WORKERS) {
    files[`dist/workers/${w}`] = `// ${w}`;
  }
  files["dist/chunks/studio-a.js"] = "// chunk";
  /* The chunk stylesheets the real build emits. They belong in a "complete" fixture precisely
     because they are the thing UNREACHABLE_CSS carries — without them every allow-list entry reads
     as stale, which is a different finding. */
  for (const name of ["javascript", "jsonMode", "monaco-setup", "tsMode"]) {
    files[`dist/chunks/${name}-abc123.css`] = "/* monaco */";
  }
  return { ...files, ...extra };
}

describe("accountedFor", () => {
  test("a manifest file, and anything inside a manifest directory", () => {
    expect(accountedFor("dist/studio.js")).toBe(true);
    expect(accountedFor("dist/chunks/studio-abc.js")).toBe(true);
    expect(accountedFor("dist/workers/json.worker.js")).toBe(true);
  });

  test("source maps are excluded rather than listed", () => {
    expect(accountedFor("dist/chunks/studio-abc.js.map")).toBe(true);
  });

  /* THE codicon case, from the emission side. The build dropped a 140 KB font into dist/, the
     shipped CSS referenced it, no `files` entry and no host copy list mentioned it, and nothing
     compared the two — so three distributions drew tofu where Monaco draws icons. */
  test("an emitted file the manifest does not name is NOT accounted for", () => {
    expect(accountedFor("dist/some-new-font.ttf")).toBe(false);
  });
});

describe("unaccounted", () => {
  test("names the file and says what to do about it", () => {
    const [f] = unaccounted(["dist/studio.js", "dist/surprise.woff2"]);
    expect(f!.detail).toContain("dist/surprise.woff2");
    expect(f!.detail).toContain("STUDIO_ASSETS");
  });
});

describe("cssUrls", () => {
  test("reads quoted and bare urls, and drops the query", () => {
    expect(cssUrls('a{src:url("./codicon.ttf")} b{src:url(../x.woff2?v=1)}')).toEqual([
      "./codicon.ttf",
      "../x.woff2",
    ]);
  });

  test("ignores data uris and absolute urls — nothing local to resolve", () => {
    expect(
      cssUrls('a{src:url("data:font/woff2;base64,AA")} b{src:url(https://x/y.woff2)}'),
    ).toEqual([]);
  });
});

describe("danglingUrls", () => {
  /* The codicon case from the REFERENCE side, and the two shapes it really takes: dist/studio.css
     says `./codicon.ttf`, and the chunk stylesheets say `../codicon.ttf` from one level down. */
  test("resolves against the stylesheet's own directory, both ways", () => {
    const withFont = tree({
      "dist/chunks/mode.css": '@font-face{src:url("../codicon.ttf")}',
      "dist/codicon.ttf": "font",
      "dist/studio.css": '@font-face{src:url("./codicon.ttf")}',
    });
    const clean = danglingUrls(withFont, ["dist/studio.css", "dist/chunks/mode.css"]);
    expect(clean).toEqual([]);

    const without = tree({
      "dist/chunks/mode.css": '@font-face{src:url("../codicon.ttf")}',
      "dist/studio.css": '@font-face{src:url("./codicon.ttf")}',
    });
    const found = danglingUrls(without, ["dist/studio.css", "dist/chunks/mode.css"]);
    expect(found).toHaveLength(2);
    expect(found[0]!.detail).toContain("codicon.ttf");
    expect(found[0]!.detail).toContain("dist/codicon.ttf");
  });
});

describe("unreachableStylesheets", () => {
  test("a stylesheet an emitted script names is reachable", () => {
    const root = tree({
      "dist/chunks/x.css": "a{}",
      "dist/studio.js": 'import "./chunks/x.css";',
    });
    const found = unreachableStylesheets(root, ["dist/chunks/x.css"], ["dist/studio.js"]);
    expect(found).toEqual([]);
  });

  /* The finding nobody had named: Bun emits a stylesheet per chunk for CSS behind a dynamic import
     and injects no link for it, so about 687 KB of Monaco's CSS ships and is never applied — while
     dist/studio.css carries the same rules and is. */
  test("a stylesheet nothing names is a finding", () => {
    const root = tree({ "dist/chunks/orphan.css": "a{}", "dist/studio.js": "// nothing" });
    const found = unreachableStylesheets(root, ["dist/chunks/orphan.css"], ["dist/studio.js"]);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("orphan.css");
  });

  test("the allow-list carries the known ones", () => {
    const root = tree({ "dist/chunks/jsonMode-abc.css": "a{}", "dist/studio.js": "// nothing" });
    expect(
      unreachableStylesheets(root, ["dist/chunks/jsonMode-abc.css"], ["dist/studio.js"]),
    ).toEqual([]);
  });

  test("dist/studio.css is the entry's own and is linked by the document", () => {
    const root = tree({ "dist/studio.css": "a{}", "dist/studio.js": "// nothing" });
    const found = unreachableStylesheets(root, ["dist/studio.css"], ["dist/studio.js"]);
    expect(found).toEqual([]);
  });
});

describe("analyze", () => {
  test("an empty dist says to build rather than reporting every rule at once", () => {
    const found = analyze(tree({ "package.json": "{}" }));
    expect(found[0]!.rule).toBe("build");
  });

  test("a complete build is clean", () => {
    const found = analyze(tree(completeBuild()));
    expect(found).toEqual([]);
  });

  test("a missing required asset is reported with what it costs", () => {
    const files = completeBuild();
    delete files["dist/codicon.ttf"];
    const found = analyze(tree(files));
    const missing = found.filter((f) => f.rule === "missing");
    expect(missing.some((f) => f.detail.includes("Monaco's icon font"))).toBe(true);
  });

  test("a missing worker is reported by name", () => {
    const files = completeBuild();
    delete files["dist/workers/json.worker.js"];
    const found = analyze(tree(files));
    expect(found.some((f) => f.detail.includes("json.worker.js"))).toBe(true);
  });

  /* The allow-list ratchets down: an entry for a stylesheet nothing emits any more has to go. */
  test("a stale UNREACHABLE_CSS entry is a finding", () => {
    const files = completeBuild();
    for (const key of Object.keys(files)) {
      if (key.startsWith("dist/chunks/") && key.endsWith(".css")) {
        delete files[key];
      }
    }
    const found = analyze(tree(files));
    expect(found.filter((f) => f.rule === "stale-allowlist")).toHaveLength(UNREACHABLE_CSS.length);
  });
});

describe("emittedFiles", () => {
  test("lists dist/ relative to the package root, in POSIX", () => {
    const root = tree({ "dist/a.js": "", "dist/chunks/b.js": "" });
    expect(emittedFiles(join(root, "dist"), root)).toEqual(["dist/a.js", "dist/chunks/b.js"]);
  });

  test("an absent dist is empty rather than a throw", () => {
    const root = tree({ "x.txt": "" });
    expect(emittedFiles(join(root, "dist"), "/tmp")).toEqual([]);
  });
});

describe("report", () => {
  test("a clean build reports what it measured", () => {
    const lines = report([], tree(completeBuild())).join("\n");
    expect(lines).toContain("emitted file(s)");
    expect(lines).toContain("every css url() resolves");
  });

  test("findings are listed by rule", () => {
    const lines = report([{ detail: "dist/x.ttf is emitted", rule: "unaccounted" }]).join("\n");
    expect(lines).toContain("[unaccounted]");
    expect(lines).toContain("dist/x.ttf");
  });
});
