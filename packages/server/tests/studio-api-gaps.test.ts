import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleStudioApi } from "../src/studio-api";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const FIXTURES = resolve(import.meta.dir, "_studio_gaps_fixtures");
const ROOT = join(FIXTURES, "root");
const EXTERNAL = join(FIXTURES, "external");

async function callApi(
  req: Request,
  url: URL,
  root: string = ROOT,
  activeProjectRoot: string | null = null,
) {
  const res = await handleStudioApi(req, url, root, activeProjectRoot);
  if (!res) {
    throw new Error("handleStudioApi returned null");
  }
  return res;
}

function getReq(pathAndQuery: string) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  return { req: new Request(url, { method: "GET" }), url };
}

function jsonReq(path: string, method: string, body: unknown) {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, { body: JSON.stringify(body), method }),
    url,
  };
}

beforeAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(ROOT, { recursive: true });

  // External project (outside server root) for activeProjectRoot access checks
  mkdirSync(EXTERNAL, { recursive: true });
  writeFileSync(join(EXTERNAL, "ext.txt"), "external file");

  // Home dir for ~ expansion and find-project
  mkdirSync(join(FIXTURES, "home", "my-site"), { recursive: true });
  writeFileSync(join(FIXTURES, "home", "my-site", "project.json"), JSON.stringify({ name: "s" }));
  writeFileSync(join(FIXTURES, "home", "my-site", "page.json"), "{}");
  mkdirSync(join(FIXTURES, "home", "node_modules", "my-site"), { recursive: true });
  writeFileSync(
    join(FIXTURES, "home", "node_modules", "my-site", "project.json"),
    JSON.stringify({ name: "shadow" }),
  );

  // Broken project.json for resolve-site error path
  mkdirSync(join(ROOT, "broken-site"), { recursive: true });
  writeFileSync(join(ROOT, "broken-site", "project.json"), "{broken!");
  writeFileSync(join(ROOT, "broken-site", "page.json"), "{}");

  // Component with shorthand / null / computed / full state entries
  mkdirSync(join(ROOT, "comp-proj"), { recursive: true });
  writeFileSync(
    join(ROOT, "comp-proj", "widget.json"),
    JSON.stringify({
      $elements: [],
      $id: "widget",
      state: {
        computed: { $compute: "1+1" },
        full: { default: "x", type: "string" },
        label: "hi",
        nothing: null,
      },
      tagName: "x-widget",
    }),
  );

  // CEM-bearing dependency hoisted to the server root's node_modules
  mkdirSync(join(ROOT, "node_modules", "cem-dep"), { recursive: true });
  writeFileSync(
    join(ROOT, "node_modules", "cem-dep", "package.json"),
    JSON.stringify({ customElements: "custom-elements.json", name: "cem-dep" }),
  );
  writeFileSync(
    join(ROOT, "node_modules", "cem-dep", "custom-elements.json"),
    JSON.stringify({
      modules: [
        {
          declarations: [
            {
              attributes: [{ name: "color", type: { text: "string" } }],
              customElement: true,
              tagName: "cem-button",
            },
          ],
          path: "button.js",
        },
      ],
    }),
  );
  mkdirSync(join(ROOT, "node_modules", "no-cem-dep"), { recursive: true });
  writeFileSync(
    join(ROOT, "node_modules", "no-cem-dep", "package.json"),
    JSON.stringify({ name: "no-cem-dep" }),
  );
  mkdirSync(join(ROOT, "node_modules", "ghost-cem"), { recursive: true });
  writeFileSync(
    join(ROOT, "node_modules", "ghost-cem", "package.json"),
    JSON.stringify({ customElements: "missing.json", name: "ghost-cem" }),
  );
  mkdirSync(join(ROOT, "node_modules", "bad-cem"), { recursive: true });
  writeFileSync(
    join(ROOT, "node_modules", "bad-cem", "package.json"),
    JSON.stringify({ customElements: "cem.json", name: "bad-cem" }),
  );
  writeFileSync(join(ROOT, "node_modules", "bad-cem", "cem.json"), "{nope");

  // Subproject without its own node_modules (forces root fallback)
  mkdirSync(join(ROOT, "sub"), { recursive: true });
  writeFileSync(
    join(ROOT, "sub", "package.json"),
    JSON.stringify({
      dependencies: { "bad-cem": "1.0.0", "cem-dep": "1.0.0", "no-cem-dep": "1.0.0" },
      name: "sub",
    }),
  );

  // Project with invalid package.json for /packages error path
  mkdirSync(join(ROOT, "bad-pkg-proj"), { recursive: true });
  writeFileSync(join(ROOT, "bad-pkg-proj", "package.json"), "{invalid");

  // Local dependency for bun add / remove
  mkdirSync(join(ROOT, "local-dep"), { recursive: true });
  writeFileSync(
    join(ROOT, "local-dep", "package.json"),
    JSON.stringify({ name: "local-dep", version: "1.0.0" }),
  );
  mkdirSync(join(ROOT, "pkg-proj"), { recursive: true });
  writeFileSync(
    join(ROOT, "pkg-proj", "package.json"),
    JSON.stringify({ name: "pkg-proj", version: "1.0.0" }),
  );

  // Directory + blocking file for file endpoint error paths
  mkdirSync(join(ROOT, "a-directory"), { recursive: true });
  writeFileSync(join(ROOT, "blocker.txt"), "i am a file");

  // Plugin-schema fixtures
  writeFileSync(
    join(ROOT, "Schema.class.json"),
    JSON.stringify({
      $defs: {
        parameters: {
          src: { identifier: "src", type: { type: "string" } },
        },
      },
      $prototype: "Class",
      title: "Schema",
    }),
  );
  writeFileSync(
    join(ROOT, "WithBadSibling.js"),
    "export class Widget { static schema = { properties: { live: { type: 'boolean' } } }; }",
  );
  writeFileSync(join(ROOT, "Widget.class.json"), "{not valid json");
});

afterAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true });
});

// ─── assertAccessible via activeProjectRoot ──────────────────────────────────

describe("activeProjectRoot access", () => {
  test("allows file reads under the active project root", async () => {
    const fp = join(EXTERNAL, "ext.txt");
    const { req, url } = getReq(`/__studio/file?path=${encodeURIComponent(fp)}`);
    const res = await callApi(req, url, ROOT, EXTERNAL);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.content).toBe("external file");
  });

  test("rejects paths outside both roots", async () => {
    const fp = join(FIXTURES, "home", "my-site", "page.json");
    const { req, url } = getReq(`/__studio/file?path=${encodeURIComponent(fp)}`);
    const res = await callApi(req, url, ROOT, EXTERNAL);
    expect(res.status).toBe(400);
  });
});

// ─── resolve-site ────────────────────────────────────────────────────────────

describe("resolve-site — gaps", () => {
  test("expands ~ against HOME", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = join(FIXTURES, "home");
    try {
      const { req, url } = getReq(
        `/__studio/resolve-site?path=${encodeURIComponent("~/my-site/page.json")}`,
      );
      const res = await callApi(req, url);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sitePath).toBe(join(FIXTURES, "home", "my-site"));
      expect(body.fileRelPath).toBe("page.json");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("returns 500 when project.json is unparseable", async () => {
    const fp = join(ROOT, "broken-site", "page.json");
    const { req, url } = getReq(`/__studio/resolve-site?path=${encodeURIComponent(fp)}`);
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload.error).toBeDefined();
  });
});

// ─── find-project ────────────────────────────────────────────────────────────

describe("find-project — gaps", () => {
  test("returns null path when HOME is unset", async () => {
    const originalHome = process.env.HOME;
    const originalProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    try {
      const { req, url } = getReq("/__studio/find-project?name=my-site");
      const res = await callApi(req, url);
      const payload = await res.json();
      expect(payload.path).toBeNull();
    } finally {
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      }
      if (originalProfile !== undefined) {
        process.env.USERPROFILE = originalProfile;
      }
    }
  });

  test("finds a project under HOME, skipping node_modules", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = join(FIXTURES, "home");
    try {
      const { req, url } = getReq("/__studio/find-project?name=my-site");
      const res = await callApi(req, url);
      const body = await res.json();
      expect(body.path).toBe(join(FIXTURES, "home", "my-site"));
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

// ─── create-project ──────────────────────────────────────────────────────────

describe("create-project", () => {
  test("requires name and directory", async () => {
    const { req, url } = jsonReq("/__studio/create-project", "POST", { name: "x" });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });

  test("rejects directories outside the root", async () => {
    const { req, url } = jsonReq("/__studio/create-project", "POST", {
      directory: "../escape",
      name: "Escape",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload.error).toContain("outside");
  });

  test("generates a new project and returns its config", async () => {
    const { req, url } = jsonReq("/__studio/create-project", "POST", {
      description: "A test site",
      directory: "generated-site",
      name: "Generated Site",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toBe("generated-site");
    expect(body.config.name).toBe("Generated Site");
    expect(readFileSync(join(ROOT, "generated-site", "project.json"), "utf8")).toContain(
      "Generated Site",
    );
  });
});

// ─── files ───────────────────────────────────────────────────────────────────

describe("files — gaps", () => {
  test("reports paths relative to the active project root", async () => {
    const { req, url } = getReq("/__studio/files?glob=*.txt");
    const res = await callApi(req, url, ROOT, EXTERNAL);
    expect(res.status).toBe(200);
    const files = await res.json();
    const names = files.map((f: { path: string }) => f.path);
    expect(names).toContain("ext.txt");
  });

  test("returns 500 for a nonexistent directory", async () => {
    const { req, url } = getReq("/__studio/files?dir=does-not-exist");
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });
});

// ─── components ──────────────────────────────────────────────────────────────

describe("components — gaps", () => {
  test("handles shorthand, null, and computed state entries", async () => {
    const { req, url } = getReq("/__studio/components?dir=comp-proj");
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const components = await res.json();
    const widget = components.find((c: { tagName: string }) => c.tagName === "x-widget");
    expect(widget).toBeDefined();
    expect(widget.hasElements).toBe(false);
    const propNames = widget.props.map((p: { name: string }) => p.name);
    expect(propNames).toContain("label");
    expect(propNames).toContain("full");
    expect(propNames).not.toContain("nothing");
    expect(propNames).not.toContain("computed");
    const label = widget.props.find((p: { name: string }) => p.name === "label");
    expect(label.default).toBe("hi");
    expect(label.type).toBe("string");
  });

  test("discovers CEM components via root node_modules fallback", async () => {
    const { req, url } = getReq("/__studio/components?dir=sub");
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const components = await res.json();
    const btn = components.find((c: { tagName: string }) => c.tagName === "cem-button");
    expect(btn).toBeDefined();
    expect(btn.source).toBe("npm");
    expect(btn.package).toBe("cem-dep");
    expect(btn.props[0].name).toBe("color");
  });
});

// ─── packages ────────────────────────────────────────────────────────────────

describe("packages — gaps", () => {
  test("lists packages resolved through the root fallback", async () => {
    const { req, url } = getReq("/__studio/packages?dir=sub");
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const packages = await res.json();
    const cem = packages.find((p: { name: string }) => p.name === "cem-dep");
    expect(cem.hasCem).toBe(true);
    const plain = packages.find((p: { name: string }) => p.name === "no-cem-dep");
    expect(plain.hasCem).toBe(false);
  });

  test("returns 500 for an unparseable package.json", async () => {
    const { req, url } = getReq("/__studio/packages?dir=bad-pkg-proj");
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });
});

// ─── cem ─────────────────────────────────────────────────────────────────────

describe("cem — gaps", () => {
  test("requires pkg param", async () => {
    const { req, url } = getReq("/__studio/cem");
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });

  test("returns null for uninstalled package", async () => {
    const { req, url } = getReq("/__studio/cem?pkg=not-installed-pkg");
    const res = await callApi(req, url);
    const payload = await res.json();
    expect(payload.cem).toBeNull();
  });

  test("returns null when the package has no customElements field", async () => {
    const { req, url } = getReq("/__studio/cem?pkg=no-cem-dep&dir=sub");
    const res = await callApi(req, url);
    const payload = await res.json();
    expect(payload.cem).toBeNull();
  });

  test("returns null when the manifest file is missing", async () => {
    const { req, url } = getReq("/__studio/cem?pkg=ghost-cem");
    const res = await callApi(req, url);
    const payload = await res.json();
    expect(payload.cem).toBeNull();
  });

  test("returns the manifest for a valid CEM package", async () => {
    const { req, url } = getReq("/__studio/cem?pkg=cem-dep&dir=sub");
    const res = await callApi(req, url);
    const body = await res.json();
    expect(body.cem.modules[0].declarations[0].tagName).toBe("cem-button");
  });

  test("returns 500 for an unparseable manifest", async () => {
    const { req, url } = getReq("/__studio/cem?pkg=bad-cem");
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });
});

// ─── packages add/remove ─────────────────────────────────────────────────────

describe("packages add/remove — gaps", () => {
  test("add requires a name", async () => {
    const { req, url } = jsonReq("/__studio/packages/add", "POST", {});
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });

  test("add installs a local dependency with the dev flag", async () => {
    const { req, url } = jsonReq("/__studio/packages/add", "POST", {
      dev: true,
      dir: "pkg-proj",
      name: "../local-dep",
    });
    const res = await callApi(req, url);
    // Bun records the devDependency in package.json before the node_modules link step. On Windows it
    // Cannot copy a local file: dependency from cache into node_modules (EPERM), so `bun add` exits
    // Non-zero even though the manifest was written; assert the manifest (the handler's observable
    // Effect) everywhere, and the success response where the link step works.
    if (process.platform !== "win32") {
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.ok).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, "pkg-proj", "package.json"), "utf8"));
    expect(pkg.devDependencies["local-dep"]).toBeDefined();
  });

  test("remove requires a name", async () => {
    const { req, url } = jsonReq("/__studio/packages/remove", "POST", {});
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });

  test("remove uninstalls a dependency", async () => {
    const { req, url } = jsonReq("/__studio/packages/remove", "POST", {
      dir: "pkg-proj",
      name: "local-dep",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    const pkg = JSON.parse(readFileSync(join(ROOT, "pkg-proj", "package.json"), "utf8"));
    expect(pkg.devDependencies?.["local-dep"]).toBeUndefined();
  });

  test("add returns 500 when spawn fails", async () => {
    const { req, url } = jsonReq("/__studio/packages/add", "POST", {
      dir: "no-such-dir-xyz",
      name: "anything",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });

  test("remove returns 500 when spawn fails", async () => {
    const { req, url } = jsonReq("/__studio/packages/remove", "POST", {
      dir: "no-such-dir-xyz",
      name: "anything",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });
});

// ─── file CRUD error paths ───────────────────────────────────────────────────

describe("file endpoints — error paths", () => {
  test("GET returns 500 when path is a directory", async () => {
    const fp = join(ROOT, "a-directory");
    const { req, url } = getReq(`/__studio/file?path=${encodeURIComponent(fp)}`);
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });

  test("PUT rejects traversal outside root", async () => {
    const url = new URL(`http://localhost/__studio/file?path=${encodeURIComponent("../esc.txt")}`);
    const req = new Request(url, { body: "x", method: "PUT" });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });

  test("PUT returns 500 when a parent path component is a file", async () => {
    const url = new URL(
      `http://localhost/__studio/file?path=${encodeURIComponent("blocker.txt/child.txt")}`,
    );
    const req = new Request(url, { body: "x", method: "PUT" });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });

  test("upload returns 500 when a parent path component is a file", async () => {
    const url = new URL(
      `http://localhost/__studio/file/upload?path=${encodeURIComponent("blocker.txt/bin.dat")}`,
    );
    const req = new Request(url, { body: new Uint8Array([1, 2, 3]), method: "POST" });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });

  test("DELETE rejects traversal outside root", async () => {
    const url = new URL(`http://localhost/__studio/file?path=${encodeURIComponent("../esc.txt")}`);
    const req = new Request(url, { method: "DELETE" });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });

  test("DELETE returns 500 for a directory", async () => {
    const url = new URL(`http://localhost/__studio/file?path=a-directory`);
    const req = new Request(url, { method: "DELETE" });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });

  test("rename rejects traversal outside root", async () => {
    const { req, url } = jsonReq("/__studio/file/rename", "POST", {
      from: "../esc.txt",
      to: "fine.txt",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });

  test("rename returns 500 for a missing source", async () => {
    const { req, url } = jsonReq("/__studio/file/rename", "POST", {
      from: "does-not-exist.txt",
      to: "still-nothing.txt",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });
});

// ─── format endpoints — error paths ──────────────────────────────────────────

describe("format endpoints — error paths", () => {
  test("format requires format and action", async () => {
    const { req, url } = jsonReq("/__studio/format", "POST", { action: "parse" });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toContain("Missing format or action");
  });

  test("format rejects unsupported actions", async () => {
    const { req, url } = jsonReq("/__studio/format", "POST", {
      action: "transmogrify",
      format: "Markdown",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toContain("Unsupported action");
  });

  test("format returns 500 for a dir outside root", async () => {
    const { req, url } = jsonReq("/__studio/format", "POST", {
      action: "parse",
      dir: "../outside",
      format: "Markdown",
      source: "# hi",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(500);
  });

  test("formats returns 400 for a dir outside root", async () => {
    const { req, url } = getReq(`/__studio/formats?dir=${encodeURIComponent("../outside")}`);
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });
});

// ─── plugin-schema — gaps ────────────────────────────────────────────────────

describe("plugin-schema — gaps", () => {
  test("falls back to server root when src is missing under active project", async () => {
    const { req, url } = getReq("/__studio/plugin-schema?src=./Schema.class.json");
    const res = await callApi(req, url, ROOT, EXTERNAL);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema.properties.src).toBeDefined();
  });

  test("resolves bare specifiers via the server require fallback", async () => {
    const { req, url } = getReq("/__studio/plugin-schema?src=%40jxsuite%2Fschema");
    // Root outside the repo: project require fails, server require resolves
    const tmpRoot = mkdtempSync(join(tmpdir(), "jx-plugin-schema-"));
    try {
      const res = await callApi(req, url, tmpRoot, null);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Resolved JS module has no export named after the specifier
      expect(body.schema).toBeNull();
      expect(body.error).toContain("not found");
    } finally {
      rmSync(tmpRoot, { force: true, recursive: true });
    }
  });

  test("falls through to JS import when the sibling .class.json is invalid", async () => {
    const { req, url } = getReq("/__studio/plugin-schema?src=./WithBadSibling.js&prototype=Widget");
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema.properties.live.type).toBe("boolean");
  });
});

// ─── packages install / needs-install / outdated / set-versions ────────────────

describe("packages — install/needs/outdated/set-versions", () => {
  test("needs-install reflects node_modules presence", async () => {
    mkdirSync(join(ROOT, "needs-proj"), { recursive: true });
    writeFileSync(join(ROOT, "needs-proj", "package.json"), JSON.stringify({ name: "needs" }));
    const missingReq = getReq("/__studio/packages/needs-install?dir=needs-proj");
    const missingRes = await callApi(missingReq.req, missingReq.url);
    const missingBody = await missingRes.json();
    expect(missingBody.needsInstall).toBe(true);

    mkdirSync(join(ROOT, "needs-proj", "node_modules"), { recursive: true });
    const presentReq = getReq("/__studio/packages/needs-install?dir=needs-proj");
    const presentRes = await callApi(presentReq.req, presentReq.url);
    const presentBody = await presentRes.json();
    expect(presentBody.needsInstall).toBe(false);
  });

  test("install runs bun install in the project", async () => {
    mkdirSync(join(ROOT, "install-proj"), { recursive: true });
    writeFileSync(
      join(ROOT, "install-proj", "package.json"),
      JSON.stringify({ dependencies: {}, name: "install-proj", version: "1.0.0" }),
    );
    const { req, url } = jsonReq("/__studio/packages/install", "POST", { dir: "install-proj" });
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.ok).toBe("boolean");
  });

  test("outdated reports a newer version (registry mocked)", async () => {
    mkdirSync(join(ROOT, "outdated-proj"), { recursive: true });
    writeFileSync(
      join(ROOT, "outdated-proj", "package.json"),
      JSON.stringify({ dependencies: { "fake-pkg": "^1.0.0" }, name: "outdated-proj" }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ version: "2.0.0" })) as unknown as typeof fetch;
    try {
      const { req, url } = getReq("/__studio/packages/outdated?dir=outdated-proj");
      const res = await callApi(req, url);
      expect(res.status).toBe(200);
      const list = await res.json();
      expect(list).toContainEqual({ current: "^1.0.0", latest: "2.0.0", name: "fake-pkg" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("set-versions requires an updates array", async () => {
    const { req, url } = jsonReq("/__studio/packages/set-versions", "POST", { dir: "pkg-proj" });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
  });

  test("set-versions rewrites package.json then reinstalls", async () => {
    mkdirSync(join(ROOT, "setver-proj"), { recursive: true });
    writeFileSync(
      join(ROOT, "setver-proj", "package.json"),
      JSON.stringify({ dependencies: {}, name: "setver-proj", version: "1.0.0" }),
    );
    const { req, url } = jsonReq("/__studio/packages/set-versions", "POST", {
      dir: "setver-proj",
      updates: [{ name: "local-dep", version: "file:../local-dep" }],
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const pkg = JSON.parse(readFileSync(join(ROOT, "setver-proj", "package.json"), "utf8"));
    expect(pkg.dependencies["local-dep"]).toBe("file:../local-dep");
  });
});
