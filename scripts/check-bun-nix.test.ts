/**
 * The gate that keeps `bun.nix` a function of `bun.lock`.
 *
 * This lives flat in `scripts/` rather than `scripts/ci/` for the same reason
 * `scripts/release-config.test.ts` does: it runs unconditionally via `bun test --isolate scripts`
 * in the `changes` job, and `scripts/ci/**` is in `affected.ts`'s GLOBAL list, so putting it there
 * would make editing it run the full workspace matrix.
 *
 * The last test is not a unit test — it is the invariant itself, asserted in the FIRST job of the
 * graph. A dependency PR that forgot `bun.nix` fails there in a second rather than 90 seconds later
 * inside `nix build`, and before the matrix has been spent on it.
 */

import { describe, expect, test } from "bun:test";

import {
  attributeNames,
  describe as describeDrift,
  diff,
  generate,
  generatorCommand,
  LOCK_FILE,
  NIX_FILE,
  pinnedGeneratorVersion,
} from "./check-bun-nix.ts";

const FIXTURE = `{
  fetchurl,
  fetchFromGitHub,
  fetchgit,
  copyPathToStore,
}:
{
  "lodash@4.17.21" = fetchurl {
    url = "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz";
    hash = "sha512-AAA==";
  };
  "some-fork@1.0.0" = fetchFromGitHub {
    owner = "acme";
    repo = "some-fork";
    hash = "sha256-BBB=";
  };
  "@jxsuite/schema@workspace" = copyPathToStore ./packages/schema;
}
`;

describe("attributeNames", () => {
  test("names every package the expression declares, whatever fetched it", () => {
    expect([...attributeNames(FIXTURE)].toSorted()).toEqual([
      "@jxsuite/schema@workspace",
      "lodash@4.17.21",
      "some-fork@1.0.0",
    ]);
  });

  test("ignores the fetcher arguments, which also contain quoted strings", () => {
    // `url = "https://…"` and `hash = "sha512-…"` are quoted and would match a laxer pattern.
    expect(
      attributeNames(FIXTURE).has("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"),
    ).toBe(false);
  });

  test("an expression with no packages is an empty set, not a parse error", () => {
    expect(attributeNames("{ }\n").size).toBe(0);
  });
});

describe("diff", () => {
  test("identical files are not drift", () => {
    expect(diff(FIXTURE, FIXTURE)).toBeNull();
  });

  test("a new dependency shows up as added", () => {
    const next = FIXTURE.replace(
      '  "lodash@4.17.21"',
      '  "left-pad@1.3.0" = fetchurl {\n    url = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";\n    hash = "sha512-CCC==";\n  };\n  "lodash@4.17.21"',
    );
    const drift = diff(FIXTURE, next)!;
    expect(drift.added).toEqual(["left-pad@1.3.0"]);
    expect(drift.removed).toEqual([]);
    expect(drift.contentOnly).toBe(false);
  });

  test("a version bump is one removal and one addition, because the key carries the version", () => {
    const drift = diff(FIXTURE, FIXTURE.replaceAll("lodash@4.17.21", "lodash@4.17.22"))!;
    expect(drift.added).toEqual(["lodash@4.17.22"]);
    expect(drift.removed).toEqual(["lodash@4.17.21"]);
  });

  test("a changed hash on an unchanged package set is content-only drift", () => {
    const drift = diff(FIXTURE, FIXTURE.replace("sha512-AAA==", "sha512-ZZZ=="))!;
    expect(drift.contentOnly).toBe(true);
    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual([]);
  });

  test("a missing bun.nix reads as every package being added, not as a crash", () => {
    const drift = diff("", FIXTURE)!;
    expect(drift.added).toHaveLength(3);
    expect(drift.contentOnly).toBe(false);
  });
});

describe("describe", () => {
  test("content-only drift says so instead of printing an empty list", () => {
    expect(describeDrift({ added: [], removed: [], contentOnly: true })).toContain(
      "contents differ",
    );
  });

  test("a full dependency sweep is capped so the report stays readable", () => {
    const added = Array.from({ length: 50 }, (_, i) => `pkg-${i}@1.0.0`);
    const text = describeDrift({ added, removed: [], contentOnly: false }, 5);
    expect(text).toContain("50 added");
    expect(text).toContain("… and 45 more");
    expect(text.split("\n")).toHaveLength(7); // Header + 5 entries + the elision
  });

  test("both directions are reported when a bump replaces a package", () => {
    const text = describeDrift({
      added: ["lodash@4.17.22"],
      removed: ["lodash@4.17.21"],
      contentOnly: false,
    });
    expect(text).toContain("+ lodash@4.17.22");
    expect(text).toContain("- lodash@4.17.21");
  });
});

describe("generatorCommand", () => {
  test("prefers the installed binary, which is the one bun.lock pins", () => {
    expect(generatorCommand(true)[0]).toBe("node_modules/.bin/bun2nix");
  });

  test("falls back to bunx for a tree that has not installed yet", () => {
    expect(generatorCommand(false).slice(0, 2)).toEqual(["bunx", "bun2nix"]);
  });

  test("the bunx fallback carries the manifest's pin, so the two paths cannot disagree", () => {
    expect(generatorCommand(false, "2.1.2").slice(0, 2)).toEqual(["bunx", "bun2nix@2.1.2"]);
  });

  test("a pin is irrelevant once the binary is installed — that one IS the pin", () => {
    expect(generatorCommand(true, "2.1.2")[0]).toBe("node_modules/.bin/bun2nix");
  });

  test("both forms read the lockfile explicitly rather than relying on the default", () => {
    for (const cmd of [generatorCommand(true), generatorCommand(false)]) {
      expect(cmd).toContain("-l");
      expect(cmd).toContain(LOCK_FILE);
    }
  });
});

describe("pinnedGeneratorVersion", () => {
  test("reduces a caret range to the version bunx will accept", () => {
    expect(pinnedGeneratorVersion({ devDependencies: { bun2nix: "^2.1.2" } })).toBe("2.1.2");
  });

  test("accepts an exact pin and a tilde range", () => {
    expect(pinnedGeneratorVersion({ devDependencies: { bun2nix: "2.1.2" } })).toBe("2.1.2");
    expect(pinnedGeneratorVersion({ devDependencies: { bun2nix: "~2.1.2" } })).toBe("2.1.2");
  });

  test("keeps a prerelease qualifier, which is part of the version", () => {
    expect(pinnedGeneratorVersion({ devDependencies: { bun2nix: "^3.0.0-rc.1" } })).toBe(
      "3.0.0-rc.1",
    );
  });

  test("a range that names no single version yields none, rather than a wrong guess", () => {
    for (const range of [">=2 <3", "*", "latest", "github:nix-community/bun2nix"]) {
      expect(pinnedGeneratorVersion({ devDependencies: { bun2nix: range } })).toBeUndefined();
    }
  });

  test("a manifest without the dependency, or no manifest at all, yields none", () => {
    expect(pinnedGeneratorVersion({ devDependencies: {} })).toBeUndefined();
    expect(pinnedGeneratorVersion({})).toBeUndefined();
    expect(pinnedGeneratorVersion(null)).toBeUndefined();
  });

  test("the repository's own manifest resolves, so the nix.yml fallback is pinned in practice", async () => {
    const manifest = await Bun.file("package.json").json();
    expect(pinnedGeneratorVersion(manifest)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("the generator", () => {
  test(`runs over ${LOCK_FILE} and produces a package set this module can read`, () => {
    const result = generate();
    expect(result.error ?? "").toBe("");
    expect(result.ok).toBe(true);
    // The lockfile pins on the order of a thousand packages; any plausible failure mode of the
    // Subprocess (an empty stdout, an error page, a truncated write) lands far below this.
    expect(attributeNames(result.text).size).toBeGreaterThan(100);
  });

  test(`reports drift against the committed ${NIX_FILE} rather than throwing`, async () => {
    // Deliberately NOT an assertion that the two are equal. Under the release-gated policy
    // (.github/workflows/release-bun-nix.yml) a dependency PR merges with bun.nix untouched and
    // The file is regenerated on the release PR, so `main` is allowed to carry a lagging bun.nix
    // Between releases. What must hold at every commit is that the comparison is well-defined.
    const result = generate();
    const drift = diff(await Bun.file(NIX_FILE).text(), result.text);
    if (drift !== null) {
      expect(describeDrift(drift).length).toBeGreaterThan(0);
    } else {
      expect(drift).toBeNull();
    }
  });
});
