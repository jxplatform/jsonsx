/**
 * Coverage-gaps.test.ts — integration coverage for dev-server and project-server branches the other
 * suites do not reach: the /_jx extension-mount route on both servers, the import-site delegation,
 * create-project at a user-chosen destination and the activate that follows it, the absolute-path
 * static miss under an active project, npm exports mappings whose target file is gone, a failed
 * WebSocket upgrade, the project server's AI route, and an npm bundle failure on the project
 * server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createDevServer, resolveNpmPath } from "../src/server.ts";
import { createProjectServer } from "../src/project-server.ts";
import type { ProjectServerHandle } from "../src/project-server.ts";

const FIXTURES = resolve(import.meta.dir, "_coverage_gaps_fixtures");
const SERVER_ROOT = join(FIXTURES, "server-root");
const EXTERNAL_ROOT = join(FIXTURES, "external-root");
const PS_PROJECT = join(FIXTURES, "ps-project");
const STUDIO = join(FIXTURES, "studio");

/** Write the echo extension used to exercise the /_jx mount dispatch on both servers. */
function writeEchoExtension(root: string) {
  const ext = join(root, "mount-ext");
  mkdirSync(ext, { recursive: true });
  writeFileSync(
    join(ext, "jx-extension.json"),
    JSON.stringify({ classes: { Echo: "./Echo.class.json" }, name: "echo-ext" }),
  );
  writeFileSync(
    join(ext, "Echo.class.json"),
    JSON.stringify({
      $defs: {
        methods: {
          mount: { identifier: "mount", role: "mount", scope: "static", timing: ["server"] },
        },
      },
      $implementation: "./echo.js",
      server: { basePath: "/_jx/echo", order: 5 },
      title: "Echo",
    }),
  );
  writeFileSync(
    join(ext, "echo.ts"),
    [
      "export const Echo = {",
      "  mount(options: Record<string, unknown>) {",
      "    return async (request: Request, env: Record<string, unknown>) =>",
      "      Response.json({ basePath: options.basePath, root: env.JX_PROJECT_ROOT });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "project.json"),
    JSON.stringify({ extensions: ["./mount-ext"], name: "Gap Mounts" }),
  );
}

let devServer: { port: number; stop: (force?: boolean) => void };
let projectServer: ProjectServerHandle;
/**
 * Where the New Project modal "chose" to put the project. It has to sit under the home directory
 * but under neither the server root nor an allowed root, so that the follow-up activate can only
 * succeed because the server remembered what it just created. Anchoring it to homedir() keeps that
 * relationship true wherever the checkout lives.
 */
let createdParent: string;
/** Temp home-directory sandbox holding {@link ownedProject}, an existing project of the account's. */
let ownedHome: string;
let ownedProject: string;

beforeAll(async () => {
  rmSync(FIXTURES, { force: true, recursive: true });
  createdParent = mkdtempSync(join(homedir(), ".jx-server-created-"));

  // Dev-server root: echo mounts, an activatable project subdir, and an npm package whose
  // Exports map points at a missing file while the direct subpath exists.
  mkdirSync(join(SERVER_ROOT, "proj"), { recursive: true });
  writeEchoExtension(SERVER_ROOT);
  const ghost = join(SERVER_ROOT, "node_modules", "ghostpkg");
  mkdirSync(ghost, { recursive: true });
  writeFileSync(
    join(ghost, "package.json"),
    JSON.stringify({ exports: { "./sub": "./missing.js" }, name: "ghostpkg" }),
  );
  writeFileSync(join(ghost, "sub"), "export const direct = 1;");

  // Project-server project: echo mounts plus a package whose entry cannot be bundled.
  mkdirSync(PS_PROJECT, { recursive: true });
  writeEchoExtension(PS_PROJECT);
  const bad = join(PS_PROJECT, "node_modules", "badpkg");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "package.json"), JSON.stringify({ main: "./index.js", name: "badpkg" }));
  writeFileSync(
    join(bad, "index.js"),
    'import x from "totally-unresolvable-module-xyz"; export default x;',
  );

  mkdirSync(STUDIO, { recursive: true });
  writeFileSync(join(STUDIO, "index.html"), "<html>studio</html>");

  // External project dir, permitted only through allowedRoots.
  mkdirSync(EXTERNAL_ROOT, { recursive: true });
  writeFileSync(join(EXTERNAL_ROOT, "external.txt"), "external data");

  // A project the account already has on disk — what a ?project= deep link or the recent-projects
  // List points at. Permitted by nothing but its own project.json plus living under the home dir.
  ownedHome = mkdtempSync(join(homedir(), ".jx-owned-project-"));
  ownedProject = join(ownedHome, "my-site");
  mkdirSync(ownedProject, { recursive: true });
  writeFileSync(join(ownedProject, "project.json"), JSON.stringify({ name: "My Site" }));
  writeFileSync(join(ownedProject, "owned.txt"), "owned data");

  devServer = (await createDevServer({
    allowedRoots: [EXTERNAL_ROOT],
    builds: [],
    port: 0,
    root: SERVER_ROOT,
    studio: true,
    watch: false,
  })) as unknown as { port: number; stop: (force?: boolean) => void };

  projectServer = createProjectServer({
    resolveSession: () => ({ handlers: {}, projectRoot: PS_PROJECT }),
    studioDir: STUDIO,
  });
});

afterAll(() => {
  devServer.stop(true);
  projectServer.stop();
  rmSync(FIXTURES, { force: true, recursive: true });
  rmSync(createdParent, { force: true, recursive: true });
  rmSync(ownedHome, { force: true, recursive: true });
});

// ─── Dev server ───────────────────────────────────────────────────────────────

describe("dev server — extension mounts (/_jx)", () => {
  test("dispatches a claimed path to the project's mount", async () => {
    const res = await fetch(`http://localhost:${devServer.port}/_jx/echo/anything`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { basePath: string; root: string };
    expect(body.basePath).toBe("/_jx/echo");
    expect(body.root).toBe(SERVER_ROOT);
  });

  test("an unclaimed /_jx path falls through to a 404", async () => {
    const res = await fetch(`http://localhost:${devServer.port}/_jx/unclaimed/route`);
    expect(res.status).toBe(404);
  });
});

describe("dev server — import-site delegation", () => {
  test("routes POST /__studio/import-site to the import handler", async () => {
    const res = await fetch(`http://localhost:${devServer.port}/__studio/import-site`, {
      body: "{not json",
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid JSON");
  });
});

describe("dev server — AI proxy delegation", () => {
  test("routes /__studio/ai/models to the AI handler", async () => {
    const res = await fetch(`http://localhost:${devServer.port}/__studio/ai/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(Array.isArray(body.models)).toBe(true);
  });
});

describe("dev server — absolute paths under the active project", () => {
  test("a missing file at an absolute project path falls through to a 404", async () => {
    const activate = await fetch(`http://localhost:${devServer.port}/__studio/activate`, {
      body: JSON.stringify({ root: "proj" }),
      method: "POST",
    });
    expect(activate.status).toBe(200);
    const abs = join(SERVER_ROOT, "proj", "missing.txt");
    const res = await fetch(`http://localhost:${devServer.port}//${abs.replace(/^\//, "")}`);
    expect(res.status).toBe(404);
  });

  test("activate permits an existing project of the account's own", async () => {
    // The ?project=/abs/path deep link: a project under the user's home, outside the server root
    // And outside allowedRoots, which this server did not create.
    const activate = await fetch(`http://localhost:${devServer.port}/__studio/activate`, {
      body: JSON.stringify({ root: ownedProject }),
      method: "POST",
    });
    expect(activate.status).toBe(200);
    expect(await activate.json()).toEqual({ ok: true, root: ownedProject });

    // Activation is what makes the filesystem API answer for the project — the listing that
    // Followed the deep link used to 400 with "Path outside project root".
    const listing = await fetch(
      `http://localhost:${devServer.port}/__studio/files?dir=${encodeURIComponent(ownedProject)}`,
    );
    expect(listing.status).toBe(200);
    const names = ((await listing.json()) as { name: string }[]).map((e) => e.name);
    expect(names).toContain("project.json");
  });

  test("activate still refuses a home directory that holds no project", async () => {
    const activate = await fetch(`http://localhost:${devServer.port}/__studio/activate`, {
      body: JSON.stringify({ root: ownedHome }),
      method: "POST",
    });
    expect(activate.status).toBe(403);
    expect(await activate.json()).toEqual({ error: "root not permitted", ok: false });
  });

  test("activate permits an external project dir listed in allowedRoots", async () => {
    const activate = await fetch(`http://localhost:${devServer.port}/__studio/activate`, {
      body: JSON.stringify({ root: EXTERNAL_ROOT }),
      method: "POST",
    });
    expect(activate.status).toBe(200);
    const body = (await activate.json()) as { ok: boolean; root: string };
    expect(body.ok).toBe(true);
    expect(body.root).toBe(EXTERNAL_ROOT);
    // Files from the allowed external root are now served through the project fallback.
    const res = await fetch(`http://localhost:${devServer.port}/external.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("external data");
  });
});

describe("dev server — create-project at a chosen destination", () => {
  test("refuses to create anything without a destination", async () => {
    const res = await fetch(`http://localhost:${devServer.port}/__studio/create-project`, {
      body: JSON.stringify({ directory: "unwanted", name: "Unwanted" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("A destination folder is required.");
    expect(existsSync(join(SERVER_ROOT, "unwanted"))).toBe(false);
  });

  test("scaffolds at the chosen parent and permits activating what it just created", async () => {
    const res = await fetch(`http://localhost:${devServer.port}/__studio/create-project`, {
      body: JSON.stringify({
        destination: { kind: "path", parent: createdParent },
        directory: "made-here",
        name: "Made Here",
      }),
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { name: string }; root: string };
    // Outside the server root, so the root comes back absolute rather than root-relative.
    expect(body.root).toBe(join(createdParent, "made-here"));
    expect(body.config.name).toBe("Made Here");
    expect(existsSync(join(createdParent, "made-here", "project.json"))).toBe(true);

    // The server remembered the new root, so the activate Studio sends next is permitted even
    // Though the project sits under neither the server root nor allowedRoots.
    const activate = await fetch(`http://localhost:${devServer.port}/__studio/activate`, {
      body: JSON.stringify({ root: body.root }),
      method: "POST",
    });
    expect(activate.status).toBe(200);
    const activated = (await activate.json()) as { ok: boolean; root: string };
    expect(activated.ok).toBe(true);
    expect(activated.root).toBe(join(createdParent, "made-here"));
  });

  test("still refuses to activate a directory it never created", async () => {
    const activate = await fetch(`http://localhost:${devServer.port}/__studio/activate`, {
      body: JSON.stringify({ root: join(createdParent, "never-made") }),
      method: "POST",
    });
    expect(activate.status).toBe(403);
  });
});

describe("resolveNpmPath — exports mapping to a missing file", () => {
  test("falls back to the direct subpath when the exports target does not exist", () => {
    const resolved = resolveNpmPath(SERVER_ROOT, "/ghostpkg/sub");
    expect(resolved).toBe(join(SERVER_ROOT, "node_modules", "ghostpkg", "sub"));
  });
});

// ─── Project server ───────────────────────────────────────────────────────────

describe("project server — coverage gaps", () => {
  test("a tokened non-WebSocket upgrade request is a 400", async () => {
    // An Upgrade header without the WebSocket handshake headers: the gate passes but the
    // Protocol upgrade itself must fail.
    const res = await fetch(`${projectServer.url}/?token=${projectServer.rpcToken}`, {
      headers: { connection: "upgrade", upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Upgrade failed");
  });

  test("answers the AI models listing under the studio namespace", async () => {
    const res = await fetch(`${projectServer.url}/__studio__/ai/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(Array.isArray(body.models)).toBe(true);
  });

  test("dispatches /_jx to the project's extension mounts", async () => {
    const res = await fetch(`${projectServer.url}/_jx/echo/anything`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { basePath: string; root: string };
    expect(body.basePath).toBe("/_jx/echo");
    expect(body.root).toBe(PS_PROJECT);
  });

  test("an unclaimed /_jx path falls through to a 404", async () => {
    const res = await fetch(`${projectServer.url}/_jx/unclaimed/route`);
    expect(res.status).toBe(404);
  });

  test("a package that fails to bundle is a 404, not a crash", async () => {
    const res = await fetch(`${projectServer.url}/badpkg`);
    expect(res.status).toBe(404);
  });
});
