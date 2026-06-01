export const functionDefSchema = {
  description:
    'A function declaration. $prototype must be "Function". ' +
    "body (inline) and $src (external) are mutually exclusive. " +
    "First parameter is always state (the reactive scope).",
  type: "object",
  required: ["$prototype"],
  properties: {
    $prototype: { type: "string", const: "Function" },
    body: {
      description: "Inline function body string. First implicit parameter is state.",
      type: "string",
      examples: [
        "state.count++",
        'state.items.push({ id: Date.now(), text: "", done: false })',
        'return state.score >= 90 ? "gold" : "silver"',
      ],
    },
    parameters: {
      description:
        "Function parameters (after the implicit state parameter). " +
        "Accepts CEM-compatible parameter objects or bare string names for backward compatibility.",
      type: "array",
      items: {
        oneOf: [{ type: "string" }, { $ref: "#/$defs/CemParameter" }],
      },
      examples: [
        ["event"],
        [{ name: "event", type: { text: "Event" } }],
        [{ name: "id", type: { text: "number" }, description: "Item identifier" }],
      ],
    },
    name: {
      description: "Explicit function name. Defaults to the state key name.",
      type: "string",
    },
    $src: {
      description: "External module specifier. Mutually exclusive with body.",
      type: "string",
      examples: ["./counter.js", "npm:@myorg/validators"],
    },
    $export: {
      description: "Named export in $src module. Defaults to the state key name.",
      type: "string",
    },
    type: {
      description: "Return type for tooling (JSON Schema or CEM { text } format).",
    },
    emits: {
      description:
        "Array of CEM-compatible Event objects this function dispatches. " +
        "Used for CEM extraction and studio event discovery.",
      type: "array",
      items: { $ref: "#/$defs/CemEvent" },
    },
    description: { type: "string" },
  },
  additionalProperties: false,
} as const;
