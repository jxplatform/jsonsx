/**
 * Locale negotiation as shipped bytes: a real build, a real bundle, real requests.
 *
 * `locale-negotiation.test.ts` proves the algorithm and pins the generated source against it. This
 * proves the other half — that the source survives bundling, registers ahead of the ASSETS
 * fallthrough, and answers a `Request` the way it is supposed to. Every failure mode here is one
 * the generator's own output looks perfectly fine under: middleware registered after a terminal
 * route, a `Vary` header set on a response that was then replaced, a redirect that loops.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/site/site-build.ts";

interface WorkerModule {
  default: { fetch: (req: Request, env: unknown) => Promise<Response> };
}

/** Stands in for Cloudflare's ASSETS binding; its body proves the chain continued past us. */
const ENV = {
  ASSETS: {
    fetch: (req: Request) =>
      Promise.resolve(new Response(`served ${new URL(req.url).pathname}`, { status: 200 })),
  },
};

let root = "";
let worker: WorkerModule["default"] | null = null;

function writeJson(path: string, value: unknown) {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, JSON.stringify(value), "utf8");
}

async function get(path: string, acceptLanguage?: string): Promise<Response> {
  const headers = acceptLanguage === undefined ? {} : { "Accept-Language": acceptLanguage };
  return worker!.fetch(new Request(`https://i18n.example${path}`, { headers }), ENV);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jx-locale-worker-"));
  writeJson("project.json", {
    build: { adapter: "cloudflare-workers", outDir: "./dist" },
    i18n: { defaultLocale: "en", locales: ["en", "fr", "de"], routing: "prefix-except-default" },
    name: "I18n Worker",
    url: "https://i18n.example",
  });
  writeJson("pages/index.json", { children: ["Home"], tagName: "h1", title: "Home" });
  writeJson("pages/fr/index.json", { children: ["Accueil"], tagName: "h1", title: "Accueil" });
  writeJson("pages/de/index.json", { children: ["Start"], tagName: "h1", title: "Start" });

  // `hono` is a bare specifier the worker bundle resolves from the PROJECT root, so the temp
  // Project needs it on disk exactly as a real one would.
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const hono = join(import.meta.dir, "../../../node_modules/hono");
  if (existsSync(hono)) {
    await Bun.$`ln -sfn ${hono} ${join(root, "node_modules/hono")}`.quiet();
  }

  await buildSite(root, { verbose: false });
  const bundled = join(root, "dist/worker.js");
  if (existsSync(bundled)) {
    worker = ((await import(bundled)) as WorkerModule).default;
  }
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("the bundled worker negotiates a locale", () => {
  it("bundles at all, with the negotiation in it", () => {
    expect(worker).not.toBeNull();
    const source = readFileSync(join(root, "dist/worker.js"), "utf8");
    expect(source).toContain("Accept-Language");
  });

  it("sends a French reader to the French home", async () => {
    const res = await get("/", "fr");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/fr/");
  });

  // RFC 4647 Lookup: `fr-CA` is not offered, so the range truncates to `fr`, which is.
  it("truncates a range the site does not offer", async () => {
    const res = await get("/", "fr-CA,fr;q=0.9");
    expect(res.headers.get("location")).toBe("/fr/");
  });

  it("obeys quality order rather than header order", async () => {
    const res = await get("/", "en;q=0.1, de;q=0.9");
    expect(res.headers.get("location")).toBe("/de/");
  });

  // `q=0` is a refusal. Honouring it is the difference between a preference and a veto.
  it("honours an explicit refusal", async () => {
    const res = await get("/", "de;q=0, fr");
    expect(res.headers.get("location")).toBe("/fr/");
  });

  /*
   * The default locale owns `/` under prefix-except-default, so redirecting there would loop
   * forever. The request must continue down the chain instead — which is why this is middleware.
   */
  it("serves / directly when the default locale wins, rather than redirecting to itself", async () => {
    for (const header of [undefined, "ja, ko", "*", "en"]) {
      const res = await get("/", header);
      expect({ header, status: res.status }).toEqual({ header, status: 200 });
      expect(await res.text()).toBe("served /");
    }
  });

  /*
   * Without this a cache stores one visitor's answer and serves it to every later reader — the
   * failure the author's own browser can never reproduce, because it was the first visitor.
   */
  it("marks every / response as depending on the header", async () => {
    for (const header of [undefined, "fr", "de", "ja"]) {
      const res = await get("/", header);
      expect({ header, vary: res.headers.get("vary") }).toEqual({
        header,
        vary: "Accept-Language",
      });
    }
  });

  it("names the language it chose", async () => {
    const german = await get("/", "de");
    expect(german.headers.get("content-language")).toBe("de");
    const unmatched = await get("/", "ja");
    expect(unmatched.headers.get("content-language")).toBe("en");
  });

  /*
   * A visitor who asked for `/de/about/` has expressed a preference far stronger than a header.
   * Negotiating there would make a shared link mean different things to different people.
   */
  it("leaves every other path completely alone", async () => {
    for (const path of ["/about/", "/fr/", "/de/impressum/"]) {
      const res = await get(path, "fr");
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect(await res.text()).toBe(`served ${path}`);
      expect(res.headers.get("vary")).toBeNull();
    }
  });
});
