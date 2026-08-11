/**
 * `$elements`, decided in one place (plan §11.2).
 *
 * Three surfaces wrote this array — the Packages panel's cherry-pick checkboxes, its "Add
 * component…" picker, and the automatic push when a component is dropped on the canvas — each with
 * its own idea of "already imported". Every case here is one of the disagreements, stated as the
 * behaviour the single service has to have.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import {
  disableElement,
  elementsEntryFor,
  enableElement,
  hasElement,
  npmSpecifier,
  removeElementRef,
  removePackageElements,
} from "../src/files/elements";
import type { ElementsEntry } from "../src/files/elements";
import type { ComponentEntry } from "../src/files/components";

const npm = (pkg: string, modulePath?: string): ComponentEntry =>
  ({ package: pkg, source: "npm", tagName: "x-a", ...(modulePath ? { modulePath } : {}) }) as never;

const local = (path: string): ComponentEntry => ({ path, tagName: "x-card" }) as never;

describe("how a component is named in $elements", () => {
  test("an npm component by its cherry-picked subpath, or its bare package", () => {
    expect(npmSpecifier(npm("@acme/ui", "card.js"))).toBe("@acme/ui/card.js");
    expect(npmSpecifier(npm("@acme/ui"))).toBe("@acme/ui");
    expect(npmSpecifier(local("components/card.json"))).toBeNull();
  });

  test("a local component by a $ref relative to the importing document", () => {
    expect(elementsEntryFor(local("components/card.json"), "pages/index.md")).toEqual({
      $ref: "../components/card.json",
    });
  });

  test("a component nameable neither way yields nothing to write", () => {
    expect(elementsEntryFor({ tagName: "x-ghost" } as never, null)).toBeNull();
  });
});

describe("already imported?", () => {
  test("a legacy whole-package entry satisfies a cherry-picked component", () => {
    // Only the checkbox knew this. The picker and the drop did not, so a page importing `@acme/ui`
    // Wholesale was told it did not have `@acme/ui/card.js`.
    expect(hasElement(["@acme/ui"], npm("@acme/ui", "card.js"), null)).toBe(true);
    expect(hasElement(["@acme/ui/card.js"], npm("@acme/ui", "card.js"), null)).toBe(true);
    expect(hasElement(["@acme/other"], npm("@acme/ui", "card.js"), null)).toBe(false);
  });

  test("two different files with the same NAME are two components", () => {
    /*
     * The canvas drop matched by `ref.endsWith(basename)`, so dropping `./components/card.json`
     * into a page that already imported `./vendor/card.json` counted as already imported — and the
     * drop produced an element the page could not resolve.
     */
    const elements: ElementsEntry[] = [{ $ref: "./vendor/card.json" }];
    expect(hasElement(elements, local("components/card.json"), null)).toBe(false);
    expect(hasElement(elements, local("vendor/card.json"), null)).toBe(true);
  });

  test("a component nameable neither way is never 'already imported'", () => {
    expect(
      hasElement(["@acme/ui", { $ref: "a.json" }], { tagName: "x-ghost" } as never, null),
    ).toBe(false);
  });

  test("`./a.json` and `a.json` are the same file", () => {
    expect(hasElement([{ $ref: "a.json" }], local("a.json"), null)).toBe(true);
    expect(hasElement([{ $ref: "././a.json" }], local("a.json"), null)).toBe(true);
  });
});

describe("enableElement", () => {
  test("adds the entry, and adding it twice adds it once", () => {
    // The picker pushed a second `$ref` every time you chose the same component.
    let elements = enableElement([], local("components/card.json"), null);
    elements = enableElement(elements, local("components/card.json"), null);
    expect(elements).toEqual([{ $ref: "./components/card.json" }]);
  });

  test("a cherry-picked import replaces the whole-package one it supersedes", () => {
    // Otherwise the page keeps pulling in every component of the package while the panel shows one
    // Ticked — which is what the picker's path did.
    expect(enableElement(["@acme/ui"], npm("@acme/ui", "card.js"), null)).toEqual([
      "@acme/ui/card.js",
    ]);
  });

  test("…but importing the package ITSELF is not a supersession", () => {
    expect(enableElement([], npm("@acme/ui"), null)).toEqual(["@acme/ui"]);
    expect(enableElement(["@acme/ui"], npm("@acme/ui"), null)).toEqual(["@acme/ui"]);
  });

  test("a component that cannot be named leaves the list alone", () => {
    expect(enableElement(["@acme/ui"], { tagName: "x-ghost" } as never, null)).toEqual([
      "@acme/ui",
    ]);
  });

  test("it never mutates the list it is given", () => {
    const before: ElementsEntry[] = ["@acme/ui"];
    enableElement(before, local("a.json"), null);
    expect(before).toEqual(["@acme/ui"]);
  });
});

describe("disableElement", () => {
  test("removes BOTH spellings of an npm import", () => {
    // Ticking a component off must not leave it imported through the package entry.
    expect(
      disableElement(
        ["@acme/ui", "@acme/ui/card.js", "@other/x"],
        npm("@acme/ui", "card.js"),
        null,
      ),
    ).toEqual(["@other/x"]);
  });

  test("removes a local import by resolved path, and leaves its namesake", () => {
    const elements: ElementsEntry[] = [
      { $ref: "./components/card.json" },
      { $ref: "./vendor/card.json" },
    ];
    expect(disableElement(elements, local("components/card.json"), null)).toEqual([
      { $ref: "./vendor/card.json" },
    ]);
  });

  test("removing what is not there is a no-op", () => {
    expect(disableElement(["@acme/ui"], local("a.json"), null)).toEqual(["@acme/ui"]);
  });
});

describe("removing a package", () => {
  test("takes its cherry-picked entries AND the whole-package one", () => {
    // The hand-rolled filter matched only `@acme/ui/…`, so uninstalling a package left `@acme/ui`
    // Importing a package that was gone.
    expect(
      removePackageElements(
        ["@acme/ui", "@acme/ui/card.js", "@acme/uikit", "@other/x"],
        "@acme/ui",
      ),
    ).toEqual(["@acme/uikit", "@other/x"]);
  });
});

describe("removeElementRef", () => {
  test("removes the named ref, whatever its spelling, and keeps npm entries", () => {
    const elements: ElementsEntry[] = ["@acme/ui", { $ref: "components/card.json" }];
    expect(removeElementRef(elements, "./components/card.json")).toEqual(["@acme/ui"]);
  });
});
