import { afterAll, describe, expect, test } from "bun:test";
import { handleStudioApi } from "../src/studio-api";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * Test helper — calls handleStudioApi and asserts a response was returned.
 *
 * @param {Request} req
 * @param {URL} url
 * @param {string} root
 * @param {string | null} [activeProjectRoot]
 * @returns {Promise<Response>}
 */
async function callApi(
  req: Request,
  url: URL,
  root: string,
  activeProjectRoot: string | null = null,
) {
  const res = await handleStudioApi(req, url, root, activeProjectRoot);
  if (!res) {
    throw new Error("handleStudioApi returned null");
  }
  return res;
}

const FIXTURES = resolve(import.meta.dir, "_studio_fixtures");
mkdirSync(FIXTURES, { recursive: true });

// Simple .class.json for direct path resolution
const simpleClass = {
  $defs: {
    constructor: {
      $prototype: "Function",
      parameters: [{ $ref: "#/$defs/parameters/url" }],
      role: "constructor",
    },
    fields: {
      cache: {
        access: "public",
        default: {},
        description: "Internal cache",
        identifier: "cache",
        role: "field",
        scope: "instance",
        type: { type: "object" },
      },
      secret: {
        access: "private",
        identifier: "secret",
        role: "field",
        scope: "instance",
      },
    },
    parameters: {
      debug: {
        description: "Enable debug mode",
        identifier: "debug",
        type: { default: false, type: "boolean" },
      },
      limit: {
        description: "Max results",
        identifier: "limit",
        type: { default: 10, type: "integer" },
      },
      url: {
        description: "API endpoint URL",
        examples: ["https://api.example.com"],
        identifier: "url",
        type: { type: "string" },
      },
    },
  },
  $prototype: "Class",
  description: "A test data source",
  title: "DataSource",
};
writeFileSync(join(FIXTURES, "DataSource.class.json"), JSON.stringify(simpleClass), "utf8");

// Parent .class.json for extends testing
const parentClass = {
  $defs: {
    constructor: {
      $prototype: "Function",
      parameters: [{ $ref: "#/$defs/parameters/src" }],
      role: "constructor",
    },
    parameters: {
      sortBy: {
        description: "Sort field",
        identifier: "sortBy",
        type: { type: "string" },
      },
      src: {
        description: "Source path",
        identifier: "src",
        type: { type: "string" },
      },
    },
  },
  $prototype: "Class",
  description: "Base collection class",
  title: "BaseCollection",
};
writeFileSync(join(FIXTURES, "BaseCollection.class.json"), JSON.stringify(parentClass), "utf8");

// Child .class.json extending parent
const childClass = {
  $defs: {
    parameters: {
      category: {
        description: "Filter by category",
        identifier: "category",
        type: { type: "string" },
      },
    },
  },
  $prototype: "Class",
  description: "Posts collection",
  extends: { $ref: "./BaseCollection.class.json" },
  title: "PostCollection",
};
writeFileSync(join(FIXTURES, "PostCollection.class.json"), JSON.stringify(childClass), "utf8");

// Class with `returns` on resolve method
const classWithReturns = {
  $defs: {
    constructor: {
      $prototype: "Function",
      parameters: [{ $ref: "#/$defs/parameters/contentType" }],
      role: "constructor",
    },
    methods: {
      resolve: {
        $prototype: "Function",
        access: "public",
        description: "Query entries",
        identifier: "resolve",
        parameters: [],
        returns: { type: "array" },
        role: "method",
        scope: "instance",
      },
    },
    parameters: {
      contentType: {
        description: "Content type to query",
        identifier: "contentType",
        type: { type: "string" },
      },
    },
  },
  $prototype: "Class",
  description: "A collection that returns an array",
  title: "ContentCollection",
};
writeFileSync(
  join(FIXTURES, "ContentCollection.class.json"),
  JSON.stringify(classWithReturns),
  "utf8",
);

// Class with resolve method but NO returns annotation
const classWithoutReturns = {
  $defs: {
    methods: {
      resolve: {
        $prototype: "Function",
        access: "public",
        description: "Emit event",
        identifier: "resolve",
        parameters: [],
        role: "method",
        scope: "instance",
      },
    },
    parameters: {
      channel: {
        description: "Channel name",
        identifier: "channel",
        type: { type: "string" },
      },
    },
  },
  $prototype: "Class",
  description: "Emitter with no declared return type",
  title: "EventEmitter",
};
writeFileSync(
  join(FIXTURES, "EventEmitter.class.json"),
  JSON.stringify(classWithoutReturns),
  "utf8",
);

// Class with returns on resolve that has a complex schema
const classWithComplexReturns = {
  $defs: {
    methods: {
      resolve: {
        $prototype: "Function",
        access: "public",
        identifier: "resolve",
        parameters: [],
        returns: {
          items: { properties: { id: { type: "string" } }, type: "object" },
          type: "array",
        },
        role: "method",
        scope: "instance",
      },
    },
    parameters: {
      query: { identifier: "query", type: { type: "string" } },
    },
  },
  $prototype: "Class",
  description: "Returns items with a schema",
  title: "TypedQuery",
};
writeFileSync(
  join(FIXTURES, "TypedQuery.class.json"),
  JSON.stringify(classWithComplexReturns),
  "utf8",
);

// Parent class with returns, to test inheritance
const parentWithReturns = {
  $defs: {
    constructor: {
      $prototype: "Function",
      parameters: [{ $ref: "#/$defs/parameters/src" }],
      role: "constructor",
    },
    methods: {
      resolve: {
        $prototype: "Function",
        identifier: "resolve",
        parameters: [],
        returns: { type: "array" },
        role: "method",
      },
    },
    parameters: {
      src: { identifier: "src", type: { type: "string" } },
    },
  },
  $prototype: "Class",
  description: "Base query returning array",
  title: "BaseQuery",
};
writeFileSync(join(FIXTURES, "BaseQuery.class.json"), JSON.stringify(parentWithReturns), "utf8");

// Child that extends parent with returns but has no own resolve method
const childNoResolve = {
  $defs: {
    parameters: {
      filter: { identifier: "filter", type: { type: "string" } },
    },
  },
  $prototype: "Class",
  description: "Child without own resolve",
  extends: { $ref: "./BaseQuery.class.json" },
  title: "ChildQuery",
};
writeFileSync(join(FIXTURES, "ChildQuery.class.json"), JSON.stringify(childNoResolve), "utf8");

// Class with format: "json-schema" type parameter
const parameterizedClass = {
  $defs: {
    constructor: {
      $prototype: "Function",
      parameters: [{ $ref: "#/$defs/parameters/src" }],
      role: "constructor",
    },
    parameters: {
      itemSchema: {
        description: "Schema for collection items",
        format: "json-schema",
        identifier: "itemSchema",
        type: { type: "object" },
      },
      src: { identifier: "src", type: { type: "string" } },
    },
  },
  $prototype: "Class",
  title: "TypedCollection",
};
writeFileSync(
  join(FIXTURES, "TypedCollection.class.json"),
  JSON.stringify(parameterizedClass),
  "utf8",
);

// Sibling JS module with a companion .class.json
writeFileSync(join(FIXTURES, "parser.js"), "export class Parser {}", "utf8");
const siblingClassJson = {
  $defs: {
    parameters: {
      input: {
        description: "Input text",
        identifier: "input",
        type: { type: "string" },
      },
    },
  },
  $prototype: "Class",
  description: "Sibling auto-discovered schema",
  title: "Parser",
};
writeFileSync(join(FIXTURES, "Parser.class.json"), JSON.stringify(siblingClassJson), "utf8");

// Helper: create a studio API request for plugin-schema
/**
 * @param {string} src
 * @param {string} [prototype]
 * @param {string} [base]
 */
function schemaRequest(src: string, prototype?: string, base?: string) {
  const params = new URLSearchParams({ src });
  if (prototype) {
    params.set("prototype", prototype);
  }
  if (base) {
    params.set("base", base);
  }
  const url = new URL(`http://localhost/__studio/plugin-schema?${params}`);
  return {
    req: new Request(url, { method: "GET" }),
    url,
  };
}

// ─── extractStudioSchema — direct .class.json path ──────────────────────────

describe("plugin-schema — direct .class.json path", () => {
  test("extracts parameters as properties", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/DataSource.class.json`, "DataSource");
    const res = await callApi(req, url, import.meta.dir);
    expect(res).not.toBeNull();
    const { schema } = await res.json();
    expect(schema.properties.url).toEqual({
      description: "API endpoint URL",
      examples: ["https://api.example.com"],
      type: "string",
    });
    expect(schema.properties.limit).toEqual({
      default: 10,
      description: "Max results",
      type: "integer",
    });
    expect(schema.properties.debug).toEqual({
      default: false,
      description: "Enable debug mode",
      type: "boolean",
    });
  });

  test("includes public fields but excludes private fields", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/DataSource.class.json`, "DataSource");
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.properties.cache).toBeDefined();
    expect(schema.properties.cache.description).toBe("Internal cache");
    expect(schema.properties.secret).toBeUndefined();
  });

  test("determines required from constructor parameters without defaults", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/DataSource.class.json`, "DataSource");
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.required).toContain("url");
    expect(schema.required).not.toContain("limit"); // Has default: 10
    expect(schema.required).not.toContain("debug"); // Has default: false
  });
});

// ─── extractStudioSchema — extends inheritance ──────────────────────────────

describe("plugin-schema — extends inheritance", () => {
  test("child inherits parent parameters", async () => {
    const { req, url } = schemaRequest(
      `./_studio_fixtures/PostCollection.class.json`,
      "PostCollection",
    );
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.description).toBe("Posts collection");
    // Parent parameters
    expect(schema.properties.src).toBeDefined();
    expect(schema.properties.sortBy).toBeDefined();
    // Child parameter
    expect(schema.properties.category).toBeDefined();
  });

  test("child inherits parent required fields", async () => {
    const { req, url } = schemaRequest(
      `./_studio_fixtures/PostCollection.class.json`,
      "PostCollection",
    );
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    // Src is required from parent (no default)
    expect(schema.required).toContain("src");
  });
});

// ─── extractStudioSchema — format: "json-schema" passthrough ────────────────

describe("plugin-schema — format: json-schema", () => {
  test("preserves format: json-schema annotation", async () => {
    const { req, url } = schemaRequest(
      `./_studio_fixtures/TypedCollection.class.json`,
      "TypedCollection",
    );
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.properties.itemSchema.format).toBe("json-schema");
    expect(schema.properties.itemSchema.description).toBe("Schema for collection items");
  });
});

// ─── plugin-schema — sibling .class.json auto-discovery ─────────────────────

describe("plugin-schema — sibling auto-discovery", () => {
  test("discovers .class.json next to .js module", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/parser.js`, "Parser");
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema).not.toBeNull();
    expect(schema.description).toBe("Sibling auto-discovered schema");
    expect(schema.properties.input).toBeDefined();
  });
});

// ─── plugin-schema — error handling ─────────────────────────────────────────

describe("plugin-schema — errors", () => {
  test("returns 400 when src param is missing", async () => {
    const url = new URL("http://localhost/__studio/plugin-schema");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    expect(res.status).toBe(400);
  });

  test("returns null schema for nonexistent .class.json", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/Nonexistent.class.json`, "Nonexistent");
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.schema).toBeNull();
  });
});

// ─── project-info endpoint ───────────────────────────────────────────────────

// Set up a fake site-project fixture
const SITE_PROJECT = join(FIXTURES, "my-site");
mkdirSync(join(SITE_PROJECT, "pages"), { recursive: true });
mkdirSync(join(SITE_PROJECT, "layouts"), { recursive: true });
mkdirSync(join(SITE_PROJECT, "components"), { recursive: true });
writeFileSync(
  join(SITE_PROJECT, "project.json"),
  JSON.stringify({ name: "Test Site", url: "https://test.dev" }),
  "utf8",
);

// Non-site project fixture (just a plain directory)
const PLAIN_DIR = join(FIXTURES, "plain-dir");
mkdirSync(PLAIN_DIR, { recursive: true });
writeFileSync(join(PLAIN_DIR, "readme.txt"), "hello", "utf8");

// Component fixture inside site project
writeFileSync(
  join(SITE_PROJECT, "components", "my-card.json"),
  JSON.stringify({
    state: { title: { default: "", type: "string" } },
    tagName: "my-card",
  }),
  "utf8",
);

// Component fixture with named + default slots and fallback content
writeFileSync(
  join(SITE_PROJECT, "components", "my-panel.json"),
  JSON.stringify({
    children: [
      {
        attributes: { name: "header" },
        children: [{ tagName: "h2", textContent: "Default title" }],
        tagName: "slot",
      },
      { children: ["Default body"], tagName: "slot" },
    ],
    tagName: "my-panel",
  }),
  "utf8",
);

function projectInfoRequest(dir: string) {
  const params = new URLSearchParams();
  if (dir) {
    params.set("dir", dir);
  }
  const url = new URL(`http://localhost/__studio/project-info?${params}`);
  return { req: new Request(url, { method: "GET" }), url };
}

describe("project-info", () => {
  test("detects a site project with project.json", async () => {
    const { req, url } = projectInfoRequest("_studio_fixtures/my-site");
    const res = await callApi(req, url, import.meta.dir);
    expect(res).not.toBeNull();
    const data = await res.json();
    expect(data.isSiteProject).toBe(true);
    expect(data.projectConfig.name).toBe("Test Site");
    expect(data.directories).toContain("pages");
    expect(data.directories).toContain("layouts");
    expect(data.directories).toContain("components");
  });

  test("returns isSiteProject false for plain directory", async () => {
    const { req, url } = projectInfoRequest("_studio_fixtures/plain-dir");
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.isSiteProject).toBe(false);
    expect(data.projectConfig).toBeNull();
  });

  test("rejects directory traversal", async () => {
    const { req, url } = projectInfoRequest("../../etc");
    const res = await callApi(req, url, import.meta.dir);
    expect(res.status).toBe(400);
  });

  test("defaults to current dir when no dir param", async () => {
    const url = new URL("http://localhost/__studio/project-info");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.projectRoot).toBe(import.meta.dir.replaceAll("\\", "/"));
  });
});

// ─── sites discovery endpoint ────────────────────────────────────────────────

describe("sites discovery", () => {
  test("discovers site projects with project.json", async () => {
    const url = new URL("http://localhost/__studio/sites");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    expect(res).not.toBeNull();
    const sites = await res.json();
    const testSite = sites.find((s: Record<string, any>) => s.config.name === "Test Site");
    expect(testSite).toBeDefined();
    expect(testSite.path).toBe(
      resolve(import.meta.dir, "_studio_fixtures/my-site").replaceAll("\\", "/"),
    );
    expect(testSite.config.url).toBe("https://test.dev");
  });

  test("does not include directories without project.json", async () => {
    const url = new URL("http://localhost/__studio/sites");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const sites = await res.json();
    expect(sites.every((s: Record<string, any>) => s.path !== "_studio_fixtures/plain-dir")).toBe(
      true,
    );
  });
});

// ─── components?dir= scoped scan ─────────────────────────────────────────────

describe("components — scoped scan", () => {
  test("finds components under a specific directory", async () => {
    const url = new URL("http://localhost/__studio/components?dir=_studio_fixtures/my-site");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    expect(res).not.toBeNull();
    const components = await res.json();
    expect(components.length).toBeGreaterThanOrEqual(1);
    expect(components.some((c: Record<string, any>) => c.tagName === "my-card")).toBe(true);
  });

  test("returns empty for directory with no components", async () => {
    const url = new URL("http://localhost/__studio/components?dir=_studio_fixtures/plain-dir");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const components = await res.json();
    expect(components).toEqual([]);
  });

  test("extracts slot definitions with fallback children", async () => {
    const url = new URL("http://localhost/__studio/components?dir=_studio_fixtures/my-site");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const components = await res.json();
    const panel = components.find((c: Record<string, any>) => c.tagName === "my-panel");
    expect(panel).toBeDefined();
    expect(panel.slots).toEqual([
      {
        fallback: [{ tagName: "h2", textContent: "Default title" }],
        name: "header",
      },
      { fallback: ["Default body"], name: "" },
    ]);
    // Slotless components omit the key entirely
    const card = components.find((c: Record<string, any>) => c.tagName === "my-card");
    expect(card.slots).toBeUndefined();
  });

  test("rejects directory traversal on dir param", async () => {
    const url = new URL("http://localhost/__studio/components?dir=../../etc");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    expect(res.status).toBe(400);
  });
});

// ─── file read/write/delete endpoints ───────────────────────────────────────

describe("file — read", () => {
  test("reads a file within project root", async () => {
    writeFileSync(join(FIXTURES, "hello.txt"), "world", "utf8");
    const url = new URL(`http://localhost/__studio/file?path=${FIXTURES}/hello.txt`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe("world");
  });

  test("returns 404 for nonexistent file", async () => {
    const url = new URL(`http://localhost/__studio/file?path=${FIXTURES}/nonexistent.txt`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(404);
  });

  test("returns 400 when path param is missing", async () => {
    const url = new URL("http://localhost/__studio/file");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("rejects path outside project root", async () => {
    const url = new URL(`http://localhost/__studio/file?path=/etc/passwd`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

describe("file — write", () => {
  test("writes a file within project root", async () => {
    const url = new URL(`http://localhost/__studio/file?path=write-test.txt`);
    const req = new Request(url, { body: "new content", method: "PUT" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("creates parent directories as needed", async () => {
    const url = new URL(`http://localhost/__studio/file?path=sub/deep/new.txt`);
    const req = new Request(url, { body: "deep content", method: "PUT" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("returns 400 when path is missing", async () => {
    const url = new URL("http://localhost/__studio/file");
    const req = new Request(url, { body: "x", method: "PUT" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

describe("file — upload", () => {
  // Upload creates directories that are not part of the committed fixture tree; drop them so a test
  // Run leaves the working copy clean.
  afterAll(() => {
    for (const dir of ["public", "content"]) {
      rmSync(join(FIXTURES, dir), { force: true, recursive: true });
    }
  });

  test("writes raw binary bytes, not a text transcode", async () => {
    // PNG magic + a 0x00 byte: a text round-trip would mangle both.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const url = new URL("http://localhost/__studio/file/upload?path=public/hero.png");
    const req = new Request(url, { body: bytes, method: "POST" });

    const res = await callApi(req, url, FIXTURES);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect([...readFileSync(join(FIXTURES, "public/hero.png"))]).toEqual([...bytes]);
  });

  test("creates parent directories as needed", async () => {
    const url = new URL("http://localhost/__studio/file/upload?path=content/blog/images/a.png");
    const req = new Request(url, { body: new Uint8Array([1]), method: "POST" });

    const res = await callApi(req, url, FIXTURES);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(existsSync(join(FIXTURES, "content/blog/images/a.png"))).toBe(true);
  });

  test("returns 400 when path is missing", async () => {
    const url = new URL("http://localhost/__studio/file/upload");
    const req = new Request(url, { body: new Uint8Array([1]), method: "POST" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("rejects a path that escapes the project root", async () => {
    const url = new URL("http://localhost/__studio/file/upload?path=../escaped.png");
    const req = new Request(url, { body: new Uint8Array([1]), method: "POST" });

    const res = await callApi(req, url, FIXTURES);

    expect(res.status).toBe(400);
    expect(existsSync(resolve(FIXTURES, "../escaped.png"))).toBe(false);
  });
});

describe("file — delete", () => {
  test("deletes a file within project root", async () => {
    writeFileSync(join(FIXTURES, "to-delete.txt"), "bye", "utf8");
    const url = new URL(`http://localhost/__studio/file?path=to-delete.txt`);
    const req = new Request(url, { method: "DELETE" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("returns 404 for nonexistent file", async () => {
    const url = new URL(`http://localhost/__studio/file?path=no-such-file.txt`);
    const req = new Request(url, { method: "DELETE" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(404);
  });

  test("returns 400 when path is missing", async () => {
    const url = new URL("http://localhost/__studio/file");
    const req = new Request(url, { method: "DELETE" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

describe("file — rename", () => {
  test("renames a file within project root", async () => {
    writeFileSync(join(FIXTURES, "old-name.txt"), "content", "utf8");
    const url = new URL("http://localhost/__studio/file/rename");
    const req = new Request(url, {
      body: JSON.stringify({ from: "old-name.txt", to: "new-name.txt" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.to).toBe("new-name.txt");
  });

  test("returns 400 for invalid JSON", async () => {
    const url = new URL("http://localhost/__studio/file/rename");
    const req = new Request(url, { body: "not json", method: "POST" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("returns 400 when from/to missing", async () => {
    const url = new URL("http://localhost/__studio/file/rename");
    const req = new Request(url, {
      body: JSON.stringify({ from: "only-from.txt" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

// ─── references endpoint ────────────────────────────────────────────────────

describe("references", () => {
  test("answers who refers to a path, as a file and as a tag", async () => {
    mkdirSync(join(FIXTURES, "refs-demo/components"), { recursive: true });
    mkdirSync(join(FIXTURES, "refs-demo/pages"), { recursive: true });
    writeFileSync(
      join(FIXTURES, "refs-demo/components/card.json"),
      JSON.stringify({ children: [], tagName: "ref-card" }),
      "utf8",
    );
    writeFileSync(
      join(FIXTURES, "refs-demo/pages/index.json"),
      JSON.stringify({ children: [{ $ref: "../components/card.json" }, { tagName: "ref-card" }] }),
      "utf8",
    );

    const root = join(FIXTURES, "refs-demo");
    const url = new URL("http://localhost/__studio/references?path=components%2Fcard.json");
    const res = await callApi(new Request(url, { method: "GET" }), url, root);
    const data = await res.json();
    expect(data.tagName).toBe("ref-card");
    expect(data.files.map((f: { path: string }) => f.path)).toEqual(["pages/index.json"]);
    expect(data.refsTotal).toBe(2);
  });

  test("returns 400 when neither path nor tag is given", async () => {
    const url = new URL("http://localhost/__studio/references");
    const res = await callApi(new Request(url, { method: "GET" }), url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("rejects a path outside the project root", async () => {
    const url = new URL("http://localhost/__studio/references?path=..%2F..%2Fetc%2Fpasswd");
    const res = await callApi(new Request(url, { method: "GET" }), url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

// ─── files listing endpoint ─────────────────────────────────────────────────

describe("files — listing", () => {
  test("lists files in directory", async () => {
    writeFileSync(join(FIXTURES, "listed.txt"), "x", "utf8");
    const url = new URL(`http://localhost/__studio/files?dir=${FIXTURES}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((f: Record<string, any>) => f.name === "listed.txt")).toBe(true);
  });

  test("lists files using glob pattern", async () => {
    const url = new URL(`http://localhost/__studio/files?dir=${FIXTURES}&glob=*.json`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.every((f: Record<string, any>) => f.name.endsWith(".json"))).toBe(true);
  });

  test("rejects directory traversal", async () => {
    const url = new URL("http://localhost/__studio/files?dir=../../etc");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

// ─── project endpoint ───────────────────────────────────────────────────────

describe("project endpoint", () => {
  test("returns project info from package.json", async () => {
    writeFileSync(join(FIXTURES, "package.json"), JSON.stringify({ name: "test-pkg" }), "utf8");
    const url = new URL("http://localhost/__studio/project");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.name).toBe("test-pkg");
    expect(data.root).toBe(FIXTURES);
  });

  test("falls back to directory basename when no package.json", async () => {
    const emptyDir = join(FIXTURES, "empty-proj");
    mkdirSync(emptyDir, { recursive: true });
    const url = new URL("http://localhost/__studio/project");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, emptyDir);
    const data = await res.json();
    expect(data.name).toBe("empty-proj");
  });
});

// ─── locate endpoint ────────────────────────────────────────────────────────

describe("locate endpoint", () => {
  test("locates a file by name", async () => {
    writeFileSync(join(FIXTURES, "findme.txt"), "found", "utf8");
    const url = new URL("http://localhost/__studio/locate");
    const req = new Request(url, {
      body: JSON.stringify({ name: "findme.txt" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.path).toContain("findme.txt");
  });

  test("returns null when file not found", async () => {
    const url = new URL("http://localhost/__studio/locate");
    const req = new Request(url, {
      body: JSON.stringify({ name: "nonexistent-xyz.txt" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.path).toBeNull();
  });

  test("returns 400 for invalid JSON", async () => {
    const url = new URL("http://localhost/__studio/locate");
    const req = new Request(url, { body: "bad", method: "POST" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("returns 400 when name is missing", async () => {
    const url = new URL("http://localhost/__studio/locate");
    const req = new Request(url, {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

// ─── unmatched endpoint returns null ────────────────────────────────────────

describe("unmatched endpoint", () => {
  test("returns null for unknown path", async () => {
    const url = new URL("http://localhost/__studio/unknown-route");
    const req = new Request(url, { method: "GET" });
    const res = await handleStudioApi(req, url, FIXTURES);
    expect(res).toBeNull();
  });
});

// ─── resolve-site endpoint ───────────────────────────────────────────────────

describe("resolve-site", () => {
  test("finds ancestor project.json for a file path", async () => {
    // SITE_PROJECT already has project.json at _studio_fixtures/my-site/project.json
    const filePath = resolve(FIXTURES, "my-site/pages/index.json");
    writeFileSync(filePath, JSON.stringify({ title: "test" }), "utf8");
    const url = new URL(
      `http://localhost/__studio/resolve-site?path=${encodeURIComponent(filePath)}`,
    );
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.sitePath).not.toBeNull();
    expect(data.projectConfig.name).toBe("Test Site");
  });

  test("accepts the project directory itself and targets its project.json", async () => {
    const dirPath = resolve(FIXTURES, "my-site");
    const url = new URL(
      `http://localhost/__studio/resolve-site?path=${encodeURIComponent(dirPath)}`,
    );
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.sitePath).toBe(dirPath);
    expect(data.fileRelPath).toBe("project.json");
    expect(data.projectConfig.name).toBe("Test Site");
  });

  test("accepts a subdirectory and walks up to the project root", async () => {
    const dirPath = resolve(FIXTURES, "my-site/pages");
    const url = new URL(
      `http://localhost/__studio/resolve-site?path=${encodeURIComponent(dirPath)}`,
    );
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.sitePath).toBe(resolve(FIXTURES, "my-site"));
    expect(data.fileRelPath).toBe("pages/project.json");
  });

  test("returns null when no project.json found", async () => {
    const filePath = "/tmp/no-project-here/somefile.json";
    const url = new URL(
      `http://localhost/__studio/resolve-site?path=${encodeURIComponent(filePath)}`,
    );
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.sitePath).toBeNull();
  });

  test("returns 400 when path is missing", async () => {
    const url = new URL("http://localhost/__studio/resolve-site");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

// ─── find-project endpoint ───────────────────────────────────────────────────

describe("find-project", () => {
  test("returns 400 when name is missing", async () => {
    const url = new URL("http://localhost/__studio/find-project");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.error).toBe("Missing name");
  });

  test("returns null path when project not found", async () => {
    const url = new URL("http://localhost/__studio/find-project?name=nonexistent-xyz-project-404");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.path).toBeNull();
  }, 15_000);
});

// ─── components — markdown discovery ────────────────────────────────────────

describe("components — markdown discovery", () => {
  // Set up md fixtures before tests run
  const MD_DIR = join(FIXTURES, "md-components");
  mkdirSync(MD_DIR, { recursive: true });

  // .md discovery requires a Markdown-providing extension in project.json "extensions"
  writeFileSync(
    join(MD_DIR, "project.json"),
    JSON.stringify({
      extensions: ["@jxsuite/parser"],
      name: "MD Components",
    }),
    "utf8",
  );

  // Valid Jx component markdown
  writeFileSync(join(MD_DIR, "my-widget.md"), `---\ntagName: my-widget\n---\n# Widget\n`, "utf8");

  // Markdown with no frontmatter — should be skipped
  writeFileSync(join(MD_DIR, "plain.md"), "# Just a doc\nNo frontmatter here.\n", "utf8");

  // Markdown with frontmatter but no tagName — should be skipped
  writeFileSync(join(MD_DIR, "no-tag.md"), `---\ntitle: Something\n---\n# Content\n`, "utf8");

  // Markdown with tagName but no hyphen — should be skipped
  writeFileSync(join(MD_DIR, "nohyphen.md"), `---\ntagName: widget\n---\n# Content\n`, "utf8");

  test("discovers valid Jx component from .md file", async () => {
    const url = new URL(`http://localhost/__studio/components?dir=${MD_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, MD_DIR);
    const components = await res.json();
    const widget = components.find((c: Record<string, any>) => c.tagName === "my-widget");
    expect(widget).toBeDefined();
    expect(widget.source).toBe("jx");
  });

  test("skips .md without frontmatter", async () => {
    const url = new URL(`http://localhost/__studio/components?dir=${MD_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, MD_DIR);
    const components = await res.json();
    expect((components as any[]).every((c: Record<string, any>) => c.path !== "plain.md")).toBe(
      true,
    );
  });
});

// ─── components — CEM npm discovery ─────────────────────────────────────────

describe("components — CEM npm discovery", () => {
  const CEM_DIR = join(FIXTURES, "cem-project");
  mkdirSync(join(CEM_DIR, "node_modules/test-elements"), { recursive: true });

  writeFileSync(
    join(CEM_DIR, "package.json"),
    JSON.stringify({
      dependencies: { "test-elements": "^1.0.0" },
      name: "cem-test",
    }),
    "utf8",
  );

  writeFileSync(
    join(CEM_DIR, "node_modules/test-elements/package.json"),
    JSON.stringify({
      customElements: "./custom-elements.json",
      name: "test-elements",
      version: "1.0.0",
    }),
    "utf8",
  );

  writeFileSync(
    join(CEM_DIR, "node_modules/test-elements/custom-elements.json"),
    JSON.stringify({
      modules: [
        {
          declarations: [
            {
              attributes: [
                {
                  default: "primary",
                  name: "variant",
                  type: { text: "string" },
                },
              ],
              cssProperties: [],
              customElement: true,
              description: "A test button",
              events: [{ name: "click" }],
              kind: "class",
              members: [{ kind: "field", name: "disabled", privacy: "public" }],
              slots: [{ description: "Default slot", name: "" }],
              tagName: "test-button",
            },
          ],
          path: "src/my-button.js",
        },
      ],
      schemaVersion: "1.0.0",
    }),
    "utf8",
  );

  test("discovers CEM components from node_modules", async () => {
    const url = new URL(`http://localhost/__studio/components?dir=${CEM_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, CEM_DIR);
    const components = await res.json();
    const btn = components.find((c: Record<string, any>) => c.tagName === "test-button");
    expect(btn).toBeDefined();
    expect(btn.source).toBe("npm");
    expect(btn.package).toBe("test-elements");
    expect(btn.props).toHaveLength(1);
    expect(btn.props[0].name).toBe("variant");
  });
});

// ─── packages endpoint ───────────────────────────────────────────────────────

describe("packages endpoint", () => {
  test("lists packages with CEM info", async () => {
    const CEM_DIR = join(FIXTURES, "cem-project");
    const url = new URL(`http://localhost/__studio/packages?dir=${CEM_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, CEM_DIR);
    const packages = await res.json();
    const testEl = (packages as any[]).find((p: Record<string, any>) => p.name === "test-elements");
    expect(testEl).toBeDefined();
    expect(testEl.hasCem).toBe(true);
  });

  test("returns empty when no package.json", async () => {
    const emptyDir = join(FIXTURES, "no-pkg");
    mkdirSync(emptyDir, { recursive: true });
    const url = new URL(`http://localhost/__studio/packages?dir=${emptyDir}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, emptyDir);
    const packages = await res.json();
    expect(packages).toEqual([]);
  });
});

// ─── cem endpoint ────────────────────────────────────────────────────────────

describe("cem endpoint", () => {
  test("returns CEM for a valid package", async () => {
    const CEM_DIR = join(FIXTURES, "cem-project");
    const url = new URL(`http://localhost/__studio/cem?pkg=test-elements&dir=${CEM_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, CEM_DIR);
    const data = await res.json();
    expect(data.cem).not.toBeNull();
    expect(data.cem.modules).toHaveLength(1);
  });

  test("returns null for missing package", async () => {
    const CEM_DIR = join(FIXTURES, "cem-project");
    const url = new URL(`http://localhost/__studio/cem?pkg=nonexistent&dir=${CEM_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, CEM_DIR);
    const data = await res.json();
    expect(data.cem).toBeNull();
  });

  test("returns 400 when pkg param missing", async () => {
    const url = new URL("http://localhost/__studio/cem");
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

// ─── packages/add ────────────────────────────────────────────────────────────

describe("packages/add", () => {
  test("returns 400 when name is missing", async () => {
    const url = new URL("http://localhost/__studio/packages/add");
    const req = new Request(url, {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.error).toBe("Missing name");
  });

  test("returns 400 when name is not a string", async () => {
    const url = new URL("http://localhost/__studio/packages/add");
    const req = new Request(url, {
      body: JSON.stringify({ name: 123 }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.error).toBe("Missing name");
  });

  test("returns 500 when bun add fails", async () => {
    const url = new URL("http://localhost/__studio/packages/add");
    const req = new Request(url, {
      body: JSON.stringify({
        name: "@nonexistent-scope-xyz/nonexistent-pkg-404",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(500);
  });
});

// ─── packages/remove ─────────────────────────────────────────────────────────

describe("packages/remove", () => {
  test("returns 400 when name is missing", async () => {
    const url = new URL("http://localhost/__studio/packages/remove");
    const req = new Request(url, {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.error).toBe("Missing name");
  });
});

// ─── file — upload ────────────────────────────────────────────────────────────

describe("file — upload", () => {
  test("uploads binary file", async () => {
    const url = new URL(`http://localhost/__studio/file/upload?path=uploaded.bin`);
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const req = new Request(url, { body: data, method: "POST" });
    const res = await callApi(req, url, FIXTURES);
    const result = await res.json();
    expect(result.ok).toBe(true);
  });

  test("returns 400 when path is missing", async () => {
    const url = new URL("http://localhost/__studio/file/upload");
    const req = new Request(url, { body: new Uint8Array([1]), method: "POST" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("returns 400 for path outside root", async () => {
    const url = new URL(`http://localhost/__studio/file/upload?path=/etc/evil`);
    const req = new Request(url, { body: new Uint8Array([1]), method: "POST" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });
});

// ─── plugin-schema — JS module fallback ─────────────────────────────────────

describe("plugin-schema — JS module fallback", () => {
  // Create a JS module with static schema
  writeFileSync(
    join(FIXTURES, "WithSchema.js"),
    `export class WithSchema { static schema = { type: "object", properties: { x: { type: "number" } } }; }`,
    "utf8",
  );

  // Create a JS module without function export
  writeFileSync(
    join(FIXTURES, "NotAClass.js"),
    `export const NotAClass = "not a function";`,
    "utf8",
  );

  test("returns static schema from JS class", async () => {
    const params = new URLSearchParams({
      prototype: "WithSchema",
      src: "./_studio_fixtures/WithSchema.js",
    });
    const url = new URL(`http://localhost/__studio/plugin-schema?${params}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.schema).not.toBeNull();
    expect(data.schema.properties.x).toBeDefined();
  });

  test("returns null schema when export is not a function", async () => {
    const params = new URLSearchParams({
      prototype: "NotAClass",
      src: "./_studio_fixtures/NotAClass.js",
    });
    const url = new URL(`http://localhost/__studio/plugin-schema?${params}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.schema).toBeNull();
    expect(data.error).toContain("not found");
  });

  test("returns error for module import failure", async () => {
    const params = new URLSearchParams({
      prototype: "X",
      src: "./_studio_fixtures/nonexistent-module.js",
    });
    const url = new URL(`http://localhost/__studio/plugin-schema?${params}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.schema).toBeNull();
    expect(data.error).toBeDefined();
  });
});

// ─── plugin-schema — base resolution ─────────────────────────────────────────

describe("plugin-schema — base resolution", () => {
  test("resolves src relative to base URL", async () => {
    const params = new URLSearchParams({
      base: "http://localhost/_studio_fixtures/page.json",
      prototype: "DataSource",
      src: "./DataSource.class.json",
    });
    const url = new URL(`http://localhost/__studio/plugin-schema?${params}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.schema).not.toBeNull();
    expect(data.schema.properties.url).toBeDefined();
  });

  test("returns error for malformed base URL", async () => {
    const params = new URLSearchParams({
      base: "not-a-url",
      src: "./Foo.class.json",
    });
    const url = new URL(`http://localhost/__studio/plugin-schema?${params}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.schema).toBeNull();
    expect(data.error).toBeDefined();
  });
});

// ─── extractStudioSchema — returns from resolve method ──────────────────────

describe("plugin-schema — returns annotation", () => {
  test("includes returns when resolve method has returns", async () => {
    const { req, url } = schemaRequest(
      `./_studio_fixtures/ContentCollection.class.json`,
      "ContentCollection",
    );
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.returns).toEqual({ type: "array" });
  });

  test("omits returns when resolve method has no returns annotation", async () => {
    const { req, url } = schemaRequest(
      `./_studio_fixtures/EventEmitter.class.json`,
      "EventEmitter",
    );
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.returns).toBeUndefined();
  });

  test("preserves complex returns schema", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/TypedQuery.class.json`, "TypedQuery");
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.returns).toEqual({
      items: { properties: { id: { type: "string" } }, type: "object" },
      type: "array",
    });
  });

  test("omits returns when class has no methods at all", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/DataSource.class.json`, "DataSource");
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.returns).toBeUndefined();
  });

  test("child does not inherit parent returns (only own resolve matters)", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/ChildQuery.class.json`, "ChildQuery");
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    // Child has no own resolve method, so no returns
    expect(schema.returns).toBeUndefined();
    // But still inherits parent properties
    expect(schema.properties.src).toBeDefined();
  });

  test("parent itself returns its resolve annotation", async () => {
    const { req, url } = schemaRequest(`./_studio_fixtures/BaseQuery.class.json`, "BaseQuery");
    const res = await callApi(req, url, import.meta.dir);
    const { schema } = await res.json();
    expect(schema.returns).toEqual({ type: "array" });
  });
});

// ─── assertAccessible via activeProjectRoot ───────────────────────────────────

describe("assertAccessible via activeProjectRoot", () => {
  test("allows file inside activeProjectRoot even if outside server root", async () => {
    const projectDir = join(FIXTURES, "active-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "test.txt"), "content", "utf8");

    // Use a server root that doesn't contain projectDir
    const serverRoot = join(FIXTURES, "server-root");
    mkdirSync(serverRoot, { recursive: true });

    const url = new URL(`http://localhost/__studio/file?path=${join(projectDir, "test.txt")}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, serverRoot, projectDir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe("content");
  });
});

// Cleanup
// ─── format registry endpoints ──────────────────────────────────────────────

describe("format endpoints", () => {
  const FMT_DIR = join(FIXTURES, "format-project");
  mkdirSync(FMT_DIR, { recursive: true });
  writeFileSync(
    join(FMT_DIR, "project.json"),
    JSON.stringify({
      extensions: ["@jxsuite/parser"],
      name: "Format Project",
    }),
    "utf8",
  );

  test("GET /__studio/formats lists registered format classes", async () => {
    const url = new URL(`http://localhost/__studio/formats?dir=${FMT_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FMT_DIR);
    const data = await res.json();
    const names = data.formats.map((f: { name: string }) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Markdown", "Csv"]));
    const md = data.formats.find((f: { name: string }) => f.name === "Markdown");
    expect(md.extensions).toEqual([".md"]);
    expect(md.studio.elements.block).toContain("h1");
    expect(md.capabilities.parse.timing).toContain("client");
  });

  test("GET /__studio/formats carries the sibling extensions payload", async () => {
    const url = new URL(`http://localhost/__studio/formats?dir=${FMT_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FMT_DIR);
    const data = await res.json();
    expect(data.extensions).toHaveLength(1);
    const [parser] = data.extensions;
    expect(parser.specifier).toBe("@jxsuite/parser");
    expect(parser.name).toBe("@jxsuite/parser");
    expect(parser.title).toBe("Content & Markdown");
    expect(parser.contributions).toHaveLength(1);
    const [content] = parser.contributions;
    expect(content.className).toBe("Content");
    expect(content.project.key).toBe("content");
    expect(content.studio.settings.layout).toBe("map");
    expect(content.studio.settings.entry.ui.schema.control).toBe("schema-builder");
    // The entry schema is the fragment's properties.content section schema.
    expect(content.entrySchema.type).toBe("object");
    expect(content.entrySchema.additionalProperties.properties.source.type).toBe("string");
  });

  test("GET /__studio/project-schemas returns pre-bundled entry documents", async () => {
    const url = new URL(`http://localhost/__studio/project-schemas?dir=${FMT_DIR}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FMT_DIR);
    expect(res.status).toBe(200);
    const data = await res.json();
    /* Self-contained AND single-resource: the entry refs are root pointers into embeds. Monaco
       registers these as inline objects with schema requests disabled, so a canonical URI here
       would simply fail to resolve. */
    const refs = data.project.allOf.map((entry: { $ref: string }) => entry.$ref);
    expect(refs).toEqual(["#/$defs/project-core-v2", "#/$defs/ext-parser-project-v1"]);
    expect(data.project.$defs["ext-parser-project-v1"]).toBeDefined();
    expect(data.document.$ref).toBeUndefined();
    expect(data.document.allOf.map((entry: { $ref: string }) => entry.$ref)).toEqual([
      "#/$defs/v1",
    ]);
    expect(data.document.$defs.v1).toBeDefined();
    // The entry documents were regenerated into the fixture project root on demand.
    expect(existsSync(join(FMT_DIR, "project.schema.json"))).toBe(true);
    expect(existsSync(join(FMT_DIR, "document.schema.json"))).toBe(true);
    // Keep the committed fixture pristine (they regenerate on the next call anyway).
    rmSync(join(FMT_DIR, "project.schema.json"), { force: true });
    rmSync(join(FMT_DIR, "document.schema.json"), { force: true });
  });

  test("GET /__studio/project-schemas rejects a dir outside the roots", async () => {
    const url = new URL(
      `http://localhost/__studio/project-schemas?dir=${encodeURIComponent("../outside")}`,
    );
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FMT_DIR);
    expect(res.status).toBe(400);
  });

  test("GET /__studio/project-schemas surfaces generation failures as 500", async () => {
    const emptyDir = join(FIXTURES, "no-project-json");
    mkdirSync(emptyDir, { recursive: true });
    const url = new URL(`http://localhost/__studio/project-schemas?dir=${emptyDir}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, emptyDir);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(typeof data.error).toBe("string");
  });

  test("POST /__studio/format parse dispatches through the format class", async () => {
    const url = new URL("http://localhost/__studio/format");
    const req = new Request(url, {
      body: JSON.stringify({
        action: "parse",
        dir: FMT_DIR,
        format: "Markdown",
        source: "---\ntitle: Hi\n---\n\n# Hello\n",
      }),
      method: "POST",
    });
    const res = await callApi(req, url, FMT_DIR);
    const data = await res.json();
    expect(data.result.title).toBe("Hi");
    expect(data.result.children[0].tagName).toBe("h1");
  });

  test("POST /__studio/format serialize round-trips a document", async () => {
    const url = new URL("http://localhost/__studio/format");
    const req = new Request(url, {
      body: JSON.stringify({
        action: "serialize",
        dir: FMT_DIR,
        doc: {
          children: [{ tagName: "h1", textContent: "Hello" }],
          title: "Hi",
        },
        format: "Markdown",
        options: { mode: "roundtrip" },
      }),
      method: "POST",
    });
    const res = await callApi(req, url, FMT_DIR);
    const data = await res.json();
    expect(data.result).toContain("title: Hi");
    expect(data.result).toContain("# Hello");
  });

  test("POST /__studio/format rejects unknown formats", async () => {
    const url = new URL("http://localhost/__studio/format");
    const req = new Request(url, {
      body: JSON.stringify({
        action: "parse",
        dir: FMT_DIR,
        format: "Toml",
        source: "",
      }),
      method: "POST",
    });
    const res = await callApi(req, url, FMT_DIR);
    expect(res.status).toBe(404);
  });

  test("plugin-schema surfaces format, $studio, and capabilities", async () => {
    const url = new URL(
      "http://localhost/__studio/plugin-schema?src=@jxsuite/parser/Markdown.class.json&prototype=Markdown",
    );
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, FMT_DIR);
    const data = await res.json();
    expect(data.schema.format.extensions).toEqual([".md"]);
    expect(data.schema.$studio.documentMode.default).toBe("content");
    expect(data.schema.capabilities.serialize.identifier).toBe("serialize");
  });
});

process.on("exit", () => {
  try {
    rmSync(FIXTURES, { recursive: true });
  } catch {}
});
