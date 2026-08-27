/**
 * The HTML a composed page is served as.
 *
 * A built page is prerendered; a live one cannot be, because prerendering is the compiler's job and
 * the compiler is not on this path. So the shell carries what the SERVER can settle — the merged
 * `<head>`, the page's language and writing direction — and hands the composed document to
 * `@jxsuite/runtime`, which builds the DOM in the reader's browser exactly as the studio's canvas
 * does.
 *
 * Two details are load-bearing:
 *
 * **`base`.** Handed a document object rather than a URL, the runtime has no base to resolve
 * `$ref`, `$elements` and asset paths against and falls back to `location.href` — which is right
 * only at the site root. At `/blog/hello/` every relative reference would resolve two directories
 * too deep. A host serving the project tree AT its origin root passes `"/"`, and saying so is what
 * makes an authored `./components/card.json` find its file.
 *
 * **The document travels in a `<script type="application/json">`, not in a JS literal.** The only
 * sequence that can end such a block is `</script`, so escaping `<` in the payload closes the one
 * hole; a JS string literal would have to be right about backslashes, line separators and
 * `</script` all at once.
 *
 * Everything else is a parameter rather than a constant, because the two hosts that serve this
 * disagree about all of it: where the runtime bundle lives, whether there is a site stylesheet,
 * whether a reload client is injected, and whether the runtime may reach a resolver.
 */

import { renderHead } from "./head-merger.ts";
import type { ComposedPage } from "./compose.ts";

/** What a host must tell the shell about its own origin. */
export interface ShellOptions {
  /** URL of the `@jxsuite/runtime` browser bundle on this origin. */
  runtimeUrl: string;
  /** What relative references resolve against — `"/"` for a tree served at the origin root. */
  base: string;
  /** Stylesheet carrying `project.json`'s `style`, when the host emits one. */
  styleUrl?: string | undefined;
  /** A module the host appends after the render — a live-reload client, typically. */
  clientScriptUrl?: string | undefined;
  /**
   * Token for the runtime's `/__jx_resolve__` and `/__jx_server__` proxies.
   *
   * Present only where the host can actually answer them. Without it the runtime still renders;
   * what it cannot do is resolve `$src` classes, content collections or `timing: "server"`, so a
   * host that omits this should expect a collection to render as an empty list.
   */
  resolveToken?: string | undefined;
}

/** Escape a string for an HTML attribute value. */
function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Serialize a document for a `<script type="application/json">` block.
 *
 * `<` is escaped as `\u003c`, which JSON.parse restores and an HTML parser cannot mistake for the
 * start of a tag — so no value inside the document, however it was authored, can close the block.
 */
function jsonPayload(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", String.raw`\u003c`);
}

/** The document for one composed page. */
export function pageShell(page: ComposedPage, options: ShellOptions): string {
  const imports = options.resolveToken ? "Jx, setResolveToken" : "Jx";
  const setToken = options.resolveToken
    ? `\nsetResolveToken(${JSON.stringify(options.resolveToken)});`
    : "";
  const style = options.styleUrl
    ? `\n  <link rel="stylesheet" href="${attr(options.styleUrl)}">`
    : "";
  /* Scroll restoration is turned off before first paint, and it has to be an inline classic script
     to land there: a module script is deferred, so the browser would have restored against an empty
     body — a client-rendered page has no height yet — and left the reader at the top. Whoever
     restores the position does it after the render instead. */
  const client = options.clientScriptUrl
    ? `\n<script type="module" src="${attr(options.clientScriptUrl)}"></script>`
    : "";
  return `<!doctype html>
<html lang="${attr(page.lang)}" dir="${attr(page.dir)}">
<head>
  ${renderHead(page.head)}${style}
  <script>history.scrollRestoration = "manual";</script>
</head>
<body>
<script type="application/json" id="jx-page-document">${jsonPayload(page.doc)}</script>
<script type="module">
import { ${imports} } from "${attr(options.runtimeUrl)}";${setToken}
const source = document.getElementById("jx-page-document").textContent;
await Jx(JSON.parse(source), document.body, { base: ${JSON.stringify(options.base)} });
</script>${client}
</body>
</html>
`;
}

/**
 * A page that names what stopped a route from rendering.
 *
 * A preview that 500s tells the author nothing they can act on. A page naming the file and the
 * reason — a layout that is not there, a format whose parser does not run here — is the difference
 * between "the preview is broken" and "this page needs a `.json` layout".
 */
export function problemShell(message: string): string {
  const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>This page could not be rendered</title>
</head>
<body>
  <h1>This page could not be rendered</h1>
  <p>${escaped}</p>
</body>
</html>
`;
}
