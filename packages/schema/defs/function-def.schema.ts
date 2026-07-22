export const functionDefSchema = {
  additionalProperties: false,
  description:
    'A function declaration. $prototype must be "Function". ' +
    "body (inline) and $src (external) are mutually exclusive. " +
    "First parameter is always state (the reactive scope).",
  properties: {
    $export: {
      description: "Named export in $src module. Defaults to the state key name.",
      type: "string",
    },
    $prototype: { const: "Function", type: "string" },
    $src: {
      description: "External module specifier. Mutually exclusive with body.",
      examples: ["./counter.js", "npm:@myorg/validators"],
      type: "string",
    },
    arguments: {
      description:
        "Legacy alias for parameters: bare string parameter names (state may be listed " +
        "explicitly as the first name). Superseded by parameters.",
      examples: [["state", "event"]],
      items: { type: "string" },
      type: "array",
    },
    body: {
      description:
        "Inline function body: an opaque JS source string (first implicit parameter is state), or a structured statement array (spec §20) — explicit structured function declaration, analyzable by tooling and editable visually. The escalation ladder within the shape is structured statements → JS string.",
      examples: [
        "state.count++",
        'state.items.push({ id: Date.now(), text: "", done: false })',
        'return state.score >= 90 ? "gold" : "silver"',
        [
          { operator: "push", target: { $ref: "#/state/cart" }, value: 1 },
          { dispatchEvent: "cart-changed", detail: { $ref: "#/state/cart" } },
        ],
      ],
      oneOf: [{ type: "string" }, { $ref: "#/$defs/StatementList" }],
    },
    description: { type: "string" },
    emits: {
      description:
        "Array of CEM-compatible Event objects this function dispatches. " +
        "Used for CEM extraction and studio event discovery.",
      items: { $ref: "#/$defs/CemEvent" },
      type: "array",
    },
    name: {
      description: "Explicit function name. Defaults to the state key name.",
      type: "string",
    },
    parameters: {
      description:
        "Function parameters (after the implicit state parameter). " +
        "Accepts CEM-compatible parameter objects or bare string names for backward compatibility.",
      examples: [
        ["event"],
        [{ name: "event", type: { text: "Event" } }],
        [{ description: "Item identifier", name: "id", type: { text: "number" } }],
      ],
      items: {
        oneOf: [{ type: "string" }, { $ref: "#/$defs/CemParameter" }],
      },
      type: "array",
    },
    type: {
      description: "Return type for tooling (JSON Schema or CEM { text } format).",
    },
  },
  required: ["$prototype"],
  type: "object",
} as const;
