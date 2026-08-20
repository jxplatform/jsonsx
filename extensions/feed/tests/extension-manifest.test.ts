/**
 * Extension-package surface tests (specs/extensions.md §4–§5, mirroring
 * extensions/search/tests/extension-manifest.test.ts): the manifest validates against the generated
 * extension-manifest schema, the Feed class descriptor exists and carries the expected admission
 * blocks (feed section owner with projectData + head + emit), and the project fragment is a
 * standalone-valid 2020-12 document contributing the `feed` section.
 *
 * Feed was the only extension without this file, and the absence is why three defects landed
 * together: an $id that broke the shared shape, a fragment nothing exercised, and an enum value the
 * implementation never honoured. Each of the three is pinned below.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { normalizeFeedConfig } from "../src/shared.js";

const require = createRequire(import.meta.url);

const MANIFEST_PATH = resolve(import.meta.dir, "../jx-extension.json");

function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const manifest = loadJson(MANIFEST_PATH) as {
  name: string;
  title: string;
  classes: Record<string, string>;
  schemas: { project: string };
};

describe("jx-extension.json manifest", () => {
  test("validates against the extension-manifest schema", () => {
    const schema = loadJson(require.resolve("@jxsuite/schema/extension-manifest.schema.json"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    expect(validate(manifest)).toBe(true);
  });

  test("carries the package name and is wired through package.json", () => {
    const pkg = loadJson(resolve(import.meta.dir, "../package.json")) as {
      name: string;
      jx: string;
      exports: Record<string, string>;
      files: string[];
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe(pkg.name);
    expect(pkg.jx).toBe("./jx-extension.json");
    expect(pkg.exports["./jx-extension.json"]).toBe("./jx-extension.json");
    expect(pkg.exports["./schemas/project.fragment.schema.json"]).toBeDefined();
    expect(pkg.files).toContain("jx-extension.json");
    expect(pkg.files).toContain("schemas/");
    expect(pkg.dependencies["@jxsuite/schema"]).toBe("workspace:^");
    // Every class descriptor is addressable through the exports map.
    for (const ref of Object.values(manifest.classes)) {
      const exportKey = ref.replace("./src/", "./");
      expect(pkg.exports[exportKey]).toBe(ref);
    }
  });

  test("every classes entry points at an existing descriptor", () => {
    expect(Object.keys(manifest.classes).toSorted()).toEqual(["Feed"]);
    for (const ref of Object.values(manifest.classes)) {
      const classPath = resolve(dirname(MANIFEST_PATH), ref);
      expect(existsSync(classPath)).toBe(true);
    }
  });

  test("admission blocks: the feed section owner declares projectData, head, and emit", () => {
    const feed = loadJson(resolve(dirname(MANIFEST_PATH), manifest.classes.Feed!)) as {
      project?: { key: string };
      $defs: { methods: Record<string, { role?: string; timing?: string[] }> };
    };

    expect(feed.project?.key).toBe("feed");
    expect(feed.$defs.methods.projectData?.role).toBe("projectData");
    // The only capability that also runs on the server — the dev server needs _project.feed.
    expect(feed.$defs.methods.projectData?.timing).toEqual(["compiler", "server"]);
    expect(feed.$defs.methods.head?.role).toBe("head");
    expect(feed.$defs.methods.head?.timing).toEqual(["compiler"]);
    expect(feed.$defs.methods.emit?.role).toBe("emit");
    expect(feed.$defs.methods.emit?.timing).toEqual(["compiler"]);
  });
});

describe("project fragment", () => {
  const fragment = loadJson(resolve(import.meta.dir, "../schemas/project.fragment.schema.json"));

  test("is a standalone-valid 2020-12 schema contributing the feed section", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(fragment);
    expect(typeof validate).toBe("function");
    expect(fragment.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Object.keys(fragment.properties as Record<string, unknown>)).toEqual(["feed"]);
  });

  test("carries the shared first-party fragment $id shape (specs/extensions.md §5.1)", () => {
    /*
     * The shape is ext/<extension>/<kind>/v<n>. This assertion is the one every sibling fragment
     * has and feed did not, which is how it drifted to `schema/extensions/feed/v1` unnoticed.
     */
    expect(fragment.$id).toBe("https://jxsuite.com/schema/ext/feed/project/v1");
  });

  test("accepts a typical section and rejects malformed ones", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(fragment);

    expect(validate({ feed: { blog: { collection: "posts", basePath: "/blog/" } } })).toBe(true);

    // At least one feed
    expect(validate({ feed: {} })).toBe(false);
    // Both required keys
    expect(validate({ feed: { blog: { basePath: "/blog/" } } })).toBe(false);
    expect(validate({ feed: { blog: { collection: "posts" } } })).toBe(false);
    // A rooted basePath
    expect(validate({ feed: { blog: { collection: "posts", basePath: "blog/" } } })).toBe(false);
    // Unknown per-feed key
    expect(validate({ feed: { blog: { collection: "posts", basePath: "/b/", nope: 1 } } })).toBe(
      false,
    );
    // Unknown format — RSS is deliberately not offered
    expect(
      validate({ feed: { blog: { collection: "posts", basePath: "/b/", formats: ["rss"] } } }),
    ).toBe(false);
  });

  test("rejects the contentMode value the implementation never honoured", () => {
    /*
     * `none` was in the enum and did nothing: entryToItem branches on "full" alone, so it
     * produced byte-identical output to "summary". Removed rather than implemented, because
     * JSON Feed 1.1 requires one of content_html/content_text — a true "none" was never
     * expressible there anyway.
     */
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(fragment);
    const withMode = (contentMode: string) => ({
      feed: { blog: { collection: "posts", basePath: "/b/", contentMode } },
    });

    expect(validate(withMode("full"))).toBe(true);
    expect(validate(withMode("summary"))).toBe(true);
    expect(validate(withMode("none"))).toBe(false);
  });

  test("the fragment's declared defaults are the ones the runtime actually applies", () => {
    /*
     * Two lists of defaults, kept by hand in different languages, and nothing compared them.
     * Driving both paths beats asserting against the DEFAULTS constant, because it compares what
     * a consumer actually observes: ajv injects the schema's defaults, normalizeFeedConfig the
     * runtime's. Where the fragment declares a default, the two must agree.
     */
    const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
    const validate = ajv.compile(fragment);

    const fromSchema = { feed: { blog: { collection: "posts", basePath: "/blog/" } } };
    expect(validate(fromSchema)).toBe(true);

    const fromRuntime = normalizeFeedConfig({ blog: { collection: "posts", basePath: "/blog/" } });

    const properties = fragment.properties as Record<
      string,
      { additionalProperties: { properties: Record<string, { default?: unknown }> } }
    >;
    const declared = properties.feed!.additionalProperties.properties;
    const keysWithDefaults = Object.entries(declared)
      .filter(([, schema]) => "default" in schema)
      .map(([key]) => key);

    // If this list shrinks, a default was dropped from the schema and this test stops covering it.
    expect(keysWithDefaults.toSorted()).toEqual([
      "archive",
      "contentMode",
      "dateField",
      "formats",
      "output",
      "pageSize",
      "updatedField",
    ]);

    const injected = fromSchema.feed.blog as unknown as Record<string, unknown>;
    const normalized = fromRuntime.blog as unknown as Record<string, unknown>;
    for (const key of keysWithDefaults) {
      expect({ [key]: injected[key] }).toEqual({ [key]: normalized[key] });
    }
  });
});
