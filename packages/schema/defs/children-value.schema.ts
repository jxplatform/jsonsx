export const arrayNamespaceSchema = {
  additionalProperties: false,
  description: "Dynamic mapped list. Re-renders when the items state entry changes.",
  properties: {
    $prototype: { const: "Array", type: "string" },
    filter: { $ref: "#/$defs/RefObject" },
    items: {
      oneOf: [{ $ref: "#/$defs/RefObject" }, { type: "array" }],
    },
    map: { $ref: "#/$defs/ElementDef" },
    sort: { $ref: "#/$defs/RefObject" },
  },
  required: ["$prototype", "items", "map"],
  type: "object",
} as const;

export const childrenValueSchema = {
  description:
    "Array of child definitions — elements, text, or Array namespaces (dynamic lists) mixed " +
    "freely. A bare Array namespace (the whole children slot is one dynamic list) is also " +
    "accepted for backward compatibility, as is a ${…} template string that resolves at build " +
    "time to an array of child definitions.",
  oneOf: [
    {
      items: {
        /* `anyOf`, not `oneOf`, and SwitchNode is the reason for both halves of that.
           `$defs.SwitchNode` was defined and referenced from nowhere — a node the compiler fully
           renders (`shared.ts` renderSwitch) that no position in the schema admitted, so every
           document with a `$switch` child failed `jx validate`. Adding the ref under `oneOf` would
           have traded one break for another: a switch child that also carries `tagName` (its
           container element) matches ElementDef AND SwitchNode, and "exactly one" then rejects the
           form that works today. `anyOf` accepts both, and still rejects a child object that is
           neither. */
        anyOf: [
          { $ref: "#/$defs/ElementDef" },
          { $ref: "#/$defs/SwitchNode" },
          { $ref: "#/$defs/ArrayNamespace" },
          { type: "string" },
          { type: "number" },
        ],
      },
      type: "array",
    },
    { $ref: "#/$defs/ArrayNamespace" },
    {
      description:
        "Computed children — a ${…} template that resolves at build time to an array of child " +
        'definitions (e.g. "${state.entry.$children}" for parsed content). A bare plain-text ' +
        "string is NOT a valid children value; text children must be array items.",
      pattern: "\\$\\{",
      type: "string",
    },
  ],
} as const;
