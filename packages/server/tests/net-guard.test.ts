import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  containedPath,
  decodeAndNormalizePath,
  fetchMetadataAllows,
  hostIsLoopbackOrAbsent,
  isLoopbackHost,
  loopbackGate,
  originHostGate,
  normalizeForCompare,
  originIsLoopbackOrAbsent,
  presentedToken,
  secretsMatch,
  resetRootLaneWarnings,
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
  test("serves from public/", async () => {
    const res = await serveProjectFile("/style.css", PROJECT);
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain("body{}");
  });

  /**
   * The lane order, and the one place a preview used to lie.
   *
   * A BUILD resolves `/x` to `public/x` and nowhere else (`site-architecture.md` §9.3, and
   * `resolveImagePath` in the compiler). This server tried the project ROOT first, so a file at
   * `<root>/hero.jpg` loaded at `/hero.jpg` here and 404'd on the deployed site — and when both
   * copies existed, the preview showed the one production would never serve.
   */
  describe("the lane order matches a build", () => {
    const both = join(PROJECT, "collide.png");
    const pub = join(PROJECT, "public", "collide.png");

    beforeEach(() => {
      resetRootLaneWarnings();
      writeFileSync(both, "root-copy");
      writeFileSync(pub, "public-copy");
    });

    test("public/ wins when a file exists in both — that is what production serves", async () => {
      const res = await serveProjectFile("/collide.png", PROJECT);
      expect(await res!.text()).toBe("public-copy");
    });

    test("the project root still answers, and says the preview is lying", async () => {
      rmSync(pub);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await serveProjectFile("/collide.png", PROJECT);
        expect(await res!.text()).toBe("root-copy");
        expect(warn.mock.calls[0]?.[0]).toContain("move it into public/");
      } finally {
        warn.mockRestore();
      }
    });

    test("it says so ONCE, not once per request", async () => {
      rmSync(pub);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await serveProjectFile("/collide.png", PROJECT);
        await serveProjectFile("/collide.png", PROJECT);
        await serveProjectFile("/collide.png", PROJECT);
        expect(warn.mock.calls).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    /* The root lane serves TWO URL spaces: the site's, and the project tree's — which is how the
       Studio canvas fetches a component `$ref`. Only the first is what a build defines, so a
       document answered from the project root is the protocol working, not a preview lying. */
    test("a project document answered from the root says nothing", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await serveProjectFile("/index.html", PROJECT);
        expect(warn.mock.calls).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });
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

// ─── Unicode normalization in containment ─────────────────────────────────

describe("containment across normalization forms", () => {
  /*
   * The defect: containment is a STRING comparison, and macOS `readdir` returns a decomposed
   * filename while a path from a picker, a config file or a URL arrives precomposed. Two different
   * strings for one file, so every path holding an accent silently failed containment — the file
   * existed, the check said it was outside the root, and the request 404'd with nothing to search
   * for.
   */
  test("a decomposed and a precomposed path are the same path", () => {
    const nfd = "caf\u0065\u0301";
    const nfc = "caf\u00E9";
    expect(nfd).not.toBe(nfc);
    expect(normalizeForCompare(nfd)).toBe(normalizeForCompare(nfc));
  });

  test("an accented directory is contained however it was spelled", () => {
    const accented = join(PROJECT, "caf\u00E9");
    mkdirSync(accented, { recursive: true });
    writeFileSync(join(accented, "a.txt"), "x");
    // The same path written decomposed, as a macOS directory listing would produce it.
    const decomposed = join(PROJECT, "caf\u0065\u0301", "a.txt");
    expect(containedPath(decomposed, PROJECT)).not.toBeNull();
  });
});

// ─── Fetch Metadata (W3C Fetch Metadata Request Headers) ──────────────────

describe("fetchMetadataAllows", () => {
  const req = (headers: Record<string, string>, method = "GET") =>
    new Request("http://127.0.0.1/x", { headers, method });

  /*
   * THE load-bearing case, and the reason this test is named after the property rather than the
   * behaviour: the header is browser-supplied. curl omits it, Bun-native clients omit it, the
   * desktop RPC bridge omits it, and this very suite builds well over a hundred bare Requests.
   * Requiring it would refuse every non-browser client on the machine while stopping no attacker,
   * because the threat model is a PAGE — and a page always sends it. Deleting this test is the
   * loudest signal available that the requirement was misread.
   */
  test("fetchMetadataAbsentIsAccepted", () => {
    expect(fetchMetadataAllows(req({}))).toBe(true);
    expect(fetchMetadataAllows(req({}), "embeddable")).toBe(true);
    expect(originHostGate(req({}))).toBeNull();
  });

  test("the served page and a typed URL are allowed", () => {
    expect(fetchMetadataAllows(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(fetchMetadataAllows(req({ "sec-fetch-site": "none" }))).toBe(true);
  });

  // A person following a link, and nothing else.
  test("a cross-site request is allowed only as a top-level document navigation", () => {
    expect(
      fetchMetadataAllows(
        req({
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toBe(true);
    // A cross-site subresource is not a navigation.
    expect(
      fetchMetadataAllows(
        req({
          "sec-fetch-dest": "image",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toBe(false);
    // Nor is a cross-site form POST — this is the CSRF the gate exists for.
    expect(
      fetchMetadataAllows(
        req(
          {
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "cross-site",
          },
          "POST",
        ),
      ),
    ).toBe(false);
  });

  /*
   * Stricter than the standard's Resource Isolation Policy, deliberately: on 127.0.0.1 there is no
   * "site" wider than the origin, so `same-site` means a different PORT on this machine — precisely
   * the other-local-process threat a loopback bind cannot address.
   */
  test("same-site is denied under the strict policy", () => {
    expect(fetchMetadataAllows(req({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(originHostGate(req({ "sec-fetch-site": "same-site" }))?.status).toBe(403);
  });

  /*
   * The desktop canvas renders the project in a cross-origin iframe, so its images, stylesheets and
   * modules legitimately arrive cross-site. Refusing them would break the canvas; allowing them on
   * a route that can write a file would hand away the containment — hence a per-surface policy.
   */
  test("the embeddable policy admits a cross-origin iframe's subresources", () => {
    for (const site of ["cross-site", "same-site"]) {
      const subresource = req({ "sec-fetch-dest": "image", "sec-fetch-site": site });
      expect({ site, strict: fetchMetadataAllows(subresource) }).toEqual({ site, strict: false });
      expect({ site, embeddable: fetchMetadataAllows(subresource, "embeddable") }).toEqual({
        site,
        embeddable: true,
      });
    }
  });

  test("an unrecognized value is refused under the strict policy", () => {
    expect(fetchMetadataAllows(req({ "sec-fetch-site": "nonsense" }))).toBe(false);
  });
});

// ─── Loopback address handling ────────────────────────────────────────────

describe("the loopback block", () => {
  /*
   * IANA reserves 127.0.0.0/8, and every address in it is this machine. Recognizing only the
   * canonical spelling would reject a client using any other while granting nothing — someone who
   * can send from 127.0.0.53 is already on the host.
   */
  test("the whole 127.0.0.0/8 block is loopback, not just 127.0.0.1", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "127.0.0.53", "127.1.2.3", "127.0.0.1:3000"]) {
      expect({ host, loopback: isLoopbackHost(host) }).toEqual({ host, loopback: true });
    }
    for (const host of ["128.0.0.1", "10.0.0.1", "evil.test", "1270.0.0.1"]) {
      expect({ host, loopback: isLoopbackHost(host) }).toEqual({ host, loopback: false });
    }
  });

  /*
   * As a Host it is ordinary — a server bound to 0.0.0.0 in a container is reached at that literal.
   * As an Origin it is meaningless: no page is ever served from http://0.0.0.0, so a request
   * claiming it is confused or probing.
   */
  test("0.0.0.0 is accepted as a Host and never as an Origin", () => {
    expect(
      hostIsLoopbackOrAbsent(new Request("http://x/", { headers: { host: "0.0.0.0:3000" } })),
    ).toBe(true);
    expect(
      originIsLoopbackOrAbsent(new Request("http://x/", { headers: { origin: "http://0.0.0.0" } })),
    ).toBe(false);
  });
});

// ─── Token comparison and presentation ────────────────────────────────────

describe("secretsMatch", () => {
  test("compares by value", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
    expect(secretsMatch("abc", "abcd")).toBe(false);
    expect(secretsMatch("", "")).toBe(true);
  });

  /*
   * The property, not the timing: no early return on the first differing character. A test cannot
   * measure constant time reliably, but it CAN pin that every position is visited — two strings
   * differing only in the last character must take the same path as two differing in the first.
   */
  test("does not stop at the first difference", () => {
    const visited: number[] = [];
    const probe = {
      codePointAt: (i: number) => {
        visited.push(i);
        return 97;
      },
      length: 4,
    };
    secretsMatch("aaaa", probe as unknown as string);
    expect(visited).toEqual([0, 1, 2, 3]);
  });
});

describe("presentedToken", () => {
  const url = new URL("http://127.0.0.1/x?token=from-query");

  test("prefers Authorization: Bearer, and falls back to the query", () => {
    const withHeader = new Request(url, { headers: { authorization: "Bearer from-header" } });
    expect(presentedToken(withHeader, url)).toBe("from-header");
    expect(presentedToken(new Request(url), url)).toBe("from-query");
  });

  // The iframe's `src` is the only place it can carry one, which is why the query form stays.
  test("an empty or non-bearer Authorization falls through to the query", () => {
    for (const authorization of ["Bearer ", "Basic abc", ""]) {
      const req = new Request(url, { headers: { authorization } });
      expect({ authorization, token: presentedToken(req, url) }).toEqual({
        authorization,
        token: "from-query",
      });
    }
  });

  test("no token anywhere is null", () => {
    const bare = new URL("http://127.0.0.1/x");
    expect(presentedToken(new Request(bare), bare)).toBeNull();
  });
});

describe("loopbackGate token handling", () => {
  const url = new URL("http://127.0.0.1/x?token=secret");

  test("accepts the token from either place", () => {
    expect(loopbackGate(new Request(url), url, "secret")).toBeNull();
    const header = new Request(new URL("http://127.0.0.1/x"), {
      headers: { authorization: "Bearer secret" },
    });
    expect(loopbackGate(header, new URL("http://127.0.0.1/x"), "secret")).toBeNull();
  });

  test("refuses a wrong or missing token", () => {
    expect(loopbackGate(new Request(url), url, "other")?.status).toBe(403);
    const bare = new URL("http://127.0.0.1/x");
    expect(loopbackGate(new Request(bare), bare, "secret")?.status).toBe(403);
  });
});
