/**
 * The emitted `project.json` must satisfy the schema every project is validated against.
 *
 * This is a regression gate with a specific history. The emitter wrote `title`, `description` and
 * `$style` — none of them keys `project.core.schema.json` declares — and every generated
 * per-project `project.schema.json` closes its composition with `unevaluatedProperties: false`. So
 * an imported project failed its own schema on three counts, and because Studio's Contexts editor
 * validates the WHOLE config before saving, the base width of an imported site could not be changed
 * at all. The message was `(root): must NOT have unevaluated properties`, three times, naming
 * nothing.
 *
 * The schema is GENERATED here, by the same `emitProjectSchema` a real `jx schema` run uses, and
 * checked by the same `validateProjectFile` the CLI uses. Validating against the shipped
 * `project-schema.json` instead would prove nothing: that file is the OPEN core fragment, and it
 * accepts exactly the input that broke.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitProjectSchema } from "@jxsuite/schema/project-schemas";
import { validateProjectFile } from "@jxsuite/schema/validate-project";
import { emitMultiPageProject } from "../src/emit.ts";
import { createLocalIo } from "../src/io.ts";
import type { MultiEmitOptions } from "../src/emit.ts";
import type { JxElement } from "@jxsuite/schema/types";

/** Where a project's own entry schema points at the core fragment it composes over. */
const CORE_REF = "./node_modules/@jxsuite/schema/schemas/project.core.schema.json";

/**
 * Emit a project into a fresh directory, give it the entry schema `jx schema` would have written,
 * and hand back what the project validator says about the pair.
 */
async function emitAndValidate(
  options: Omit<MultiEmitOptions, "io">,
): Promise<{ dir: string; project: Record<string, unknown>; errors: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "jx-import-schema-"));
  await emitMultiPageProject({ ...options, io: createLocalIo(dir) });
  await Bun.write(
    join(dir, "project.schema.json"),
    `${JSON.stringify(emitProjectSchema({ corePath: CORE_REF, fragments: [] }), null, 2)}\n`,
  );
  const result = await validateProjectFile(dir);
  return {
    dir,
    errors: (result.errors ?? []).map((error) => describeError(error)),
    project: (await Bun.file(join(dir, "project.json")).json()) as Record<string, unknown>,
  };
}

/** The same formatting Studio's `jx-validate.ts` shows a person, so a failure reads as they saw it. */
function describeError(error: unknown): string {
  const e = error as { instancePath?: string; message?: string; params?: Record<string, unknown> };
  const property = e.params?.unevaluatedProperty;
  return (
    `${e.instancePath || "(root)"}: ${e.message}` +
    `${property === undefined ? "" : ` (${String(property)})`}`
  );
}

const ONE_PAGE = new Map([["pages/index.json", { tagName: "div" } as JxElement]]);

describe("the emitted project.json", () => {
  test("validates, with everything an import can put in it", async () => {
    const { dir, errors } = await emitAndValidate({
      title: "Example Site",
      sourceUrl: "https://example.com",
      pages: ONE_PAGE,
      breakpoints: { "--1390": "(min-width: 1390px)", "--520": "(max-width: 520px)" },
      baseWidth: 1440,
      styleTokens: { "--brand": "#3b82f6" },
      fontFaceRules: ['@font-face { font-family: "A"; src: url(https://cdn.example/a.woff2); }'],
    });
    try {
      expect(errors).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("names the project, and writes none of the three keys that used to break it", async () => {
    const { dir, project } = await emitAndValidate({
      title: "Example Site",
      sourceUrl: "https://example.com",
      pages: ONE_PAGE,
    });
    try {
      expect(project.name).toBe("Example Site");
      expect(project.title).toBeUndefined();
      expect(project.description).toBeUndefined();
      expect(project.$style).toBeUndefined();
      /* And the source URL is not smuggled into `$head` either. That meta is the site's own
         user-facing description; "Imported from …" is provenance, and the importer reports it. */
      expect(JSON.stringify(project)).not.toContain("https://example.com");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("the three keys that used to break it are each caught by this gate", async () => {
    const { dir, errors } = await emitAndValidate({
      title: "Example Site",
      sourceUrl: "https://example.com",
      pages: ONE_PAGE,
    });
    try {
      // Reintroduce exactly what the emitter used to write, and confirm the gate would have said so.
      const project = (await Bun.file(join(dir, "project.json")).json()) as Record<string, unknown>;
      expect(errors).toEqual([]);
      await Bun.write(
        join(dir, "project.json"),
        JSON.stringify({
          ...project,
          title: "Example Site",
          description: "Imported from https://example.com",
          $style: { "--brand": "#3b82f6" },
        }),
      );
      const regression = await validateProjectFile(dir);
      expect((regression.errors ?? []).map((e) => describeError(e))).toEqual([
        "(root): must NOT have unevaluated properties (title)",
        "(root): must NOT have unevaluated properties (description)",
        "(root): must NOT have unevaluated properties ($style)",
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("writes the base width and sorts the breakpoints ascending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-media-"));
    try {
      await emitMultiPageProject({
        io: createLocalIo(dir),
        title: "Ordered",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" } as JxElement]]),
        // The order a crawl merges them in, which is not an order.
        breakpoints: {
          "--1390": "(min-width: 1390px)",
          "--520": "(max-width: 520px)",
          "--782": "(min-width: 782px)",
        },
        baseWidth: 1440,
      });
      const project = await Bun.file(join(dir, "project.json")).json();
      expect(Object.keys(project.$media)).toEqual(["--", "--520", "--782", "--1390"]);
      expect(project.$media["--"]).toBe("1440px");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("emits no $media at all when nothing was found and no base was given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-media-"));
    try {
      await emitMultiPageProject({
        io: createLocalIo(dir),
        title: "Plain",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" } as JxElement]]),
      });
      const project = await Bun.file(join(dir, "project.json")).json();
      expect(project.$media).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("the emitted documents", () => {
  test("carry no class names from the source site, anywhere", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-classes-"));
    try {
      const card = (title: string): JxElement => ({
        tagName: "article",
        attributes: { class: "card card--featured" },
        children: [
          { tagName: "h3", attributes: { class: "card__title" }, textContent: title },
          { tagName: "p", attributes: { class: "card__body" }, textContent: "Body" },
        ],
      });
      const page: JxElement = {
        tagName: "div",
        attributes: { class: "page" },
        children: [card("One"), card("Two")],
      };

      const { files, classesStripped } = await emitMultiPageProject({
        io: createLocalIo(dir),
        title: "Classy",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", page]]),
        layout: {
          tagName: "div",
          attributes: { class: "layout" },
          children: [{ tagName: "slot" }],
        },
      });

      expect(classesStripped).toBeGreaterThan(0);
      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }
        expect(await Bun.file(join(dir, file)).text()).not.toContain('"class"');
      }
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("a class that differs between instances does not become a component prop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-classprop-"));
    try {
      const card = (title: string, extra: string): JxElement => ({
        tagName: "article",
        attributes: { class: `card ${extra}` },
        children: [
          { tagName: "h3", textContent: title },
          { tagName: "p", textContent: "Body" },
        ],
      });
      await emitMultiPageProject({
        io: createLocalIo(dir),
        title: "Props",
        sourceUrl: "https://example.com",
        pages: new Map([
          [
            "pages/index.json",
            { tagName: "div", children: [card("One", "is-first"), card("Two", "is-second")] },
          ],
        ]),
      });

      const comp = await Bun.file(join(dir, "components", "component-article-0.json")).json();
      expect(Object.keys(comp.state ?? {})).not.toContain("class");
      expect(JSON.stringify(comp)).not.toContain("state.class");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
