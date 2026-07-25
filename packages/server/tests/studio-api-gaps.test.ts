import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertCreatableParent, handleStudioApi } from "../src/studio-api";
import { LOCATION_ID_FILE } from "@jxsuite/protocol/routes";
import type { StudioApiOptions } from "../src/studio-api";
import { basename, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const FIXTURES = resolve(import.meta.dir, "_studio_gaps_fixtures");
const ROOT = join(FIXTURES, "root");
const EXTERNAL = join(FIXTURES, "external");
/** Parent for projects created outside the server root; reachable only via allowedRoots. */
const OUTSIDE_PARENT = join(FIXTURES, "elsewhere");
/**
 * A parent under neither the server root, an allowed root, nor the home directory — a sibling of
 * the home directory, so the relationship holds wherever the checkout happens to live.
 */
const UNPERMITTED_PARENT = resolve(homedir(), "..", "jx-unpermitted-destination");

async function callApi(
  req: Request,
  url: URL,
  root: string = ROOT,
  activeProjectRoot: string | null = null,
  opts: StudioApiOptions = {},
) {
  const res = await handleStudioApi(req, url, root, activeProjectRoot, opts);
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

  // Destination parent outside the server root, for create-project's chosen-location path
  mkdirSync(OUTSIDE_PARENT, { recursive: true });

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

  // Project whose extension registers a component-kind document format
  mkdirSync(join(ROOT, "comp-ext-proj", "widget-ext"), { recursive: true });
  writeFileSync(
    join(ROOT, "comp-ext-proj", "project.json"),
    JSON.stringify({ extensions: ["./widget-ext"], name: "Comp Ext" }),
  );
  writeFileSync(
    join(ROOT, "comp-ext-proj", "widget-ext", "jx-extension.json"),
    JSON.stringify({ classes: { Widget: "./Widget.class.json" }, name: "widget-ext" }),
  );
  writeFileSync(
    join(ROOT, "comp-ext-proj", "widget-ext", "Widget.class.json"),
    JSON.stringify({
      $defs: {
        methods: {
          parse: {
            identifier: "parse",
            role: "parse",
            scope: "static",
            timing: ["compiler", "server"],
          },
        },
      },
      $implementation: "./widget-impl.js",
      $prototype: "Class",
      extends: "Object",
      format: { documentKinds: ["component"], extensions: [".wgt"] },
      title: "Widget",
    }),
  );
  writeFileSync(
    join(ROOT, "comp-ext-proj", "widget-ext", "widget-impl.js"),
    "export class Widget { static parse() { return { tagName: 'x-wgt' }; } }",
  );
  writeFileSync(
    join(ROOT, "comp-ext-proj", "card.json"),
    JSON.stringify({ $elements: [], state: {}, tagName: "x-card" }),
  );

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
    join(ROOT, "Init.class.json"),
    JSON.stringify({
      $defs: {
        fields: {
          count: {
            access: "public",
            examples: [1, 2, 3],
            identifier: "count",
            initializer: 7,
            role: "field",
            scope: "instance",
            type: { type: "number" },
          },
          fixed: {
            access: "public",
            default: "abc",
            identifier: "fixed",
            initializer: "ignored",
            role: "field",
            scope: "instance",
            type: { type: "string" },
          },
        },
      },
      $prototype: "Class",
      title: "Init",
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

// ─── locate-directory ────────────────────────────────────────────────────────

/** Throwaway home directories handed to the locate-directory route, removed after the suite. */
const LOCATE_HOMES: string[] = [];

/**
 * Makes a private home directory for one locate-directory case. It lives under the real home so the
 * route — which only ever scans `$HOME` — stays inside the user's tree, and so the scan sees
 * nothing but the fixture the test just wrote.
 */
function locateHome() {
  const home = mkdtempSync(join(homedir(), "jx-locate-home-"));
  LOCATE_HOMES.push(home);
  return home;
}

/** Calls the route with `$HOME` pointed at `home`, restoring the ambient environment after. */
async function locateDirectory(home: string, query: string) {
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { req, url } = getReq(`/__studio/locate-directory?${query}`);
    return await callApi(req, url);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

describe("locate-directory", () => {
  /** A well-formed id — the route accepts only 32 lowercase hex characters. */
  const ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const OTHER_ID = "0f9e8d7c6b5a493827160f5e4d3c2b1a";

  /** Shared by the validation cases, which are refused before anything touches the filesystem. */
  let emptyHome = "";

  /** Tag `dir` as the picked folder by writing `id` into its hidden location file. */
  function tag(dir: string, id: string) {
    writeFileSync(join(dir, LOCATION_ID_FILE), id);
  }

  beforeAll(() => {
    emptyHome = locateHome();
  });

  afterAll(() => {
    for (const home of LOCATE_HOMES) {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("rejects a missing name", async () => {
    const res = await locateDirectory(emptyHome, `id=${ID}`);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing or invalid name/id");
  });

  test("rejects a missing id", async () => {
    const res = await locateDirectory(emptyHome, "name=new-site");
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing or invalid name/id");
  });

  test("rejects an id outside the generated 32-hex shape", async () => {
    // The id is only ever compared, never used as a pattern — but a strict shape keeps a
    // Malformed value from reaching the filesystem at all.
    for (const bad of ["../escape", "not-hex-at-all", "A1B2C3D4E5F60718293A4B5C6D7E8F90", "abc"]) {
      const res = await locateDirectory(emptyHome, `name=new-site&id=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    }
  });

  test("rejects a name containing a separator", async () => {
    // A directory handle's `.name` is a single path segment; anything else is not a real pick.
    const nested = encodeURIComponent("nested/new-site");
    const res = await locateDirectory(emptyHome, `name=${nested}&id=${ID}`);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing or invalid name/id");

    const backslash = encodeURIComponent(String.raw`nested\new-site`);
    const winRes = await locateDirectory(emptyHome, `name=${backslash}&id=${ID}`);
    expect(winRes.status).toBe(400);
  });

  test("resolves a tag written straight into the home directory to the home directory", async () => {
    // Picking the home directory itself is legitimate, and no `**/<name>/` glob can match it.
    const home = locateHome();
    tag(home, ID);
    const res = await locateDirectory(home, `name=${basename(home)}&id=${ID}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { path: string | null };
    expect(payload.path).toBe(home);
    // The route cleans up the moment it matches, rather than leaving the tag for the client.
    expect(existsSync(join(home, LOCATION_ID_FILE))).toBe(false);
  });

  test("resolves a tag in a nested directory to that directory, skipping node_modules", async () => {
    const home = locateHome();
    const target = join(home, "projects", "sites", "new-site");
    mkdirSync(target, { recursive: true });
    tag(target, ID);
    // A same-named decoy inside node_modules must never win.
    mkdirSync(join(home, "node_modules", "new-site"), { recursive: true });
    tag(join(home, "node_modules", "new-site"), ID);

    const res = await locateDirectory(home, `name=new-site&id=${ID}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { path: string | null };
    expect(payload.path).toBe(target);
    expect(existsSync(join(target, LOCATION_ID_FILE))).toBe(false);
  });

  test("ignores a same-named folder whose tag holds a different id", async () => {
    // This is the whole reason identity lives in the CONTENTS: two folders can share a basename,
    // And a tag left by a crashed session can still be on disk. Only the live id may win.
    const home = locateHome();
    const stale = join(home, "a", "new-site");
    const live = join(home, "b", "new-site");
    mkdirSync(stale, { recursive: true });
    mkdirSync(live, { recursive: true });
    tag(stale, OTHER_ID);
    tag(live, ID);

    const res = await locateDirectory(home, `name=new-site&id=${ID}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { path: string | null };
    expect(payload.path).toBe(live);
    // The loser's tag is left untouched — it belongs to someone else's pick.
    expect(existsSync(join(stale, LOCATION_ID_FILE))).toBe(true);
  });

  test("returns a null path when no tag anywhere holds the id", async () => {
    const home = locateHome();
    const dir = join(home, "new-site");
    mkdirSync(dir, { recursive: true });
    tag(dir, OTHER_ID);
    const res = await locateDirectory(home, `name=new-site&id=${ID}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { path: string | null };
    expect(payload.path).toBeNull();
  });

  test("returns a null path when there is no home directory", async () => {
    const originalHome = process.env.HOME;
    const originalProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    try {
      const { req, url } = getReq(`/__studio/locate-directory?name=new-site&id=${ID}`);
      const res = await callApi(req, url);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { path: string | null };
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
});

// ─── assertCreatableParent ───────────────────────────────────────────────────

describe("assertCreatableParent", () => {
  test("rejects a relative parent", () => {
    expect(() => assertCreatableParent("sites/mine", ROOT)).toThrow(
      "Destination folder must be an absolute path",
    );
  });

  test("rejects an empty parent", () => {
    expect(() => assertCreatableParent("", ROOT)).toThrow(
      "Destination folder must be an absolute path",
    );
  });

  test("rejects a parent outside the root, the allowed roots, and home", () => {
    expect(() => assertCreatableParent(UNPERMITTED_PARENT, ROOT, [EXTERNAL])).toThrow(
      "Destination folder is outside the permitted roots",
    );
  });

  test("accepts a parent under the server root", () => {
    expect(() => assertCreatableParent(join(ROOT, "nested", "deep"), ROOT)).not.toThrow();
  });

  test("accepts a parent under an allowedRoots entry", () => {
    expect(() => assertCreatableParent(join(EXTERNAL, "sites"), ROOT, [EXTERNAL])).not.toThrow();
  });

  test("accepts a parent under the home directory", () => {
    expect(() => assertCreatableParent(join(homedir(), "jx-sites"), ROOT)).not.toThrow();
  });
});

// ─── create-project ──────────────────────────────────────────────────────────

/** A create-project body pointed at `parent`, which the modal always supplies. */
function createReq(body: Record<string, unknown>, parent: string = ROOT) {
  return jsonReq("/__studio/create-project", "POST", {
    destination: { kind: "path", parent },
    ...body,
  });
}

describe("create-project", () => {
  test("requires name and directory", async () => {
    const { req, url } = createReq({ name: "x" });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("name and directory are required");
  });

  test("requires a destination — the project never lands somewhere the user did not choose", async () => {
    const { req, url } = jsonReq("/__studio/create-project", "POST", {
      directory: "nowhere-site",
      name: "Nowhere",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("A destination folder is required.");
    expect(existsSync(join(ROOT, "nowhere-site"))).toBe(false);
  });

  test("rejects a repo destination — the dev server only scaffolds on disk", async () => {
    const { req, url } = jsonReq("/__studio/create-project", "POST", {
      destination: { kind: "repo", owner: "acme", private: false, repo: "site" },
      directory: "repo-site",
      name: "Repo Site",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("A destination folder is required.");
  });

  test("rejects a relative destination parent", async () => {
    const { req, url } = createReq({ directory: "escape", name: "Escape" }, "relative/parent");
    const res = await callApi(req, url);
    // A bad destination is client input, so it answers 400 like the other destination refusals —
    // Not the catch-all 500.
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toContain("must be an absolute path");
  });

  test("rejects a directory that is a path rather than a folder name", async () => {
    // The parent passes the creatable check, but joining a "../" directory onto it would land the
    // Project outside the folder the user actually chose.
    const { req, url } = createReq({ directory: "../../escape", name: "Escape" }, ROOT);
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toContain("folder name, not a path");
    // Nothing was scaffolded at the escaped path (which may itself already exist as a plain dir).
    expect(existsSync(resolve(ROOT, "../../escape/project.json"))).toBe(false);
  });

  test("rejects a destination parent outside the permitted roots", async () => {
    const { req, url } = createReq({ directory: "escape", name: "Escape" }, UNPERMITTED_PARENT);
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toContain("outside the permitted roots");
  });

  test("generates a new project and returns its config", async () => {
    const { req, url } = createReq({
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

  test("scaffolds under the chosen parent and returns an absolute root when it is outside the server root", async () => {
    const { req, url } = createReq({ directory: "away-site", name: "Away Site" }, OUTSIDE_PARENT);
    const res = await callApi(req, url, ROOT, null, { allowedRoots: [FIXTURES] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toBe(join(OUTSIDE_PARENT, "away-site"));
    expect(body.config.name).toBe("Away Site");
    expect(existsSync(join(OUTSIDE_PARENT, "away-site", "project.json"))).toBe(true);
    // Nothing was written under the server root.
    expect(existsSync(join(ROOT, "away-site"))).toBe(false);
  });

  test("notifies onProjectCreated with the absolute root even when the response root is relative", async () => {
    const created: string[] = [];
    const { req, url } = createReq({ directory: "notified-site", name: "Notified Site" });
    const res = await callApi(req, url, ROOT, null, {
      onProjectCreated: (projectRoot) => created.push(projectRoot),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toBe("notified-site");
    expect(created).toEqual([join(ROOT, "notified-site")]);
  });

  test("clones a starter template when one is selected", async () => {
    const { req, url } = createReq({
      directory: "from-starter",
      name: "My Cafe",
      starter: "restaurant",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toBe("from-starter");
    expect(body.config.name).toBe("My Cafe");
    // The starter's menu content collection came along with the clone.
    expect(existsSync(join(ROOT, "from-starter", "content", "menu"))).toBe(true);
  });

  test("applies a built-in template variant", async () => {
    const { req, url } = createReq({
      directory: "from-template",
      name: "My App",
      template: "mobile-first",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.$media["--"]).toBe("375px");
    expect(body.config.$media["--lg"]).toBe("(min-width: 1024px)");
  });

  test("applies design quickstart options to the generated project", async () => {
    const { req, url } = createReq({
      design: {
        accent: "#ff5500",
        media: { "--": "1440px", "--sm": "(max-width: 600px)" },
      },
      directory: "designed-site",
      name: "Designed Site",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.style["--color-primary"]).toBe("#ff5500");
    expect(body.config.$media).toEqual({ "--": "1440px", "--sm": "(max-width: 600px)" });
  });

  test("rejects an unknown template id", async () => {
    const { req, url } = createReq({
      directory: "bad-template",
      name: "Bad",
      template: "spaceship",
    });
    const res = await callApi(req, url);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toContain("Unknown template");
    expect(existsSync(join(ROOT, "bad-template"))).toBe(false);
  });
});

describe("starters", () => {
  test("lists the available starter templates", async () => {
    const { req, url } = getReq("/__studio/starters");
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const starters = (await res.json()) as { id: string }[];
    expect(Array.isArray(starters)).toBe(true);
    expect(starters.some((s) => s.id === "restaurant")).toBe(true);
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

  test("reports files outside the active project relative to the server root", async () => {
    // Listing the SERVER root while an external project is active: entries are not under the
    // Project root, so they are reported relative to the server root instead.
    const { req, url } = getReq(`/__studio/files?dir=${encodeURIComponent(ROOT)}&glob=*.txt`);
    const res = await callApi(req, url, ROOT, EXTERNAL);
    expect(res.status).toBe(200);
    const files = (await res.json()) as { path: string }[];
    expect(files.map((f) => f.path)).toContain("blocker.txt");
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

  test("includes extension-declared component formats in the scan", async () => {
    const { req, url } = getReq("/__studio/components?dir=comp-ext-proj");
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const components = (await res.json()) as { tagName: string }[];
    expect(components.some((c) => c.tagName === "x-card")).toBe(true);
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

  test("remove reports a non-zero bun exit with its stderr", async () => {
    // An empty dir outside any package tree: the spawn succeeds, but `bun remove` finds no
    // Package.json and exits non-zero.
    const emptyDir = mkdtempSync(join(tmpdir(), "jx-remove-fail-"));
    try {
      const { req, url } = jsonReq("/__studio/packages/remove", "POST", {
        dir: emptyDir,
        name: "anything",
      });
      const res = await callApi(req, url);
      expect(res.status).toBe(500);
      const payload = (await res.json()) as { error: string };
      expect(payload.error.length).toBeGreaterThan(0);
    } finally {
      rmSync(emptyDir, { force: true, recursive: true });
    }
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

  test("uses a field initializer as the default when no explicit default exists", async () => {
    const { req, url } = getReq("/__studio/plugin-schema?src=./Init.class.json");
    const res = await callApi(req, url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schema: { properties: Record<string, { default?: unknown }> };
    };
    expect(body.schema.properties.count!.default).toBe(7);
    expect((body.schema.properties.count as { examples?: number[] }).examples).toEqual([1, 2, 3]);
    // An explicit default always wins over the initializer.
    expect(body.schema.properties.fixed!.default).toBe("abc");
  });
});

// ─── error paths reached through a vanished server root ──────────────────────

describe("vanished server root — scan error paths", () => {
  const GHOST = join(FIXTURES, "ghost-root");

  test("sites returns 500 when the scan root cannot be read", async () => {
    const { req, url } = getReq("/__studio/sites");
    const res = await callApi(req, url, GHOST);
    expect(res.status).toBe(500);
  });

  test("locate returns 500 when the scan root cannot be read", async () => {
    const { req, url } = jsonReq("/__studio/locate", "POST", { name: "page.json" });
    const res = await callApi(req, url, GHOST);
    expect(res.status).toBe(500);
  });

  test("components returns 500 when the scan root cannot be read", async () => {
    const { req, url } = getReq("/__studio/components");
    const res = await callApi(req, url, GHOST);
    expect(res.status).toBe(500);
  });
});

// ─── data-api delegation ─────────────────────────────────────────────────────

describe("data-api delegation", () => {
  test("data routes are answered by the data-api delegate", async () => {
    const { req, url } = getReq("/__studio/data/connections");
    const res = await callApi(req, url);
    expect(res.headers.get("Content-Type")).toContain("application/json");
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
