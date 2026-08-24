/**
 * The gate that would have caught the broken desktop build.
 *
 * The bug it encodes: `electrobun.config.ts` imported `@jxsuite/studio/hosting/layout`, which every
 * resolver in this repo follows and the electrobun CLI's does not — and the CLI answers a config it
 * cannot load by using a DIFFERENT one, silently. See the script header.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG_ENTRYPOINT,
  isResolvableByCli,
  main,
  report,
  summary,
  valueImportSpecifiers,
} from "../scripts/check-electrobun-config";
import type { ConfigShape, Failure, Inputs } from "../scripts/check-electrobun-config";
import { STUDIO_ASSETS } from "../../studio/src/hosting/layout";

const soundConfig = (): ConfigShape => ({
  build: {
    bun: { entrypoint: "src/index.ts" },
    copy: {
      "../starters/registry.json": "bun/registry.json",
      ...Object.fromEntries(
        STUDIO_ASSETS.map((a) => [`assets/studio/${a.path}`, `views/studio/${a.path}`]),
      ),
    },
    linux: { icon: "icon.png" },
    win: { icon: "icon.ico" },
  },
  scripts: { postBuild: "./scripts/post-build.ts", preBuild: "./scripts/pre-build.ts" },
});

const SOUND_SOURCE = [
  'import type { ElectrobunConfig } from "electrobun";',
  'import { STUDIO_ASSETS } from "../studio/src/hosting/layout";',
  'import { readFileSync } from "node:fs";',
].join("\n");

const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  config: soundConfig(),
  exists: () => true,
  source: SOUND_SOURCE,
  ...over,
});

const rules = (failures: readonly Failure[]): readonly string[] => failures.map((f) => f.rule);

describe("valueImportSpecifiers", () => {
  test("skips type-only imports, because the CLI never resolves them", () => {
    // `import type { ElectrobunConfig } from "electrobun"` is a bare specifier AND correct: it is
    // Erased before the CLI sees the file, and there is no relative path to a dependency's types.
    expect(valueImportSpecifiers(SOUND_SOURCE)).toEqual([
      "../studio/src/hosting/layout",
      "node:fs",
    ]);
  });

  test("reads the specifier, not the clause — default, named and namespace alike", () => {
    const source = [
      'import config from "./a";',
      'import { one, two } from "./b";',
      'import * as ns from "node:path";',
    ].join("\n");
    expect(valueImportSpecifiers(source)).toEqual(["./a", "./b", "node:path"]);
  });

  test("a file with no imports yields nothing rather than throwing", () => {
    expect(valueImportSpecifiers("export default {};\n")).toEqual([]);
  });

  test("an indented import is not a top-level one and is left alone", () => {
    expect(valueImportSpecifiers('  import { x } from "pkg";')).toEqual([]);
  });
});

describe("isResolvableByCli", () => {
  test("node: builtins and relative paths resolve", () => {
    expect(isResolvableByCli("node:fs")).toBe(true);
    expect(isResolvableByCli("./scripts/x")).toBe(true);
    expect(isResolvableByCli("../studio/src/hosting/layout")).toBe(true);
  });

  test("a bare specifier does not — this is the whole bug", () => {
    expect(isResolvableByCli("@jxsuite/studio/hosting/layout")).toBe(false);
    expect(isResolvableByCli("electrobun")).toBe(false);
  });
});

describe("report", () => {
  test("the real config's shape passes every rule", () => {
    expect(report(inputs())).toEqual([]);
  });

  test("a bare value import fails, and the message names the fallback entrypoint", () => {
    const source = SOUND_SOURCE.replace(
      "../studio/src/hosting/layout",
      "@jxsuite/studio/hosting/layout",
    );
    const failures = report(inputs({ source }));
    expect(rules(failures)).toEqual(["resolvable"]);
    expect(failures[0]?.message).toContain("@jxsuite/studio/hosting/layout");
    // The message has to carry the SYMPTOM, because that is what the build prints and what anyone
    // Reading a red CI log will have searched for.
    expect(failures[0]?.message).toContain(DEFAULT_CONFIG_ENTRYPOINT);
  });

  test("a declared path that is not on disk fails, naming the field", () => {
    const failures = report(inputs({ exists: (p) => p !== "./scripts/pre-build.ts" }));
    expect(rules(failures)).toEqual(["declared"]);
    expect(failures[0]?.message).toContain("scripts.preBuild");
  });

  test("an absent icon fails — it is declared per platform and easy to rename", () => {
    const failures = report(inputs({ exists: (p) => p !== "icon.ico" }));
    expect(rules(failures)).toEqual(["declared"]);
    expect(failures[0]?.message).toContain("build.win.icon");
  });

  test("a platform block with no icon is fine, and an absent one is not confused with it", () => {
    const config = soundConfig();
    const failures = report(
      inputs({ config: { ...config, build: { ...config.build, linux: {}, win: undefined } } }),
    );
    expect(failures).toEqual([]);
  });

  test("the electrobun DEFAULT entrypoint is rejected even when the file exists", () => {
    // A config that loaded correctly and a config that silently did not both end up here, so the
    // Value itself is treated as the tell rather than the file's absence.
    const config = soundConfig();
    const failures = report(
      inputs({
        config: { ...config, build: { ...config.build, bun: { entrypoint: "src/bun/index.ts" } } },
      }),
    );
    expect(rules(failures)).toEqual(["declared"]);
    expect(failures[0]?.message).toContain("DEFAULT");
  });

  test("an EMPTY derivation is caught — a config can load and still ship no studio", () => {
    const config = soundConfig();
    const failures = report(
      inputs({
        config: { ...config, build: { ...config.build, copy: {} } },
      }),
    );
    expect(rules(failures)).toEqual(["derived"]);
    expect(failures[0]?.message).toContain(String(STUDIO_ASSETS.length));
  });

  test("a PARTIAL derivation is caught too, and names what is missing", () => {
    const config = soundConfig();
    const [dropped] = STUDIO_ASSETS;
    const copy = { ...config.build.copy };
    delete copy[`assets/studio/${dropped?.path ?? ""}`];
    const failures = report(inputs({ config: { ...config, build: { ...config.build, copy } } }));
    expect(rules(failures)).toEqual(["derived"]);
    expect(failures[0]?.message).toContain(dropped?.path ?? "");
  });

  test("a non-prebuild copy source that vanished fails; prebuild outputs are exempt", () => {
    // `assets/**` is written by pre-build, so it is legitimately absent in a clean checkout;
    // `../starters/registry.json` is a repo file and a rename of it must be caught here.
    const failures = report(inputs({ exists: (p) => !p.startsWith("../starters/") }));
    expect(rules(failures)).toEqual(["declared"]);
    expect(failures[0]?.message).toContain("../starters/registry.json");
  });
});

describe("summary", () => {
  test("counts both sides when there is nothing wrong", () => {
    const line = summary([], 16);
    expect(line).toContain("16 copy row(s)");
    expect(line).toContain(`${STUDIO_ASSETS.length} manifest`);
  });

  test("prints every failure, tagged by rule, one per line", () => {
    const line = summary(
      [
        { message: "first", rule: "resolvable" },
        { message: "second", rule: "derived" },
      ],
      0,
    );
    expect(line.split("\n")).toEqual(["[resolvable] first", "[derived] second"]);
  });
});

describe("main", () => {
  test("judges the config that is actually committed, and finds it sound", async () => {
    const lines: string[] = [];
    expect(await main((line: string) => lines.push(line))).toBe(0);
    expect(lines[0]).toContain("✓ check-electrobun-config");
  });
});
