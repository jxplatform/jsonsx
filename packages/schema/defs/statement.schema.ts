// oxlint-disable unicorn/no-thenable -- `then` is the JSON Schema conditional keyword (spec §20), not a promise
/**
 * Statement schema (spec §20) — structured function bodies.
 *
 * A Function entry's `body` may be a JSON array of statements instead of an opaque JS source
 * string: explicit structured function declaration, mirroring ESTree's `BlockStatement.body =
 * Statement[]`. Every statement kind reuses a web-platform name: bare expression nodes (§19), the
 * JSON Schema 2020-12 `if`/`then`/`else` keyword triple, the element-level `$switch`/`cases`
 * convention in statement position, and WHATWG's `dispatchEvent` with `CustomEventInit` members.
 */

export const statementSchema = {
  description:
    "One statement of a structured function body. Either a bare expression node in statement position (a mutation like =/push, or a call — its result discarded unless captured by an assignment), an if/then/else branch (JSON Schema conditional keywords; if holds a pure expression, then/else hold statement lists), a $switch multiway branch (discriminant matched by string form against cases keys, like element-level $switch), or a dispatchEvent statement (WHATWG DOM: dispatches a CustomEvent from the handler's current target, with CustomEventInit members detail/bubbles/composed).",
  oneOf: [
    { $ref: "#/$defs/ExpressionNode" },
    {
      additionalProperties: false,
      properties: {
        else: { items: { $ref: "#/$defs/Statement" }, type: "array" },
        if: { $ref: "#/$defs/ExpressionOperand" },
        then: { items: { $ref: "#/$defs/Statement" }, type: "array" },
      },
      required: ["if", "then"],
      title: "if / then / else — conditional branch (JSON Schema keyword triple)",
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        $switch: { $ref: "#/$defs/ExpressionOperand" },
        cases: {
          additionalProperties: { items: { $ref: "#/$defs/Statement" }, type: "array" },
          type: "object",
        },
        default: { items: { $ref: "#/$defs/Statement" }, type: "array" },
      },
      required: ["$switch", "cases"],
      title: "$switch / cases — multiway branch (element-level convention, ECMA switch semantics)",
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        bubbles: { type: "boolean" },
        composed: { type: "boolean" },
        detail: { $ref: "#/$defs/ExpressionOperand" },
        dispatchEvent: {
          description: "The CustomEvent type to dispatch (WHATWG DOM dispatchEvent).",
          type: "string",
        },
      },
      required: ["dispatchEvent"],
      title: "dispatchEvent — emit a CustomEvent (WHATWG naming, CustomEventInit members)",
      type: "object",
    },
  ],
} as const;

export const statementListSchema = {
  description:
    "A structured function body: statements executed sequentially (one yielding a promise is awaited before the next, per ECMA async/await semantics).",
  items: { $ref: "#/$defs/Statement" },
  type: "array",
} as const;
