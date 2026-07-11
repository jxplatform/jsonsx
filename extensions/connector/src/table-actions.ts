/**
 * Table-actions — shared machinery behind TableInsert / TableUpdate / TableDelete.
 *
 * The action classes lower to inline `Function` defs in compiled sites: an event handler that reads
 * the submitting form's FormData (merged under the def's literal `values`), fetches the /_jx/data
 * route, and on success bumps `state._v` — the read-after-write convention every lowered TableQuery
 * URL subscribes to (see table-shared.ts). In the interpreter (dev canvas) the classes resolve to
 * an equivalent real function.
 */

import { jsObjectSource, jsValueSource, resolveIdValue } from "./table-shared.ts";
import type { LowerContext } from "./table-state.ts";

export type ActionMethod = "POST" | "PATCH" | "DELETE";

/** The def shape all three action classes accept. */
export interface ActionDef {
  table?: string;
  id?: unknown;
  /** Literal payload columns merged over the submitting form's FormData. */
  values?: Record<string, unknown>;
  _document?: { route?: { _pathParams?: Record<string, string> } };
  [key: string]: unknown;
}

/** Build the /_jx/data URL JS-source expression for a lowered action. */
function urlSource(method: ActionMethod, def: ActionDef, context: LowerContext): string {
  const table = def.table ?? "";
  if (method === "POST") {
    return jsValueSource(`/_jx/data/${table}`);
  }
  const id = resolveIdValue(def.id, context.route?._pathParams) ?? "";
  return jsValueSource(`/_jx/data/${table}/${id}`);
}

/**
 * Lower an action def into an inline `Function` def (specs/extensions.md §8.3).
 *
 * @param {ActionMethod} method
 * @param {ActionDef} def
 * @param {LowerContext} [context]
 * @returns {Record<string, unknown>} A core Function def with an `event` parameter
 */
export function lowerActionDef(
  method: ActionMethod,
  def: ActionDef,
  context: LowerContext = {},
): Record<string, unknown> {
  const url = urlSource(method, def, context);
  const lines: string[] = [
    "if (event && typeof event.preventDefault === 'function') event.preventDefault();",
  ];
  if (method === "DELETE") {
    lines.push(
      `fetch(${url}, { method: 'DELETE' }).then(function (res) {`,
      "  if (res.ok) { state._v = (state._v || 0) + 1; }",
      "});",
    );
  } else {
    lines.push(
      "var form = event && event.target && event.target.tagName === 'FORM' ? event.target : " +
        "((event && event.target && event.target.form) || null);",
      "var payload = Object.assign({}, form ? Object.fromEntries(new FormData(form)) : {}, " +
        `${jsObjectSource(def.values)});`,
      `fetch(${url}, { method: '${method}', headers: { 'Content-Type': 'application/json' }, ` +
        "body: JSON.stringify(payload) }).then(function (res) {",
      "  if (res.ok) {",
      ...(method === "POST"
        ? ["    if (form && typeof form.reset === 'function') form.reset();"]
        : []),
      "    state._v = (state._v || 0) + 1;",
      "  }",
      "});",
    );
  }
  return {
    $prototype: "Function",
    body: lines.join("\n"),
    parameters: ["event"],
    timing: "client",
  };
}

/** Evaluate a `${...}`-bearing values object against a live scope (interpreter path). */
function evaluateValues(
  values: Record<string, unknown> | undefined,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value === "string" && value.includes("${")) {
      try {
        const fn = new Function("state", `return \`${value}\`;`) as (
          state: Record<string, unknown>,
        ) => unknown;
        out[key] = fn(scope);
      } catch {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Build the live handler an action class resolves to in the interpreter (dev canvas).
 *
 * @param {ActionMethod} method
 * @param {ActionDef} config
 * @returns {(scope: Record<string, unknown>, event?: Event) => Promise<boolean>} Resolves true when
 *   the write succeeded (and `scope._v` was bumped)
 */
export function makeActionHandler(method: ActionMethod, config: ActionDef) {
  return async (scope: Record<string, unknown>, event?: Event): Promise<boolean> => {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    const table = config.table ?? "";
    let url = `/_jx/data/${table}`;
    if (method !== "POST") {
      const id = resolveIdValue(config.id, config._document?.route?._pathParams) ?? "";
      url = `${url}/${id}`;
    }

    let init: RequestInit;
    let form: HTMLFormElement | null = null;
    if (method === "DELETE") {
      init = { method };
    } else {
      const target = event?.target as
        | (HTMLElement & { form?: HTMLFormElement | null })
        | null
        | undefined;
      form =
        target && target.tagName === "FORM" ? (target as HTMLFormElement) : (target?.form ?? null);
      const formData = form ? Object.fromEntries(new FormData(form)) : {};
      const payload = { ...formData, ...evaluateValues(config.values, scope) };
      init = {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method,
      };
    }

    const response = await fetch(url, init);
    if (response.ok) {
      if (method === "POST" && form && typeof form.reset === "function") {
        form.reset();
      }
      scope._v = ((scope._v as number) || 0) + 1;
    }
    return response.ok;
  };
}
