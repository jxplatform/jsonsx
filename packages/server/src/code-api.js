/**
 * Code-api.js — OXC-powered code services for the studio function editor
 *
 * Endpoints under /__studio/code/* that provide formatting (oxfmt), minification (Bun.Transpiler),
 * and linting (oxlint CLI) for JS snippets.
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { format } from "oxfmt";

/**
 * @typedef {{
 *   span: { offset: number; line: number; [key: string]: unknown };
 *   [key: string]: unknown;
 * }} OxcLabel
 *
 * @typedef {{ labels?: OxcLabel[]; [key: string]: unknown }} OxcDiagnostic
 */

const OXLINT_BIN = resolve(
  import.meta.dir,
  "../../node_modules/.bin",
  process.platform === "win32" ? "oxlint.exe" : "oxlint",
);

// ─── Wrapper utilities ───────────────────────────────────────────────────────

/**
 * @param {string} body
 * @param {string[]} [args]
 */
function wrapBody(body, args = ["state", "event"]) {
  const params = args.join(", ");
  return `function __jx_fn__(${params}) {\n${body}\n}`;
}

/** @param {string} formatted */
function unwrapFormatted(formatted) {
  const lines = formatted.split("\n");
  // Remove first line (function header) and last non-empty line (closing brace)
  let end = lines.length - 1;
  while (end > 0 && lines[end].trim() === "") end--;
  if (lines[end].trim() === "}") end--;
  const bodyLines = lines.slice(1, end + 1);
  // Dedent by one tab (oxfmt uses the project's indentStyle)
  return bodyLines.map((l) => (l.startsWith("\t") ? l.slice(1) : l)).join("\n");
}

/**
 * @param {OxcDiagnostic[]} diagnostics
 * @param {number} headerLen
 */
function adjustDiagnostics(diagnostics, headerLen) {
  return diagnostics
    .filter((d) => {
      const line = d.labels?.[0]?.span?.line;
      return line == null || line > 1;
    })
    .map((d) => ({
      ...d,
      labels: d.labels?.map((label) => ({
        ...label,
        span: {
          ...label.span,
          offset: label.span.offset - headerLen,
          line: label.span.line - 1,
        },
      })),
    }));
}

// ─── Reusable transpiler ─────────────────────────────────────────────────────

const minifier = new Bun.Transpiler({ minifyWhitespace: true });

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * @param {Request} req
 * @param {URL} url
 */
export async function handleCodeApi(req, url) {
  const path = url.pathname;
  if (!path.startsWith("/__studio/code/") || req.method !== "POST") return null;

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const action = path.slice("/__studio/code/".length);

  // ── Format ─────────────────────────────────────────────────────────────────

  if (action === "format") {
    const { code, args } = body;
    if (!code?.trim()) return Response.json({ code: "", errors: [] });

    try {
      const wrapped = wrapBody(code, args);
      const result = await format("fn.js", wrapped, { useTabs: true });
      return Response.json({
        code: unwrapFormatted(result.code),
        errors: result.errors,
      });
    } catch (/** @type {unknown} */ e) {
      return Response.json({
        code,
        errors: [{ message: /** @type {{ message?: string }} */ (e).message }],
      });
    }
  }

  // ── Minify ─────────────────────────────────────────────────────────────────

  if (action === "minify") {
    const { code } = body;
    if (!code?.trim()) return Response.json({ code: "" });

    try {
      const minified = minifier.transformSync(code).trim();
      return Response.json({ code: minified });
    } catch (/** @type {unknown} */ e) {
      return Response.json({ code, error: /** @type {{ message?: string }} */ (e).message });
    }
  }

  // ── Lint ───────────────────────────────────────────────────────────────────

  if (action === "lint") {
    const { code, args } = body;
    if (!code?.trim()) return Response.json({ diagnostics: [] });

    const wrapped = wrapBody(code, args);
    const headerLen = wrapped.indexOf("\n") + 1;
    const tmpFile = join(
      tmpdir(),
      `__jx_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.js`,
    );

    try {
      await Bun.write(tmpFile, wrapped);
      const proc = Bun.spawn([OXLINT_BIN, "--format=json", "-A", "no-unused-vars", tmpFile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const parsed = JSON.parse(output);
      const adjusted = adjustDiagnostics(parsed.diagnostics || [], headerLen);
      return Response.json({ diagnostics: adjusted });
    } catch (/** @type {unknown} */ e) {
      return Response.json({
        diagnostics: [],
        error: /** @type {{ message?: string }} */ (e).message,
      });
    } finally {
      try {
        await unlink(tmpFile);
      } catch {}
    }
  }

  return null;
}
