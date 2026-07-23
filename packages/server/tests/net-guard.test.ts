import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  containedPath,
  decodeAndNormalizePath,
  hostIsLoopbackOrAbsent,
  isLoopbackHost,
  loopbackGate,
  originHostGate,
  originIsLoopbackOrAbsent,
  serveContained,
  serveProjectFile,
} from "../src/net-guard.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, "_net_guard_fixtures");
const PROJECT = join(ROOT, "project");
const OUTSIDE = join(ROOT, "outside");
let symlinkCreated = false;

beforeAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
  mkdirSync(join(PROJECT, "public"), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(PROJECT, "index.html"), "<html>in-root</html>");
  writeFileSync(join(PROJECT, "public", "style.css"), "body{}");
  writeFileSync(join(OUTSIDE, "secret.txt"), "top-secret");
  // A symlink INSIDE the root pointing OUTSIDE it — realpath containment must reject reads through it.
  try {
    symlinkSync(join(OUTSIDE, "secret.txt"), join(PROJECT, "escape.txt"));
    symlinkCreated = true;
  } catch {
    // Symlink creation can fail on restricted filesystems; the symlink-escape test guards for it.
  }
});

afterAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
});

const reqWith = (headers: Record<string, string>): Request =>
  new Request("http://127.0.0.1/x", { headers });

// ─── isLoopbackHost ───────────────────────────────────────────────────────

describe("isLoopbackHost", () => {
  test("accepts loopback literals with and without ports", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3000")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST:8080")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("[::1]:3000")).toBe(true);
  });

  test("rejects non-loopback and empty hosts", () => {
    expect(isLoopbackHost("evil.example")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});

// ─── Origin / Host checks ───────────────────────────────────────────────────

describe("originIsLoopbackOrAbsent", () => {
  test("accepts absent Origin (Bun-native / test clients)", () => {
    expect(originIsLoopbackOrAbsent(reqWith({}))).toBe(true);
  });
  test("accepts a loopback Origin", () => {
    expect(originIsLoopbackOrAbsent(reqWith({ origin: "http://localhost:3000" }))).toBe(true);
  });
  test("rejects a cross-origin Origin", () => {
    expect(originIsLoopbackOrAbsent(reqWith({ origin: "https://evil.example" }))).toBe(false);
  });
  test("rejects an unparseable Origin", () => {
    expect(originIsLoopbackOrAbsent(reqWith({ origin: "not a url" }))).toBe(false);
  });
});

describe("hostIsLoopbackOrAbsent", () => {
  test("accepts absent Host", () => {
    expect(hostIsLoopbackOrAbsent(reqWith({}))).toBe(true);
  });
  test("rejects a non-loopback Host (DNS rebinding)", () => {
    expect(hostIsLoopbackOrAbsent(reqWith({ host: "evil.example" }))).toBe(false);
  });
});

// ─── Gates ──────────────────────────────────────────────────────────────────

describe("originHostGate", () => {
  test("returns null when loopback-safe", () => {
    expect(originHostGate(reqWith({ origin: "http://127.0.0.1:3000" }))).toBeNull();
  });
  test("returns 403 on cross-origin", () => {
    const res = originHostGate(reqWith({ origin: "https://evil.example" }));
    expect(res?.status).toBe(403);
  });
});

describe("loopbackGate", () => {
  const url = new URL("http://127.0.0.1/x?token=secret");

  test("passes with matching token and loopback origin", () => {
    expect(loopbackGate(reqWith({}), url, "secret")).toBeNull();
  });
  test("403 on token mismatch", () => {
    const res = loopbackGate(reqWith({}), url, "wrong");
    expect(res?.status).toBe(403);
  });
  test("skips token check when token is null (dev server)", () => {
    const noToken = new URL("http://127.0.0.1/x");
    expect(loopbackGate(reqWith({}), noToken, null)).toBeNull();
  });
  test("403 even with a good token when origin is cross-site", () => {
    const res = loopbackGate(reqWith({ origin: "https://evil.example" }), url, "secret");
    expect(res?.status).toBe(403);
  });
});

// ─── Path containment ───────────────────────────────────────────────────────

describe("containedPath", () => {
  test("returns a path inside the root", () => {
    expect(containedPath(join(PROJECT, "index.html"), PROJECT)).not.toBeNull();
  });
  test("rejects a lexical ../ escape", () => {
    expect(containedPath(join(PROJECT, "..", "outside", "secret.txt"), PROJECT)).toBeNull();
  });
  test("rejects a symlink that escapes the root", () => {
    // Only meaningful if the symlink was created in beforeAll.
    if (!symlinkCreated) {
      return;
    }
    expect(containedPath(join(PROJECT, "escape.txt"), PROJECT)).toBeNull();
  });
});

describe("serveContained", () => {
  test("serves an existing contained file", async () => {
    const res = await serveContained(join(PROJECT, "index.html"), PROJECT);
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain("in-root");
  });
  test("returns null for a traversed path", async () => {
    const res = await serveContained(join(PROJECT, "..", "outside", "secret.txt"), PROJECT);
    expect(res).toBeNull();
  });
});

describe("serveProjectFile", () => {
  test("serves a root-relative file", async () => {
    const res = await serveProjectFile("/index.html", PROJECT);
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain("in-root");
  });
  test("falls back to public/", async () => {
    const res = await serveProjectFile("/style.css", PROJECT);
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain("body{}");
  });
  test("returns null for a missing file", async () => {
    expect(await serveProjectFile("/nope.html", PROJECT)).toBeNull();
  });
  test("an absolute-under-root path to a missing file falls through to null", async () => {
    // A POSIX absolute path arrives as //abs/path; the abs branch misses, then the
    // Root-relative and public/ fallbacks miss too.
    expect(await serveProjectFile(`/${PROJECT}/nope.html`, PROJECT)).toBeNull();
  });

  describe("asset mounts", () => {
    // OUTSIDE sits next to the project, not under it — exactly the case mounts exist for.
    const mounts = [{ dir: OUTSIDE, urlPrefix: "/content/docs" }];

    test("serves a mounted file living outside the project root", async () => {
      const res = await serveProjectFile("/content/docs/secret.txt", PROJECT, mounts);
      expect(res).not.toBeNull();
      expect(await res!.text()).toBe("top-secret");
    });

    test("serves a mounted file whose name has a space (the caller decodes once)", async () => {
      writeFileSync(join(OUTSIDE, "my shot.png"), "png-bytes");
      const res = await serveProjectFile("/content/docs/my shot.png", PROJECT, mounts);
      expect(res).not.toBeNull();
      expect(await res!.text()).toBe("png-bytes");
    });

    test("the most specific mount wins when prefixes nest", async () => {
      mkdirSync(join(OUTSIDE, "images"), { recursive: true });
      writeFileSync(join(OUTSIDE, "images", "hero.png"), "nested-mount");
      const nested = [
        { dir: OUTSIDE, urlPrefix: "/content" },
        { dir: join(OUTSIDE, "images"), urlPrefix: "/content/docs" },
      ];

      const res = await serveProjectFile("/content/docs/hero.png", PROJECT, nested);

      expect(await res!.text()).toBe("nested-mount");
    });

    test("refuses to serve outside the mount directory", async () => {
      expect(
        await serveProjectFile("/content/docs/../project/index.html", PROJECT, mounts),
      ).toBeNull();
    });

    test("falls through when the URL matches no mount", async () => {
      expect(await serveProjectFile("/content/other/secret.txt", PROJECT, mounts)).toBeNull();
      expect(await serveProjectFile("/content/docs/gone.txt", PROJECT, mounts)).toBeNull();
    });

    test("without mounts the same URL is not served", async () => {
      expect(await serveProjectFile("/content/docs/secret.txt", PROJECT)).toBeNull();
    });
  });
});

// ─── URL decode hardening ───────────────────────────────────────────────────

describe("decodeAndNormalizePath", () => {
  test("decodes a normal path and collapses leading slashes", () => {
    const out = decodeAndNormalizePath(new URL("http://127.0.0.1//a/b"));
    expect(out).toEqual({ path: "//a/b", normPath: "/a/b" });
  });
  test("rejects an over-encoded traversal (%2e/%2f survive one decode)", () => {
    const out = decodeAndNormalizePath(new URL("http://127.0.0.1/%252e%252e/x"));
    expect("reject" in out).toBe(true);
    if ("reject" in out) {
      expect(out.reject.status).toBe(404);
    }
  });
  test("rejects a malformed percent-encoding with a 400", () => {
    const out = decodeAndNormalizePath(new URL("http://127.0.0.1/%"));
    expect("reject" in out).toBe(true);
    if ("reject" in out) {
      expect(out.reject.status).toBe(400);
    }
  });
});
