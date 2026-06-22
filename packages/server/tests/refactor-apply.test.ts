import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProjectFormatRegistry } from "@jxsuite/compiler/format-host";
import { applyRename, deriveTag } from "../src/refactor/index";
import type { ProjectConfig } from "@jxsuite/schema/types";

let root = "";
const tmpRoots: string[] = [];

function write(rel: string, content: string): void {
  const fp = join(root, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, content);
}

const read = (rel: string) => readFileSync(join(root, rel), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jx-refactor-"));
  tmpRoots.push(root);
});

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("deriveTag", () => {
  test.each([
    ["/p/my-counter.json", "my-counter"],
    ["/p/my-counter.class.json", "my-counter"],
    ["/p/widget.md", "widget"],
  ])("%s -> %s", (input, out) => {
    expect(deriveTag(input)).toBe(out);
  });
});

describe("applyRename", () => {
  test("component rename rewrites path refs, auto-renames the tag, and reports errors", async () => {
    write(
      "pages/index.json",
      JSON.stringify({
        $layout: "layouts/base.json",
        children: [{ $ref: "../components/counter.json" }],
      }),
    );
    write("pages/about.json", JSON.stringify({ children: [{ tagName: "my-counter" }] }));
    write(
      "components/counter.json",
      JSON.stringify({ children: [{ tagName: "span" }], tagName: "my-counter" }),
    );
    write("broken.json", "{ not valid json ");

    renameSync(join(root, "components/counter.json"), join(root, "components/my-button.json"));
    const registry = await buildProjectFormatRegistry(root);
    const report = await applyRename({
      absFrom: join(root, "components/counter.json"),
      absTo: join(root, "components/my-button.json"),
      registry,
      root,
    });

    // Path reference updated.
    expect(JSON.parse(read("pages/index.json")).children[0]).toEqual({
      $ref: "../components/my-button.json",
    });
    expect(JSON.parse(read("pages/index.json")).$layout).toBe("layouts/base.json");
    // Tag renamed in the instance and in the component's own definition.
    expect(JSON.parse(read("pages/about.json")).children[0].tagName).toBe("my-button");
    expect(JSON.parse(read("components/my-button.json")).tagName).toBe("my-button");

    expect(report.references.refsUpdated).toBe(1);
    expect(report.tag).toMatchObject({ from: "my-counter", refsUpdated: 2, to: "my-button" });
    expect(report.errors.map((e) => e.path)).toContain("broken.json");
    expect(report.isDir).toBe(false);
  });

  test("page rename updates references without a tag pass", async () => {
    write("pages/home.json", JSON.stringify({ children: [{ $ref: "./detail.json" }] }));
    write("pages/detail.json", JSON.stringify({ children: [] }));

    renameSync(join(root, "pages/detail.json"), join(root, "pages/info.json"));
    const registry = await buildProjectFormatRegistry(root);
    const report = await applyRename({
      absFrom: join(root, "pages/detail.json"),
      absTo: join(root, "pages/info.json"),
      registry,
      root,
    });

    expect(JSON.parse(read("pages/home.json")).children[0]).toEqual({ $ref: "./info.json" });
    expect(report.references.refsUpdated).toBe(1);
    expect(report.tag).toBeUndefined();
  });

  test("rewrites asset references inside content-format files via the registry", async () => {
    // Use a tests/-local root so the throwaway format implementation (.js) is excluded from coverage.
    root = join(import.meta.dir, "_refactor_content_fix");
    rmSync(root, { force: true, recursive: true });
    tmpRoots.push(root);
    write(
      "Toy.class.json",
      JSON.stringify({
        $defs: {
          methods: {
            parse: {
              $prototype: "Function",
              identifier: "parse",
              parameters: [{ identifier: "source", type: { type: "string" } }],
              role: "parse",
              scope: "static",
              timing: ["compiler", "server", "client"],
            },
            serialize: {
              $prototype: "Function",
              identifier: "serialize",
              parameters: [{ identifier: "doc", type: { type: "object" } }],
              role: "serialize",
              scope: "static",
              timing: ["compiler", "server", "client"],
            },
          },
        },
        $implementation: "./toy-impl.js",
        $prototype: "Class",
        extends: "Object",
        format: { documentKinds: ["content"], extensions: [".toy"] },
        title: "Toy",
      }),
    );
    write(
      "toy-impl.js",
      [
        "export class Toy {",
        "  static parse(source) { return { children: [{ src: source.trim(), tagName: 'img' }] }; }",
        "  static serialize(doc) { return doc.children[0].src; }",
        "}",
        "",
      ].join("\n"),
    );
    write("img/old.png", "binary");
    write("content/banner.toy", "../img/old.png");

    const config = { imports: { Toy: "./Toy.class.json" } } as ProjectConfig;
    renameSync(join(root, "img/old.png"), join(root, "img/new.png"));
    const registry = await buildProjectFormatRegistry(root, config);
    const report = await applyRename({
      absFrom: join(root, "img/old.png"),
      absTo: join(root, "img/new.png"),
      registry,
      root,
    });

    expect(read("content/banner.toy")).toBe("../img/new.png");
    expect(report.references.files.some((f) => f.path === "content/banner.toy")).toBe(true);
  });
});
