/**
 * The document a composed page is served as.
 *
 * Two properties here are load-bearing rather than cosmetic: no value inside the document can close
 * the JSON block, and `base` is always stated. Without the second, a page at `/blog/hello/`
 * resolves every relative `$ref` two directories too deep.
 */
import { describe, expect, test } from "bun:test";
import { pageShell, problemShell } from "../src/shell.ts";
import type { ComposedPage } from "../src/compose.ts";
import type { ShellOptions } from "../src/shell.ts";

const BASIC: ShellOptions = { base: "/", runtimeUrl: "/__jx_live__/runtime.js" };

const DEFAULT_DOC = { children: ["Hi"], tagName: "main" };

function page(doc: unknown = DEFAULT_DOC): ComposedPage {
  return { dir: "ltr", doc: doc as ComposedPage["doc"], head: [], lang: "en" };
}

/** The payload as the browser would see it, between the JSON block's own tags. */
function payloadOf(html: string): string {
  return html.split('id="jx-page-document">')[1]!.split("</script>")[0]!;
}

describe("pageShell", () => {
  test("declares the document's language and direction", () => {
    const html = pageShell({ ...page(), dir: "rtl", lang: "ar" }, BASIC);
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });

  test("an attribute value carrying a quote cannot break out of its attribute", () => {
    const html = pageShell({ ...page(), lang: '"><script>x' } as ComposedPage, BASIC);
    expect(html).not.toContain('lang=""><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;x");
  });

  test("NO value inside the document can close the JSON block", () => {
    const html = pageShell(page({ children: ["</script><img onerror=alert(1)>"] }), BASIC);
    const payload = payloadOf(html);
    expect(payload).not.toContain("<");
    expect(JSON.parse(payload).children[0]).toBe("</script><img onerror=alert(1)>");
  });

  test("the base is always stated, because the runtime cannot infer one from an object", () => {
    expect(pageShell(page(), BASIC)).toContain('{ base: "/" }');
  });

  test("a host serving under a prefix says so", () => {
    expect(pageShell(page(), { ...BASIC, base: "/preview/" })).toContain('{ base: "/preview/" }');
  });

  test("the runtime is imported from the URL the host named", () => {
    expect(pageShell(page(), { ...BASIC, runtimeUrl: "/_jx/runtime.js" })).toContain(
      'from "/_jx/runtime.js"',
    );
  });

  test("scroll restoration is turned off before first paint", () => {
    // Inline classic script, not a module: a deferred module would let the browser restore
    // Against a body a client-rendered page has not filled, leaving the reader at the top.
    const html = pageShell(page(), BASIC);
    const head = html.split("</head>")[0]!;
    expect(head).toContain('history.scrollRestoration = "manual"');
  });

  test("no stylesheet, no client and no token unless the host asks for them", () => {
    const html = pageShell(page(), BASIC);
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain("setResolveToken");
    expect(html).not.toContain('<script type="module" src=');
  });

  test("a site stylesheet is linked when the host emits one", () => {
    expect(pageShell(page(), { ...BASIC, styleUrl: "/__jx_live__/site.css" })).toContain(
      '<link rel="stylesheet" href="/__jx_live__/site.css">',
    );
  });

  test("a client module is appended after the render, not before it", () => {
    const html = pageShell(page(), { ...BASIC, clientScriptUrl: "/__jx_live__/client.js" });
    expect(html.indexOf("await Jx(")).toBeLessThan(html.indexOf("client.js"));
  });

  test("a resolve token is imported and set before the render", () => {
    const html = pageShell(page(), { ...BASIC, resolveToken: "tok-123" });
    expect(html).toContain("import { Jx, setResolveToken }");
    expect(html).toContain('setResolveToken("tok-123");');
    expect(html.indexOf("setResolveToken(")).toBeLessThan(html.indexOf("await Jx("));
  });

  test("a token carrying a quote cannot break out of the module script", () => {
    const html = pageShell(page(), { ...BASIC, resolveToken: '");alert(1);//' });
    expect(html).toContain(String.raw`setResolveToken("\");alert(1);//");`);
  });

  test("the merged head is rendered server-side", () => {
    const html = pageShell(
      {
        ...page(),
        head: [{ attributes: { content: "hi", name: "description" }, tagName: "meta" }],
      },
      BASIC,
    );
    expect(html.split("</head>")[0]).toContain('name="description"');
  });
});

describe("problemShell", () => {
  test("names the reason the page could not render", () => {
    expect(problemShell("Layout not found: ./layouts/base.json")).toContain(
      "Layout not found: ./layouts/base.json",
    );
  });

  test("a message carrying markup is escaped rather than rendered", () => {
    const html = problemShell("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
