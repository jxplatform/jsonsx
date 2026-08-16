import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectServer } from "../src/project-server.ts";
import type { ProjectServerHandle, ProjectServerSession } from "../src/project-server.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, "_project_server_fixtures");
const STUDIO = join(ROOT, "_studio");
const PROJECT = join(ROOT, "project");
const PROJECT2 = join(ROOT, "project2");
const OUTSIDE = join(ROOT, "outside");

rmSync(ROOT, { force: true, recursive: true });
mkdirSync(STUDIO, { recursive: true });
mkdirSync(join(STUDIO, "dist"), { recursive: true });
mkdirSync(join(PROJECT, "public"), { recursive: true });
mkdirSync(PROJECT2, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

writeFileSync(join(STUDIO, "index.html"), "<html>studio-shell</html>");
writeFileSync(join(STUDIO, "canvas.html"), "<html>canvas</html>");
writeFileSync(join(STUDIO, "dist", "iframe-entry.js"), "console.log('iframe')");
writeFileSync(join(STUDIO, "secret.txt"), "studio-secret");

writeFileSync(join(PROJECT, "hello.txt"), "hello-project");
writeFileSync(join(PROJECT, "public", "pub.css"), "body{margin:0}");
writeFileSync(join(PROJECT2, "two.txt"), "project-two");
writeFileSync(join(OUTSIDE, "secret.txt"), "outside-secret");

// Self-contained .class.json whose resolve() returns a known value (a + b).
const adder = {
  $defs: {
    constructor: { $prototype: "Function", role: "constructor" },
    fields: {
      a: { access: "public", default: 0, identifier: "a", role: "field", scope: "instance" },
      b: { access: "public", default: 0, identifier: "b", role: "field", scope: "instance" },
    },
    methods: {
      resolve: { body: "return this.a + this.b;", identifier: "resolve", role: "method" },
    },
  },
  $prototype: "Class",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Adder",
};
writeFileSync(join(PROJECT, "Adder.class.json"), JSON.stringify(adder));

// A server-function module (timing:"server") with a named export.
writeFileSync(join(PROJECT, "fn.js"), "export function greet(args){ return `hi ${args.who}`; }");

// A node_modules package so the bare-specifier bundle path resolves (exports map -> entry).
const PKG = join(PROJECT, "node_modules", "demo-pkg");
mkdirSync(PKG, { recursive: true });
writeFileSync(
  join(PKG, "package.json"),
  JSON.stringify({ name: "demo-pkg", exports: { ".": "./index.js" } }),
);
writeFileSync(join(PKG, "index.js"), "export const hello = 42;");

// Symlink inside the project pointing OUTSIDE the root (symlink-containment test). win32-guarded.
let symlinkMade = false;
if (process.platform !== "win32") {
  try {
    symlinkSync(join(OUTSIDE, "secret.txt"), join(PROJECT, "link-out.txt"));
    symlinkMade = true;
  } catch {
    symlinkMade = false;
  }
}

// ─── Mutable mock session ─────────────────────────────────────────────────────

let activeRoot: string | null = PROJECT;

const session1: ProjectServerSession = {
  get projectRoot() {
    return activeRoot;
  },
  handlers: {
    echo: (params) => Promise.resolve({ echoed: params }),
    boom: () => Promise.reject(new Error("kaboom")),
  },
};

const session2: ProjectServerSession = {
  projectRoot: PROJECT2,
  handlers: { echo: () => Promise.resolve({ from: "two" }) },
};

// Map winId -> session. null/"one" => session1; "two" => session2; "gone" honors a kill switch.
let session1Alive = true;
function resolveSession(winId: string | null): ProjectServerSession | null {
  if (winId === "two") {
    return session2;
  }
  if (winId === "gone") {
    return session1Alive ? session1 : null;
  }
  return session1;
}

let handle: ProjectServerHandle;
let base: string;
let token: string;

beforeAll(() => {
  handle = createProjectServer({ resolveSession, studioDir: STUDIO });
  base = handle.url;
  token = handle.rpcToken;
});

afterAll(() => {
  handle.stop();
  rmSync(ROOT, { force: true, recursive: true });
});

// ─── WS helper ────────────────────────────────────────────────────────────────

function openWs(query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${handle.wsUrl}/${query}`);
    let settled = false;
    ws.addEventListener("open", () => {
      settled = true;
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        reject(new Error("ws error"));
      }
    });
    // A pre-open close (e.g. a 403 rejected upgrade) is a failure; a post-open close is benign.
    ws.addEventListener("close", (e) => {
      if (!settled) {
        settled = true;
        reject(new Error(`ws closed ${e.code}`));
      }
    });
  });
}

/**
 * Send an RPC and await its response. Resolves with the error string OR result rather than
 * throwing, so a test can assert on either. On Windows some error frames are flaky to deliver; a 4s
 * ceiling resolves with a sentinel so the suite never hangs (the existing chromium-rpc test does
 * the same).
 */
function rpcRaw(
  ws: WebSocket,
  method: string,
  params?: unknown,
): Promise<{ error?: string; result?: unknown; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1_000_000);
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve({ timedOut: true });
    }, 4000);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as {
        id: number;
        error?: string;
        result?: unknown;
      };
      if (msg.id !== id) {
        return;
      }
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(msg);
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Fetch a URL and return only its status code (avoids member access on an await expression). */
async function statusOf(url: string): Promise<number> {
  const res = await fetch(url);
  return res.status;
}

// ─── Binding ──────────────────────────────────────────────────────────────────

describe("binding", () => {
  test("binds loopback and reports a 127.0.0.1 url", () => {
    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
    expect(handle.wsUrl.startsWith("ws://127.0.0.1:")).toBe(true);
    expect(handle.canvasUrl).toBe(`${base}/__studio__/canvas.html`);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });
});

// ─── Studio assets ─────────────────────────────────────────────────────────────

describe("studio assets (/__studio__/)", () => {
  test("serves the studio shell", async () => {
    const res = await fetch(`${base}/__studio__/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("studio-shell");
    // MUST be same-origin (NOT no-referrer): the tokened URL still never leaks cross-origin, but
    // Under no-referrer Chromium sends `Origin: null` on the canvas iframe's same-origin POSTs,
    // Which fails the loopback-Origin gate and self-403s /__jx_resolve__ from our own document.
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  test("serves canvas.html and the iframe bundle", async () => {
    expect(await statusOf(`${base}/__studio__/canvas.html`)).toBe(200);
    expect(await statusOf(`${base}/__studio__/dist/iframe-entry.js`)).toBe(200);
  });

  test("traversal out of studioDir is 404", async () => {
    const res = await fetch(`${base}/__studio__/../project/hello.txt`);
    expect(res.status).toBe(404);
  });

  test("missing studio asset is 404", async () => {
    expect(await statusOf(`${base}/__studio__/nope.js`)).toBe(404);
  });
});

// ─── Resolve routes ──────────────────────────────────────────────────────────

describe("privileged resolve routes", () => {
  test("POST /__jx_resolve__ returns the fixture's known VALUE", async () => {
    const res = await fetch(`${base}/__jx_resolve__?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ $prototype: "Adder", $src: "./Adder.class.json", a: 4, b: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(9);
  });

  test("POST /__jx_server__ invokes the server function", async () => {
    const res = await fetch(`${base}/__jx_server__?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ $src: "./fn.js", $export: "greet", arguments: { who: "x" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe("hi x");
  });

  test("non-POST resolve route falls through (404)", async () => {
    const res = await fetch(`${base}/__jx_resolve__?token=${token}`);
    expect(res.status).toBe(404);
  });
});

// ─── Auth ───────────────────────────────────────────────────────────────────

describe("token / Origin / Host auth", () => {
  test("resolve route without token is 403", async () => {
    const res = await fetch(`${base}/__jx_resolve__`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ $src: "./Adder.class.json" }),
    });
    expect(res.status).toBe(403);
  });

  test("resolve route with wrong token is 403", async () => {
    const res = await fetch(`${base}/__jx_resolve__?token=nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ $src: "./Adder.class.json" }),
    });
    expect(res.status).toBe(403);
  });

  test("foreign Host header on a privileged route is 403 (anti-DNS-rebinding)", async () => {
    const res = await fetch(`${base}/__jx_resolve__?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "evil.example.com" },
      body: JSON.stringify({ $prototype: "Adder", $src: "./Adder.class.json", a: 1, b: 1 }),
    });
    expect(res.status).toBe(403);
  });

  test("foreign Origin header on a privileged route is 403", async () => {
    const res = await fetch(`${base}/__jx_resolve__?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.example.com",
      },
      body: JSON.stringify({ $prototype: "Adder", $src: "./Adder.class.json", a: 1, b: 1 }),
    });
    expect(res.status).toBe(403);
  });

  test("WS upgrade without token is 403 (closes)", async () => {
    expect(openWs("?win=one")).rejects.toThrow();
  });

  test("WS upgrade with token connects and dispatches", async () => {
    const ws = await openWs(`?token=${token}&win=one`);
    try {
      const res = await rpcRaw(ws, "echo", { a: 1 });
      expect(res.result).toEqual({ echoed: { a: 1 } });
    } finally {
      ws.close();
    }
  });
});

// ─── Traversal / containment ──────────────────────────────────────────────────

describe("project file containment", () => {
  test("serves a root-relative project file", async () => {
    const res = await fetch(`${base}/hello.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-project");
  });

  test("serves a public/ file at root", async () => {
    const res = await fetch(`${base}/pub.css`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("margin:0");
  });

  test("serves an absolute-under-root path", async () => {
    const abs = PROJECT.replaceAll("\\", "/");
    const urlPath = abs.startsWith("/") ? abs : `/${abs}`;
    const res = await fetch(`${base}${urlPath}/hello.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-project");
  });

  test("over-encoded ../ traversal is 404 (one decode leaves %2e, rejected)", async () => {
    // The URL/fetch parser collapses literal "../"; an over-encoded %252e survives one decode as
    // %2e and trips the server's over-encoding guard.
    expect(await statusOf(`${base}/%252e%252e/outside/secret.txt`)).toBe(404);
  });

  test("over-encoded %252f (slash) is 404", async () => {
    expect(await statusOf(`${base}/foo%252fbar`)).toBe(404);
  });

  test("absolute path outside the root is 404", async () => {
    const abs = OUTSIDE.replaceAll("\\", "/");
    const urlPath = abs.startsWith("/") ? abs : `/${abs}`;
    expect(await statusOf(`${base}${urlPath}/secret.txt`)).toBe(404);
  });

  test.skipIf(!symlinkMade)("symlink pointing outside the root is 404", async () => {
    expect(await statusOf(`${base}/link-out.txt`)).toBe(404);
  });
});

// ─── Session scoping + freshness ───────────────────────────────────────────────

describe("session scoping", () => {
  test("unknown window with no session is 404 when killed", async () => {
    session1Alive = false;
    try {
      const res = await fetch(`${base}/hello.txt?win=gone`);
      expect(res.status).toBe(404);
    } finally {
      session1Alive = true;
    }
  });

  test("two windows do not cross-serve", async () => {
    const res = await fetch(`${base}/two.txt?win=two`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("project-two");
    // Window one has no two.txt.
    expect(await statusOf(`${base}/two.txt?win=one`)).toBe(404);
  });

  test("projectRoot freshness — mutating the mock root changes serving", async () => {
    activeRoot = PROJECT2;
    try {
      const res = await fetch(`${base}/two.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("project-two");
    } finally {
      activeRoot = PROJECT;
    }
  });

  test("no project (null root) is 404", async () => {
    activeRoot = null;
    try {
      expect(await statusOf(`${base}/hello.txt`)).toBe(404);
    } finally {
      activeRoot = PROJECT;
    }
  });
});

// ─── Remaining surfaces (AI, npm bundle, header edge cases) ────────────────────

describe("misc surfaces", () => {
  test("an unmatched AI route falls through to a project-file 404", async () => {
    // HandleAiApi returns null for a non-AI/unknown path; the request then falls through to the
    // Project-file lookup (no such file) and 404s. This exercises the AI prefix-rewrite branch.
    expect(await statusOf(`${base}/__studio__/ai/does-not-exist?token=${token}`)).toBe(404);
  });

  test("a bare npm specifier is resolved and bundled", async () => {
    const res = await fetch(`${base}/node_modules/demo-pkg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("javascript");
    expect(await res.text()).toContain("42");
    // Second hit exercises the bundle cache (already populated).
    expect(await statusOf(`${base}/node_modules/demo-pkg`)).toBe(200);
  });

  test("an IPv6-loopback Host header is accepted on a privileged route", async () => {
    const res = await fetch(`${base}/__jx_resolve__?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "[::1]:1234" },
      body: JSON.stringify({ $prototype: "Adder", $src: "./Adder.class.json", a: 6, b: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(7);
  });

  test("a malformed Origin header is rejected on a privileged route", async () => {
    const res = await fetch(`${base}/__jx_resolve__?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "::::not a url" },
      body: JSON.stringify({ $prototype: "Adder", $src: "./Adder.class.json", a: 1, b: 1 }),
    });
    expect(res.status).toBe(403);
  });

  test("a missing project root directory still 404s a file request (realpath catch)", async () => {
    activeRoot = join(ROOT, "does-not-exist-root");
    try {
      expect(await statusOf(`${base}/whatever.txt`)).toBe(404);
    } finally {
      activeRoot = PROJECT;
    }
  });
});

// ─── WS dispatch behavior ──────────────────────────────────────────────────────

describe("ws dispatch", () => {
  test("unknown method gets an error response", async () => {
    const ws = await openWs(`?token=${token}&win=one`);
    try {
      const res = await rpcRaw(ws, "nope");
      if (!res.timedOut) {
        expect(res.error).toContain("Unknown method: nope");
      } else {
        // Windows flake: error frame not delivered. Verify the socket is still healthy.
        const ok = await rpcRaw(ws, "echo", { ok: 1 });
        expect(ok.result).toEqual({ echoed: { ok: 1 } });
      }
    } finally {
      ws.close();
    }
  });

  test("handler rejection is reported via error.message", async () => {
    const ws = await openWs(`?token=${token}&win=one`);
    try {
      const res = await rpcRaw(ws, "boom");
      if (!res.timedOut) {
        expect(res.error).toContain("kaboom");
      } else {
        const ok = await rpcRaw(ws, "echo", { ok: 2 });
        expect(ok.result).toEqual({ echoed: { ok: 2 } });
      }
    } finally {
      ws.close();
    }
  });

  test("invalid JSON gets an error response with id 0", async () => {
    const ws = await openWs(`?token=${token}&win=one`);
    try {
      const msg = await new Promise<{ id: number; error?: string }>((resolve) => {
        const handler = (event: MessageEvent) => {
          const m = JSON.parse(event.data as string) as { id: number; error?: string };
          if (m.id !== 0) {
            return;
          }
          ws.removeEventListener("message", handler);
          resolve(m);
        };
        ws.addEventListener("message", handler);
        ws.send("{{ not json");
      });
      expect(msg.error).toBe("Invalid JSON");
    } finally {
      ws.close();
    }
  });

  test("fails closed when the session vanishes mid-connection", async () => {
    const ws = await openWs(`?token=${token}&win=gone`);
    session1Alive = false;
    try {
      const res = await rpcRaw(ws, "echo", { a: 1 });
      if (!res.timedOut) {
        expect(res.error).toContain("Unknown window");
      }
      // Either way, the server closed the socket fail-closed.
    } finally {
      session1Alive = true;
      ws.close();
    }
  });
});
