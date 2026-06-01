import { describe, test, expect } from "bun:test";
import { handleStudioApi } from "../src/studio-api";
import { join, resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

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
  if (!res) throw new Error("handleStudioApi returned null");
  return res;
}

const FIXTURES = resolve(import.meta.dir, "_studio_fixtures");
mkdirSync(FIXTURES, { recursive: true });

// Simple .class.json for direct path resolution
const simpleClass = {
  $prototype: "Class",
  title: "DataSource",
  description: "A test data source",
  $defs: {
    parameters: {
      url: {
        identifier: "url",
        type: { type: "string" },
        description: "API endpoint URL",
        examples: ["https://api.example.com"],
      },
      limit: {
        identifier: "limit",
        type: { type: "integer", default: 10 },
        description: "Max results",
      },
      debug: {
        identifier: "debug",
        type: { type: "boolean", default: false },
        description: "Enable debug mode",
      },
    },
    fields: {
      cache: {
        role: "field",
        access: "public",
        scope: "instance",
        identifier: "cache",
        type: { type: "object" },
        default: {},
        description: "Internal cache",
      },
      secret: {
        role: "field",
        access: "private",
        scope: "instance",
        identifier: "secret",
      },
    },
    constructor: {
      role: "constructor",
      $prototype: "Function",
      parameters: [{ $ref: "#/$defs/parameters/url" }],
    },
  },
};
writeFileSync(join(FIXTURES, "DataSource.class.json"), JSON.stringify(simpleClass), "utf8");

// Parent .class.json for extends testing
const parentClass = {
  $prototype: "Class",
  title: "BaseCollection",
  description: "Base collection class",
  $defs: {
    parameters: {
      src: {
        identifier: "src",
        type: { type: "string" },
        description: "Source path",
      },
      sortBy: {
        identifier: "sortBy",
        type: { type: "string" },
        description: "Sort field",
      },
    },
    constructor: {
      role: "constructor",
      $prototype: "Function",
      parameters: [{ $ref: "#/$defs/parameters/src" }],
    },
  },
};
writeFileSync(join(FIXTURES, "BaseCollection.class.json"), JSON.stringify(parentClass), "utf8");

// Child .class.json extending parent
const childClass = {
  $prototype: "Class",
  title: "PostCollection",
  description: "Posts collection",
  extends: { $ref: "./BaseCollection.class.json" },
  $defs: {
    parameters: {
      category: {
        identifier: "category",
        type: { type: "string" },
        description: "Filter by category",
      },
    },
  },
};
writeFileSync(join(FIXTURES, "PostCollection.class.json"), JSON.stringify(childClass), "utf8");

// Class with format: "json-schema" type parameter
const parameterizedClass = {
  $prototype: "Class",
  title: "TypedCollection",
  $defs: {
    parameters: {
      src: { identifier: "src", type: { type: "string" } },
      itemSchema: {
        identifier: "itemSchema",
        type: { type: "object" },
        format: "json-schema",
        description: "Schema for collection items",
      },
    },
    constructor: {
      role: "constructor",
      $prototype: "Function",
      parameters: [{ $ref: "#/$defs/parameters/src" }],
    },
  },
};
writeFileSync(
  join(FIXTURES, "TypedCollection.class.json"),
  JSON.stringify(parameterizedClass),
  "utf8",
);

// Sibling JS module with a companion .class.json
writeFileSync(join(FIXTURES, "parser.js"), "export class Parser {}", "utf8");
const siblingClassJson = {
  $prototype: "Class",
  title: "Parser",
  description: "Sibling auto-discovered schema",
  $defs: {
    parameters: {
      input: { identifier: "input", type: { type: "string" }, description: "Input text" },
    },
  },
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
  if (prototype) params.set("prototype", prototype);
  if (base) params.set("base", base);
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
      type: "string",
      description: "API endpoint URL",
      examples: ["https://api.example.com"],
    });
    expect(schema.properties.limit).toEqual({
      type: "integer",
      default: 10,
      description: "Max results",
    });
    expect(schema.properties.debug).toEqual({
      type: "boolean",
      default: false,
      description: "Enable debug mode",
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
    expect(schema.required).not.toContain("limit"); // has default: 10
    expect(schema.required).not.toContain("debug"); // has default: false
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
    // src is required from parent (no default)
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
  JSON.stringify({ tagName: "my-card", state: { title: { type: "string", default: "" } } }),
  "utf8",
);

function projectInfoRequest(dir: string) {
  const params = new URLSearchParams();
  if (dir) params.set("dir", dir);
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
    const req = new Request(url, { method: "PUT", body: "new content" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("creates parent directories as needed", async () => {
    const url = new URL(`http://localhost/__studio/file?path=sub/deep/new.txt`);
    const req = new Request(url, { method: "PUT", body: "deep content" });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("returns 400 when path is missing", async () => {
    const url = new URL("http://localhost/__studio/file");
    const req = new Request(url, { method: "PUT", body: "x" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "old-name.txt", to: "new-name.txt" }),
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.to).toBe("new-name.txt");
  });

  test("returns 400 for invalid JSON", async () => {
    const url = new URL("http://localhost/__studio/file/rename");
    const req = new Request(url, { method: "POST", body: "not json" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("returns 400 when from/to missing", async () => {
    const url = new URL("http://localhost/__studio/file/rename");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "only-from.txt" }),
    });
    const res = await callApi(req, url, FIXTURES);
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "findme.txt" }),
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.path).toContain("findme.txt");
  });

  test("returns null when file not found", async () => {
    const url = new URL("http://localhost/__studio/locate");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nonexistent-xyz.txt" }),
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.path).toBeNull();
  });

  test("returns 400 for invalid JSON", async () => {
    const url = new URL("http://localhost/__studio/locate");
    const req = new Request(url, { method: "POST", body: "bad" });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("returns 400 when name is missing", async () => {
    const url = new URL("http://localhost/__studio/locate");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
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
  }, 15000);
});

// ─── components — markdown discovery ────────────────────────────────────────

describe("components — markdown discovery", () => {
  // Set up md fixtures before tests run
  const MD_DIR = join(FIXTURES, "md-components");
  mkdirSync(MD_DIR, { recursive: true });

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
      name: "cem-test",
      dependencies: { "test-elements": "^1.0.0" },
    }),
    "utf8",
  );

  writeFileSync(
    join(CEM_DIR, "node_modules/test-elements/package.json"),
    JSON.stringify({
      name: "test-elements",
      version: "1.0.0",
      customElements: "./custom-elements.json",
    }),
    "utf8",
  );

  writeFileSync(
    join(CEM_DIR, "node_modules/test-elements/custom-elements.json"),
    JSON.stringify({
      schemaVersion: "1.0.0",
      modules: [
        {
          path: "src/my-button.js",
          declarations: [
            {
              kind: "class",
              customElement: true,
              tagName: "test-button",
              description: "A test button",
              attributes: [{ name: "variant", type: { text: "string" }, default: "primary" }],
              members: [{ kind: "field", name: "disabled", privacy: "public" }],
              slots: [{ name: "", description: "Default slot" }],
              events: [{ name: "click" }],
              cssProperties: [],
            },
          ],
        },
      ],
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.error).toBe("Missing name");
  });

  test("returns 400 when name is not a string", async () => {
    const url = new URL("http://localhost/__studio/packages/add");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 123 }),
    });
    const res = await callApi(req, url, FIXTURES);
    const data = await res.json();
    expect(data.error).toBe("Missing name");
  });

  test("returns 500 when bun add fails", async () => {
    const url = new URL("http://localhost/__studio/packages/add");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "@nonexistent-scope-xyz/nonexistent-pkg-404" }),
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
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
    const req = new Request(url, { method: "POST", body: data });
    const res = await callApi(req, url, FIXTURES);
    const result = await res.json();
    expect(result.ok).toBe(true);
  });

  test("returns 400 when path is missing", async () => {
    const url = new URL("http://localhost/__studio/file/upload");
    const req = new Request(url, { method: "POST", body: new Uint8Array([1]) });
    const res = await callApi(req, url, FIXTURES);
    expect(res.status).toBe(400);
  });

  test("returns 400 for path outside root", async () => {
    const url = new URL(`http://localhost/__studio/file/upload?path=/etc/evil`);
    const req = new Request(url, { method: "POST", body: new Uint8Array([1]) });
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
      src: "./_studio_fixtures/WithSchema.js",
      prototype: "WithSchema",
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
      src: "./_studio_fixtures/NotAClass.js",
      prototype: "NotAClass",
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
      src: "./_studio_fixtures/nonexistent-module.js",
      prototype: "X",
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
      src: "./DataSource.class.json",
      prototype: "DataSource",
      base: "http://localhost/_studio_fixtures/page.json",
    });
    const url = new URL(`http://localhost/__studio/plugin-schema?${params}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.schema).not.toBeNull();
    expect(data.schema.properties.url).toBeDefined();
  });

  test("returns error for malformed base URL", async () => {
    const params = new URLSearchParams({ src: "./Foo.class.json", base: "not-a-url" });
    const url = new URL(`http://localhost/__studio/plugin-schema?${params}`);
    const req = new Request(url, { method: "GET" });
    const res = await callApi(req, url, import.meta.dir);
    const data = await res.json();
    expect(data.schema).toBeNull();
    expect(data.error).toBeDefined();
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
process.on("exit", () => {
  try {
    rmSync(FIXTURES, { recursive: true });
  } catch {}
});
