/// <reference lib="dom" />
/**
 * Jx Statement Engine (spec §20) — structured function bodies.
 *
 * A Function entry's `body` may be a statement array instead of opaque JS source. This module is
 * the statements counterpart to expression.ts, with the same dual shape: `runStatements`
 * (interpreter) and `compileStatements` (JS emitter), shared by the runtime and every compiler
 * target. Statement kinds reuse web-platform names only: bare expression nodes (§19), the JSON
 * Schema `if`/`then`/`else` triple, `$switch`/`cases` in statement position, and WHATWG's
 * `dispatchEvent` with `CustomEventInit` members.
 */

import {
  compileExpression,
  compileOperandSource,
  evaluateExpression,
  evaluateOperand,
} from "./expression.ts";

import type { JxStatement } from "@jxsuite/schema/types";
import type { CompileOpts, ExpressionNode, IterCtx } from "./expression.ts";
import type { JxScope } from "./types.ts";

interface RunOpts {
  /** Named-formula-style arguments bound for $args/<name> refs in the body. */
  args?: Record<string, unknown>;
  /** Dispatch target for dispatchEvent statements; defaults to event?.currentTarget. */
  target?: EventTarget | null;
}

function statementKind(statement: JxStatement): "expression" | "if" | "switch" | "dispatch" {
  if ("operator" in statement) {
    return "expression";
  }
  if ("if" in statement) {
    return "if";
  }
  if ("$switch" in statement) {
    return "switch";
  }
  return "dispatch";
}

/**
 * Execute a statement list sequentially against the reactive scope. A statement whose value is a
 * thenable is awaited before the next runs (ECMA async/await semantics); purely synchronous bodies
 * complete synchronously before the returned promise settles.
 */
export async function runStatements(
  statements: JxStatement[],
  state: JxScope,
  event: Event | null,
  opts: RunOpts = {},
): Promise<void> {
  const iterCtx: IterCtx | undefined = opts.args ? { args: opts.args } : undefined;
  for (const statement of statements) {
    switch (statementKind(statement)) {
      case "expression": {
        const result = evaluateExpression(statement as ExpressionNode, state, event, iterCtx);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          await (result as PromiseLike<unknown>);
        }
        break;
      }
      case "if": {
        const branch = statement as { if: unknown; then: JxStatement[]; else?: JxStatement[] };
        const taken = evaluateOperand(branch.if, state, event, iterCtx) ? branch.then : branch.else;
        if (Array.isArray(taken)) {
          await runStatements(taken, state, event, opts);
        }
        break;
      }
      case "switch": {
        const branch = statement as {
          $switch: unknown;
          cases: Record<string, JxStatement[]>;
          default?: JxStatement[];
        };
        const key = String(evaluateOperand(branch.$switch, state, event, iterCtx));
        const cases = branch.cases ?? {};
        const taken = Object.hasOwn(cases, key) ? cases[key] : branch.default;
        if (Array.isArray(taken)) {
          await runStatements(taken, state, event, opts);
        }
        break;
      }
      case "dispatch": {
        const dispatch = statement as {
          dispatchEvent: string;
          detail?: unknown;
          bubbles?: boolean;
          composed?: boolean;
        };
        const target = opts.target ?? event?.currentTarget;
        if (!target) {
          break;
        }
        const init: CustomEventInit = {};
        if ("detail" in dispatch) {
          init.detail = evaluateOperand(dispatch.detail, state, event, iterCtx);
        }
        if (dispatch.bubbles !== undefined) {
          init.bubbles = dispatch.bubbles;
        }
        if (dispatch.composed !== undefined) {
          init.composed = dispatch.composed;
        }
        target.dispatchEvent(new CustomEvent(dispatch.dispatchEvent, init));
        break;
      }
      default: {
        break;
      }
    }
  }
}

interface StatementCompileOpts extends CompileOpts {
  /** JS expression for the dispatchEvent target; defaults to `(event && event.currentTarget)`. */
  dispatchTarget?: string;
  /** Indentation prefix for emitted lines. */
  indent?: string;
}

/**
 * Compile a statement list to a JS statement block (no surrounding braces). Mirrors `runStatements`
 * exactly; each statement kind lowers to its genuine ECMAScript form — expression statements,
 * `if`/`else`, `switch` over the discriminant's string form, and `dispatchEvent(new
 * CustomEvent(...))`.
 */
export function compileStatements(
  statements: JxStatement[],
  opts: StatementCompileOpts = {},
): string {
  const indent = opts.indent ?? "";
  const lines: string[] = [];
  for (const statement of statements) {
    switch (statementKind(statement)) {
      case "expression": {
        lines.push(`${indent}${compileExpression(statement as ExpressionNode, opts)};`);
        break;
      }
      case "if": {
        const branch = statement as { if: unknown; then: JxStatement[]; else?: JxStatement[] };
        const test = compileOperandSource(branch.if, opts);
        const inner = { ...opts, indent: `${indent}  ` };
        lines.push(`${indent}if (${test}) {`, compileStatements(branch.then ?? [], inner));
        if (branch.else) {
          lines.push(`${indent}} else {`, compileStatements(branch.else, inner));
        }
        lines.push(`${indent}}`);
        break;
      }
      case "switch": {
        const branch = statement as {
          $switch: unknown;
          cases: Record<string, JxStatement[]>;
          default?: JxStatement[];
        };
        const disc = compileOperandSource(branch.$switch, opts);
        const inner = { ...opts, indent: `${indent}    ` };
        lines.push(`${indent}switch (String(${disc})) {`);
        for (const [key, caseStatements] of Object.entries(branch.cases ?? {})) {
          lines.push(
            `${indent}  case ${JSON.stringify(key)}: {`,
            compileStatements(caseStatements, inner),
            `${indent}    break;`,
            `${indent}  }`,
          );
        }
        if (branch.default) {
          lines.push(
            `${indent}  default: {`,
            compileStatements(branch.default, inner),
            `${indent}  }`,
          );
        }
        lines.push(`${indent}}`);
        break;
      }
      case "dispatch": {
        const dispatch = statement as {
          dispatchEvent: string;
          detail?: unknown;
          bubbles?: boolean;
          composed?: boolean;
        };
        const eventName = opts.eventParam ?? "event";
        const target = opts.dispatchTarget ?? `(${eventName} && ${eventName}.currentTarget)`;
        const init: string[] = [];
        if ("detail" in dispatch) {
          init.push(`detail: ${compileOperandSource(dispatch.detail, opts)}`);
        }
        if (dispatch.bubbles !== undefined) {
          init.push(`bubbles: ${JSON.stringify(dispatch.bubbles)}`);
        }
        if (dispatch.composed !== undefined) {
          init.push(`composed: ${JSON.stringify(dispatch.composed)}`);
        }
        const initSource = init.length > 0 ? `, { ${init.join(", ")} }` : "";
        lines.push(
          `${indent}${target}?.dispatchEvent(new CustomEvent(${JSON.stringify(dispatch.dispatchEvent)}${initSource}));`,
        );
        break;
      }
      default: {
        break;
      }
    }
  }
  return lines.join("\n");
}
