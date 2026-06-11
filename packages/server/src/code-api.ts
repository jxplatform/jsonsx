/**
 * Code-api.js — OXC-powered code services for the studio function editor
 *
 * Endpoints under /__studio/code/* that provide formatting (oxfmt), minification (Bun.Transpiler),
 * and linting (oxlint CLI) for JS snippets.
 */

import { tmpdir } from "node:os";
import { errorMessage } from "@jxsuite/schema/parse";
import { join, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { format } from "oxfmt";

interface OxcLabel {
  span: { offset: number; line: number; [key: string]: unknown };
  [key: string]: unknown;
}

interface OxcDiagnostic {
  labels?: OxcLabel[];
  [key: string]: unknown;
}

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
function wrapBody(body: string, args: string[] = ["state", "event"]) {
  const params = args.join(", ");
  return `function __jx_fn__(${params}) {\n${body}\n}`;
}

/** @param {string} formatted */
function unwrapFormatted(formatted: string) {
  const lines = formatted.split("\n");
  // Remove first line (function header) and last non-empty line (closing brace)
  let end = lines.length - 1;
  while (end > 0 && lines[end].trim() === "") {
    end -= 1;
  }
  if (lines[end].trim() === "}") {
    end -= 1;
  }
  const bodyLines = lines.slice(1, end + 1);
  // Dedent by one tab (oxfmt uses the project's indentStyle)
  return bodyLines.map((l) => (l.startsWith("\t") ? l.slice(1) : l)).join("\n");
}

/**
 * @param {OxcDiagnostic[]} diagnostics
 * @param {number} headerLen
 */
function adjustDiagnostics(diagnostics: OxcDiagnostic[], headerLen: number) {
  return diagnostics
    .filter((d) => {
      const line = d.labels?.[0]?.span?.line;
      return line == null || line > 1;
    })
    .map((d) => {
      // Diagnostics are freshly parsed and serialized right after; mutate in place
      for (const label of d.labels ?? []) {
        label.span.line -= 1;
        label.span.offset -= headerLen;
      }
      return d;
    });
}

// ─── Reusable transpiler ─────────────────────────────────────────────────────

const minifier = new Bun.Transpiler({ minifyWhitespace: true });

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * @param {Request} req
 * @param {URL} url
 */
export async function handleCodeApi(req: Request, url: URL) {
  const path = url.pathname;
  if (!path.startsWith("/__studio/code/") || req.method !== "POST") {
    return null;
  }

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
    if (!code?.trim()) {
      return Response.json({ code: "", errors: [] });
    }

    try {
      const wrapped = wrapBody(code, args);
      const result = await format("fn.js", wrapped, { useTabs: true });
      return Response.json({
        code: unwrapFormatted(result.code),
        errors: result.errors,
      });
    } catch (error) {
      return Response.json({
        code,
        errors: [{ message: errorMessage(error) }],
      });
    }
  }

  // ── Minify ─────────────────────────────────────────────────────────────────

  if (action === "minify") {
    const { code } = body;
    if (!code?.trim()) {
      return Response.json({ code: "" });
    }

    try {
      const minified = minifier.transformSync(code).trim();
      return Response.json({ code: minified });
    } catch (error) {
      return Response.json({ code, error: errorMessage(error) });
    }
  }

  // ── Lint ───────────────────────────────────────────────────────────────────

  if (action === "lint") {
    const { code, args } = body;
    if (!code?.trim()) {
      return Response.json({ diagnostics: [] });
    }

    const wrapped = wrapBody(code, args);
    const headerLen = wrapped.indexOf("\n") + 1;
    const tmpFile = join(
      tmpdir(),
      `__jx_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.js`,
    );

    try {
      await Bun.write(tmpFile, wrapped);
      const proc = Bun.spawn([OXLINT_BIN, "--format=json", "-A", "no-unused-vars", tmpFile], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const parsed = JSON.parse(output);
      const adjusted = adjustDiagnostics(parsed.diagnostics || [], headerLen);
      return Response.json({ diagnostics: adjusted });
    } catch (error) {
      return Response.json({
        diagnostics: [],
        error: errorMessage(error),
      });
    } finally {
      try {
        await unlink(tmpFile);
      } catch {}
    }
  }

  return null;
}
