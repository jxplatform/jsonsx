/**
 * Six pages were shipping broken links when this gate was written, every one of them a relative
 * `./i18n.md` that renders correctly in a Markdown preview and 404s once published. The RULE tests
 * drive synthetic links through the resolver; the GOLDEN tests hold the committed tree to zero.
 *
 * The false-positive half is the one that matters. An external URL, a code span showing a link, a
 * mailto, and a fragment-only link to the page's own heading must all pass, because a gate that
 * cries wolf on those gets muted and then the relative links come back.
 */

import { describe, expect, test } from "bun:test";
import { checkLinks, inboundAnchors, linksOf, navSlugs, readCorpus } from "./check-doc-links.ts";
import { headingsOf, renderedHeadingText } from "./lib/headings.ts";

const PUBLISHED = new Set(["framework/site/i18n", "studio/interface"]);
const ANCHORS: Record<string, Set<string>> = {
  "framework/site/i18n": new Set(["content-in-one-directory-per-locale"]),
  "studio/interface": new Set(["the-jump-bar"]),
  here: new Set(["a-real-heading"]),
};
const anchorsFor = (slug: string) => ANCHORS[slug];
// Mirrors the real reader: the site root is a page, and these two exist under pages/.
const siteRouteExists = (route: string) =>
  route.replaceAll(/^\/+|\/+$/g, "") === "" || ["download", "templates"].includes(route);

function check(markdown: string, file = "docs/here.md") {
  return checkLinks(linksOf(markdown, file), PUBLISHED, anchorsFor, siteRouteExists);
}

describe("checkLinks flags", () => {
  test("a relative .md link, the form that publishes broken", () => {
    const [v] = check("See [locales](./i18n.md).");
    expect(v?.id).toBe("link-relative-md");
  });

  test("a deeper relative link", () => {
    expect(check("[x](../../framework/site/i18n.md)")[0]?.id).toBe("link-relative-md");
  });

  test("a root-absolute link that keeps its .md extension", () => {
    expect(check("[x](/docs/framework/site/i18n.md)")[0]?.id).toBe("link-md-extension");
  });

  test("a trailing slash", () => {
    expect(check("[x](/docs/framework/site/i18n/)")[0]?.id).toBe("link-trailing-slash");
  });

  test("a slug that is in no nav entry", () => {
    expect(check("[x](/docs/studio/does-not-exist)")[0]?.id).toBe("link-unknown-page");
  });

  test("an anchor the target page does not publish", () => {
    expect(check("[x](/docs/studio/interface#no-such-heading)")[0]?.id).toBe("link-unknown-anchor");
  });

  test("a same-page anchor that no heading publishes", () => {
    expect(check("[x](#not-here)")[0]?.id).toBe("link-unknown-anchor");
  });

  test("a site route with no page behind it", () => {
    expect(check("[x](/pricing)")[0]?.id).toBe("link-unknown-route");
  });
});

describe("checkLinks leaves alone", () => {
  // Every one of these is a link a gate must not touch. A false positive here gets the gate muted.
  const clean: [string, string][] = [
    ["a resolving page link", "[x](/docs/framework/site/i18n)"],
    [
      "a resolving anchor link",
      "[x](/docs/framework/site/i18n#content-in-one-directory-per-locale)",
    ],
    ["a same-page anchor that resolves", "[x](#a-real-heading)"],
    ["an external URL", "[x](https://example.com/a.md)"],
    ["a protocol-relative URL", "[x](//example.com/a)"],
    ["a mailto", "[x](mailto:hi@example.com)"],
    ["a site route that exists", "[x](/templates)"],
    ["the site root", "[x](/)"],
    ["an image, which is not a link", "![alt](../images/x.png)"],
    ["a link inside a code span", "Write `[x](./i18n.md)` in your page."],
    ["a link inside a fence", "```md\n[x](./i18n.md)\n```"],
    ["a link with a title attribute", '[x](/docs/studio/interface "The workspace")'],
  ];
  for (const [name, markdown] of clean) {
    test(name, () => {
      expect(check(markdown)).toEqual([]);
    });
  }
});

describe("heading anchors", () => {
  test("a slug comes from the heading's rendered text, not its markup", () => {
    expect(renderedHeadingText("The `project.json` file and :kbd[Ctrl+K]")).toBe(
      "The project.json file and Ctrl+K",
    );
    expect(headingsOf("## Code mode: the whole file as `source`")[0]?.slug).toBe(
      "code-mode-the-whole-file-as-source",
    );
  });

  test("re-casing a heading keeps its anchor, which is why case fixes are safe", () => {
    expect(headingsOf("## How It Works")[0]?.slug).toBe(headingsOf("## How it works")[0]?.slug);
  });

  test("a repeated heading takes the -2 suffix the site assigns", () => {
    expect(headingsOf("## Data\n## Data\n## Data").map((h) => h.slug)).toEqual([
      "data",
      "data-2",
      "data-3",
    ]);
  });

  test("a heading inside a fence is not a heading", () => {
    expect(headingsOf("```md\n## Not a heading\n```\n## Real")).toHaveLength(1);
  });

  test("frontmatter is not headings, and a later --- does not reopen it", () => {
    expect(
      headingsOf('---\ntitle: "T"\n---\n\n## One\n\n---\n\n## Two').map((h) => h.slug),
    ).toEqual(["one", "two"]);
  });

  test("a heading that slugifies to nothing falls back to `section`", () => {
    expect(headingsOf("## ///")[0]?.slug).toBe("section");
  });
});

describe("the committed tree", () => {
  const corpus = readCorpus();

  test("every internal link resolves", () => {
    expect(
      checkLinks(corpus.links, corpus.published, corpus.anchorsFor, corpus.siteRouteExists),
    ).toEqual([]);
  });

  test("nav is the published slug set, and it is not empty", () => {
    expect(corpus.published.size).toBeGreaterThan(100);
  });

  test("the anchors a rewrite must preserve are reported, and all of them resolve", () => {
    const inbound = inboundAnchors(corpus.links);
    expect(inbound.size).toBeGreaterThan(15);
    for (const key of inbound.keys()) {
      const [slug = "", anchor = ""] = key.split("#");
      expect(corpus.anchorsFor(slug)?.has(anchor)).toBe(true);
    }
  });

  test("navSlugs reads a section own rows and its groups, in sidebar order", () => {
    /* The walk is `nav.ts`'s, not a copy, and this asserts the delegation still holds. A private
       copy understood a `children` array; the accordion sidebar replaced that with `pages` plus
       `groups`, and the copy then called every page in the corpus unknown while `docs:check`
       stayed green. */
    expect(
      navSlugs(
        JSON.stringify({
          id: "docs",
          sections: [
            {
              path: "a",
              label: "A",
              pages: [
                { path: "a", label: "Overview" },
                { path: "a/b", label: "B" },
              ],
              groups: [{ label: "G", pages: [{ path: "a/g/c", label: "C" }] }],
            },
          ],
        }),
      ),
    ).toEqual(["a", "a/b", "a/g/c"]);
  });
});
