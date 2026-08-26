/**
 * The reporting paths of `buildSite` — the branches that surface a sub-builder's diagnostics.
 *
 * Each emitter (well-known, headers, the client runtime, the runtime subpath scan) is unit-tested
 * where it lives, but whether `buildSite` PROPAGATES what it returns is a separate question and a
 * separate failure: a warning computed and dropped is indistinguishable from one never computed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSite } from "../src/site/site-build.ts";

/** Capture console.warn/error for one call, restoring both afterwards. */
async function captured<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const { error: realError, warn: realWarn } = console;
  console.warn = (message: string) => warnings.push(String(message));
  console.error = (message: string) => errors.push(String(message));
  try {
    return { errors, result: await run(), warnings };
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
}

/** A minimal buildable site rooted at `dir`, with one static page. */
function scaffold(dir: string, project: Record<string, unknown>): void {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(resolve(dir, "pages"), { recursive: true });
  writeFileSync(resolve(dir, "project.json"), JSON.stringify(project, null, 2), "utf8");
  writeFileSync(
    resolve(dir, "pages/index.json"),
    JSON.stringify({ $children: ["Home"], tagName: "main" }),
    "utf8",
  );
}

describe("buildSite — a route prefix i18n does not declare", () => {
  const DIR = resolve(import.meta.dir, "__test-site-locale-prefix__");

  beforeAll(() => {
    scaffold(DIR, { i18n: { defaultLocale: "en", locales: ["en", "fr-CA"] }, name: "Prefixed" });
    mkdirSync(resolve(DIR, "pages/fr"), { recursive: true });
    writeFileSync(
      resolve(DIR, "pages/fr/index.json"),
      JSON.stringify({ $children: ["Bonjour"], tagName: "main" }),
      "utf8",
    );
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  /*
   * `/fr/` looks localized and is not: nothing declares `fr`, so those pages are served as the
   * default locale. Silence here ships a site whose French section is tagged English.
   */
  it("names the tag that was declared, and the directory that was meant", async () => {
    const { warnings } = await captured(() => buildSite(DIR));

    const warning = warnings.find((w) => w.includes("Routes under /fr/"));
    expect(warning).toBeDefined();
    expect(warning).toContain('i18n.locales declares "fr-CA"');
  });
});

describe("buildSite — prefix-always with no runtime to answer the root", () => {
  const DIR = resolve(import.meta.dir, "__test-site-static-root__");

  beforeAll(() => {
    scaffold(DIR, {
      i18n: { defaultLocale: "en", locales: ["en", "fr"], routing: "prefix-always" },
      name: "Rootless",
    });
    // `prefix-always` means every page lives under a locale, so the site has no page at `/`.
    rmSync(resolve(DIR, "pages/index.json"), { force: true });
    mkdirSync(resolve(DIR, "pages/en"), { recursive: true });
    writeFileSync(
      resolve(DIR, "pages/en/index.json"),
      JSON.stringify({ $children: ["Hello"], tagName: "main" }),
      "utf8",
    );
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  /*
   * The one deployment shape where the root is genuinely broken and nothing said so: negotiation
   * answers `/` only inside a generated worker, and an adapter-less build has no runtime that sees
   * a request. `unprefixedRoutes` deliberately never reports `/` because under an adapter it is
   * handled — so without this the site's front door is a 404 the author finds out about in
   * production.
   */
  it("names the root, the locale it would send a visitor to, and why negotiation is absent", async () => {
    const { warnings } = await captured(() => buildSite(DIR));

    const warning = warnings.find((w) => w.includes('no page claims "/"'));
    expect(warning).toBeDefined();
    expect(warning).toContain("/en/");
    expect(warning).toContain("build.adapter");
  });

  it("says nothing once a page claims the root", async () => {
    writeFileSync(
      resolve(DIR, "pages/index.json"),
      JSON.stringify({ $children: ["Choose"], tagName: "main" }),
      "utf8",
    );
    const { warnings } = await captured(() => buildSite(DIR));
    rmSync(resolve(DIR, "pages/index.json"), { force: true });

    expect(warnings.some((w) => w.includes('no page claims "/"'))).toBe(false);
  });
});

describe("buildSite — two pages claiming one language", () => {
  const DIR = resolve(import.meta.dir, "__test-site-translation-conflict__");

  beforeAll(() => {
    scaffold(DIR, {
      i18n: { defaultLocale: "en", locales: ["en", "fr-CA"] },
      name: "Conflicted",
      url: "https://conflict.example",
    });
    writeFileSync(
      resolve(DIR, "pages/about.json"),
      JSON.stringify({ $children: ["About"], tagName: "main" }),
      "utf8",
    );
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  /*
   * A declared collision is a promise the author wrote down twice. A translation set names one URL
   * per language, so one of them is dropped either way — and silently advertising the other as
   * *the* French page is a wrong answer nobody downstream can detect.
   */
  it("fails the build when both said so with $translationKey", async () => {
    mkdirSync(resolve(DIR, "pages/fr-ca"), { recursive: true });
    for (const [file, key] of [
      ["a-propos", "about"],
      ["apropos", "about"],
    ] as const) {
      writeFileSync(
        resolve(DIR, `pages/fr-ca/${file}.json`),
        JSON.stringify({ $children: ["À propos"], $translationKey: key, tagName: "main" }),
        "utf8",
      );
    }
    const { errors, result } = await captured(() => buildSite(DIR));
    rmSync(resolve(DIR, "pages/fr-ca"), { force: true, recursive: true });

    const named = result.errors.find((e) => e.includes('both the "fr-CA" version'));
    expect(named).toBeDefined();
    expect(named).toContain("/fr-ca/apropos");
    expect(named).toContain("$translationKey");
    expect(errors.some((e) => e.includes('both the "fr-CA" version'))).toBe(true);
  });

  /*
   * A derived collision only warns: parallel paths that happen to meet may be a deliberate alias,
   * and failing a build over pages that work would be the compiler overruling a decision it cannot
   * see the reason for.
   */
  it("only warns when the paths collided on their own", async () => {
    mkdirSync(resolve(DIR, "pages/en"), { recursive: true });
    writeFileSync(
      resolve(DIR, "pages/en/about.json"),
      JSON.stringify({ $children: ["About"], tagName: "main" }),
      "utf8",
    );
    const { result, warnings } = await captured(() => buildSite(DIR));
    rmSync(resolve(DIR, "pages/en"), { force: true, recursive: true });

    expect(warnings.some((w) => w.includes('both the "en" version'))).toBe(true);
    expect(result.errors.some((e) => e.includes('both the "en" version'))).toBe(false);
  });

  /*
   * The key pre-pass reads every page that mentions `$translationKey` before anything compiles. A
   * page that cannot be parsed must not take the site down from there — it fails again a moment
   * later while compiling, where the error names the page and the rest of the site still builds.
   */
  it("leaves an unparseable page to the compile step that can name it", async () => {
    writeFileSync(
      resolve(DIR, "pages/broken.json"),
      '{ "$translationKey": "about", NOT json',
      "utf8",
    );
    const { result } = await captured(() => buildSite(DIR));
    rmSync(resolve(DIR, "pages/broken.json"), { force: true });

    expect(result.errors.some((e) => e.includes("broken.json"))).toBe(true);
    expect(result.files).toBeGreaterThan(0);
  });
});

describe("buildSite — well-known emitters", () => {
  const DIR = resolve(import.meta.dir, "__test-site-well-known-report__");

  beforeAll(() => {
    scaffold(DIR, {
      // An expired security.txt advertises a channel while saying the details are stale.
      manifest: { icons: [{ sizes: "48x48", src: "/i.png", type: "image/png" }], name: "WK" },
      name: "WK",
      securityTxt: { contact: ["mailto:security@example.com"], expires: "2001-01-01T00:00:00Z" },
    });
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  it("propagates an emitter's errors into the build result and onto stderr", async () => {
    const { errors, result } = await captured(() => buildSite(DIR));

    expect(result.errors.some((e) => e.includes("securityTxt") && e.includes("expires"))).toBe(
      true,
    );
    expect(errors.some((e) => e.includes("securityTxt"))).toBe(true);
  });

  it("propagates an emitter's warnings", async () => {
    const { warnings } = await captured(() => buildSite(DIR));

    expect(warnings.some((w) => w.includes("manifest"))).toBe(true);
  });
});

describe("buildSite — a well-known file public/ already ships", () => {
  const DIR = resolve(import.meta.dir, "__test-site-well-known-shadow__");

  beforeAll(() => {
    scaffold(DIR, {
      name: "Shadowed",
      securityTxt: {
        contact: ["mailto:security@example.com"],
        expires: "2099-01-01T00:00:00Z",
      },
    });
    // Signing needs a private key at build time, so a clearsigned file is shipped, not generated.
    mkdirSync(resolve(DIR, "public/.well-known"), { recursive: true });
    writeFileSync(
      resolve(DIR, "public/.well-known/security.txt"),
      "-----BEGIN PGP SIGNED MESSAGE-----\nContact: mailto:security@example.com\n",
      "utf8",
    );
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  it("keeps the authored copy rather than overwriting it", async () => {
    const dist = resolve(DIR, "dist");
    await buildSite(DIR);

    const shipped = Bun.file(resolve(dist, ".well-known/security.txt"));
    expect(await shipped.text()).toContain("BEGIN PGP SIGNED MESSAGE");
  });
});

describe("buildSite — _headers under an adapter that serves no static assets", () => {
  const DIR = resolve(import.meta.dir, "__test-site-headers-adapter__");

  beforeAll(() => {
    scaffold(DIR, {
      build: { adapter: "node" },
      headers: { hsts: { includeSubDomains: true, maxAge: 31_536_000 } },
      name: "Adapted",
    });
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  /*
   * `dist/_headers` is a Cloudflare/Netlify convention. A node or bun server never reads it, so
   * emitting it silently would let a site believe it had shipped a policy it has not.
   */
  it("says the file is documentation rather than configuration", async () => {
    const { warnings } = await captured(() => buildSite(DIR));

    expect(warnings.some((w) => w.includes("serves no static assets"))).toBe(true);
    expect(existsSync(resolve(DIR, "dist/_headers"))).toBe(true);
  });
});

describe("buildSite — _headers on a plain static host", () => {
  const DIR = resolve(import.meta.dir, "__test-site-headers-pages__");

  beforeAll(() => {
    scaffold(DIR, { name: "Paged" });
    // GitHub Pages' custom-domain marker, and nothing else's.
    mkdirSync(resolve(DIR, "public"), { recursive: true });
    writeFileSync(resolve(DIR, "public/CNAME"), "example.com\n", "utf8");
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  /*
   * The build wrote a caching policy and had no idea the host would discard it — an `immutable`
   * rule for content-addressed images that in practice served ten minutes.
   */
  it("says GitHub Pages will ignore it", async () => {
    const { warnings } = await captured(() => buildSite(DIR));

    expect(warnings.some((w) => w.includes("GitHub Pages ignores dist/_headers"))).toBe(true);
    expect(existsSync(resolve(DIR, "dist/_headers"))).toBe(true);
  });
});

describe("buildSite — _headers with no host marker", () => {
  const DIR = resolve(import.meta.dir, "__test-site-headers-plain__");

  beforeAll(() => scaffold(DIR, { name: "Plain" }));
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  // Most static builds go somewhere that does read the file; warning on all of them is noise.
  it("stays quiet when nothing says which host it is", async () => {
    const { warnings } = await captured(() => buildSite(DIR));

    expect(warnings.some((w) => w.includes("GitHub Pages"))).toBe(false);
    expect(warnings.some((w) => w.includes("serves no static assets"))).toBe(false);
  });
});

describe("buildSite — a component prerendered into a declarative shadow root", () => {
  const DIR = resolve(import.meta.dir, "__test-site-shadow-prerender__");

  beforeAll(() => {
    scaffold(DIR, { defaults: { shadow: "open" }, name: "Shadowed" });
    mkdirSync(resolve(DIR, "components"), { recursive: true });
    writeFileSync(
      resolve(DIR, "components/site-card.json"),
      JSON.stringify({
        $style: { ".card": { color: "red" } },
        children: [{ children: ["Card"], class: "card", tagName: "div" }],
        tagName: "site-card",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(DIR, "pages/index.json"),
      JSON.stringify({ children: [{ tagName: "site-card" }], tagName: "main" }),
      "utf8",
    );
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  /*
   * Markup the parser materializes before any script runs, which the element adopts rather than
   * replaces (spec.md §16.6). The stylesheet moves INSIDE the template because a shadow root does
   * not inherit the document's sheets — and it stays an external `<link>`, so no CSP hash changes.
   */
  it("emits the template the parser adopts, with the stylesheet inside it", async () => {
    await buildSite(DIR);

    const html = await Bun.file(resolve(DIR, "dist/index.html")).text();
    expect(html).toContain('<template shadowrootmode="open">');
    const template = html.slice(html.indexOf("<template"), html.indexOf("</template>"));
    expect(template).toContain('<link rel="stylesheet" href="/components/site-card.css">');
  });
});

describe("buildSite — a runtime subpath the package does not have", () => {
  const DIR = resolve(import.meta.dir, "__test-site-bad-subpath__");

  beforeAll(() => {
    scaffold(DIR, { name: "BadSubpath" });
    mkdirSync(resolve(DIR, "components"), { recursive: true });
    /*
     * A client sidecar importing a directive that does not exist. `lit-html` stays external in its
     * bundle, so the bad specifier survives into the output and the subpath scan is what meets it.
     */
    writeFileSync(
      resolve(DIR, "components/helpers.js"),
      'export { classMap } from "lit-html/directives/no-such-directive.js";\nexport default classMap;\n',
      "utf8",
    );
    writeFileSync(
      resolve(DIR, "components/site-widget.json"),
      JSON.stringify({
        children: [{ children: ["${state.n}"], tagName: "span" }],
        state: {
          n: 0,
          styles: { $prototype: "Function", $src: "./helpers.js", parameters: ["state"] },
        },
        tagName: "site-widget",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(DIR, "pages/index.json"),
      JSON.stringify({ children: [{ tagName: "site-widget" }], tagName: "main" }),
      "utf8",
    );
  });
  afterAll(() => rmSync(DIR, { force: true, recursive: true }));

  // The scan runs after every page is written, so its failure is reported, never thrown.
  it("names the specifier in the build result rather than failing the build", async () => {
    const { errors, result } = await captured(() => buildSite(DIR));

    const reported = result.errors.find((e) => e.includes("no-such-directive.js"));
    expect(reported).toBeDefined();
    expect(reported).toContain("Bundling runtime subpath");
    expect(errors.some((e) => e.includes("no-such-directive.js"))).toBe(true);
  });
});
