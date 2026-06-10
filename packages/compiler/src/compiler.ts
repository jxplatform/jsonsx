/**
 * jx-compiler.js — Compiler orchestrator
 * @version 3.0.0
 * @license MIT
 *
 * Routes Jx documents to the appropriate compilation target:
 *   - Fully static         → compile-static.js  (plain HTML/CSS, zero JS)
 *   - Custom element (-)   → compile-element.js  (lit-html web component)
 *   - Dynamic (standard)   → compile-client.js   (pre-rendered HTML + reactive bindings)
 *   - Server               → compile-server.js   (Hono server handler)
 *
 * Usage (CLI):
 *   bun packages/compiler/src/compile-cli.js <source.json> [output.html]
 */

import { readFileSync } from "node:fs";
import {
  isDynamic,
  compileStyles,
  escapeHtml,
  tagNameToClassName,
  DEFAULT_REACTIVITY_SRC,
  DEFAULT_LIT_HTML_SRC,
} from "./shared.ts";
import { compileServer, compileSiteServer } from "./targets/compile-server.ts";

import {
  compileElement,
  compileElementPage,
  emitElementModule,
} from "./targets/compile-element.ts";
import { compileStaticPage } from "./targets/compile-static.ts";
import { compileClient } from "./targets/compile-client.ts";
import type { JxMutableNode } from "@jxsuite/schema/types";

// Re-exports for consumers
export {
  isDynamic,
  compileServer,
  compileSiteServer,
  compileElement,
  compileElementPage,
  compileClient,
};

// ─── Entry ────────────────────────────────────────────────────────────────────

/**
 * Compile a Jx document to HTML (+ optional JS module files).
 *
 * Routing: 1. Not dynamic → static HTML/CSS, zero JS 2. tagName contains hyphen → custom element
 * (lit-html) 3. Otherwise → pre-rendered HTML with reactive bindings
 *
 * @param {string | any} sourcePath - Path to .json file, URL, or raw object
 * @param {Record<string, unknown>} [opts]
 * @returns {Promise<{
 *   html: string;
 *   files: { path: string; content: string; tagName?: string }[];
 * }>}
 */
export async function compile(sourcePath: string | any, opts: Record<string, unknown> = {}) {
  const {
    title = "Jx App",
    reactivitySrc = DEFAULT_REACTIVITY_SRC,
    litHtmlSrc = DEFAULT_LIT_HTML_SRC,
    projectStyle = null,
  } = opts as JxMutableNode;

  let raw;
  if (typeof sourcePath === "string") {
    const source = readFileSync(sourcePath, "utf8");
    if (sourcePath.endsWith(".json")) {
      raw = JSON.parse(source);
    } else {
      const { extname } = await import("node:path");
      const ext = extname(sourcePath).toLowerCase();
      const registry = (opts as JxMutableNode)
        .formats as import("@jxsuite/schema/format-registry").FormatRegistry;
      const entry = registry?.byExtension?.(ext, "parse");
      if (!entry) {
        const { unknownFormatError } = await import("./site/format-host.ts");
        throw unknownFormatError(sourcePath, ext);
      }
      raw = await entry.call("parse", source);
    }
  } else {
    raw = sourcePath;
  }

  // Route 0: .class.json schema-defined class → JS class module
  if (raw.$prototype === "Class") {
    const { compileClassJson } = await import("./targets/compile-class.js");
    const jsContent = compileClassJson(raw, opts);
    const outputPath =
      typeof sourcePath === "string"
        ? sourcePath.replace(/\.class\.json$/, ".js")
        : `${raw.title}.js`;
    return { html: "", files: [{ path: outputPath, content: jsContent }] };
  }

  // Route 1: Fully static → plain HTML/CSS
  if (!isDynamic(raw)) {
    return compileStaticPage(raw, {
      title,
      reactivitySrc,
      litHtmlSrc,
      projectStyle,
    });
  }

  // Route 2: Custom element tagName (contains hyphen) → lit-html web component
  if (raw.tagName && raw.tagName.includes("-")) {
    const tagName = raw.tagName;
    const className = tagNameToClassName(tagName);
    const moduleContent = emitElementModule(raw, className, []);
    const moduleFile = {
      path: `${tagName}.js`,
      content: moduleContent,
      tagName,
    };
    const styleBlock = compileStyles(raw, raw.$media ?? {});

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <script type="importmap">
  {
    "imports": {
      "@vue/reactivity": "${reactivitySrc}",
      "lit-html": "${litHtmlSrc}"
    }
  }
  </script>
  ${styleBlock}
</head>
<body>
  <${tagName}></${tagName}>
  <script type="module" src="./${tagName}.js"></script>
</body>
</html>`;

    return { html, files: [moduleFile] };
  }

  // Route 3: Dynamic with standard tagName → pre-rendered HTML + reactive bindings
  return compileClient(raw, { title, reactivitySrc, litHtmlSrc, projectStyle });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

/**
 * @param {string} src
 * @param {string} [out]
 */
export async function runCli(src: string, out?: string) {
  const [result, server] = await Promise.all([compile(src), compileServer(src)]);
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  if (out) {
    writeFileSync(out, result.html, "utf8");
    console.error(`Written to ${out}`);
    const outDir = dirname(out);
    for (const f of result.files) {
      const filePath = join(outDir, f.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, f.content, "utf8");
      console.error(`Written to ${filePath}`);
    }
  } else {
    process.stdout.write(result.html);
  }
  if (server && out) {
    const serverOut = out.replace(/(\.[^.]+)?$/, "-server.js");
    writeFileSync(serverOut, /** @type {string} */ server, "utf8");
    console.error(`Server handler written to ${serverOut}`);
  }
}
