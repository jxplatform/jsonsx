export const internalRefSchema = {
  description: "Reference to a $defs type definition in the current component.",
  type: "string",
  pattern: "^#/\\$defs/",
  examples: ["#/$defs/Count", "#/$defs/TodoItem", "#/$defs/Status"],
} as const;

export const stateRefSchema = {
  description: "Reference to a state entry (runtime variable) in the current component.",
  type: "string",
  pattern: "^#/state/",
  examples: ["#/state/count", "#/state/addTask", "#/state/items"],
} as const;

export const externalRefSchema = {
  description: "Reference to an external Jx component file.",
  type: "string",
  pattern: "^(\\./|\\.\\./).*\\.json$|^https?://",
  examples: ["./card.json", "https://cdn.example.com/button.json"],
} as const;

export const globalRefSchema = {
  description: "Reference to a window or document global.",
  type: "string",
  pattern: "^(window|document)#/",
  examples: ["window#/currentUser", "document#/appConfig"],
} as const;

export const parentRefSchema = {
  description: "Reference to a named state entry passed via $props from a parent component.",
  type: "string",
  pattern: "^parent#/",
  examples: ["parent#/sharedState", "parent#/theme"],
} as const;

export const mapRefSchema = {
  description: "Reference to the current Array map iteration context.",
  type: "string",
  pattern: "^\\$map/(item|index)(/.*)?$",
  examples: ["$map/item", "$map/index", "$map/item/text", "$map/item/done"],
} as const;

export const anyRefSchema = {
  type: "string",
  oneOf: [
    { $ref: "#/$defs/InternalRef" },
    { $ref: "#/$defs/StateRef" },
    { $ref: "#/$defs/ExternalRef" },
    { $ref: "#/$defs/GlobalRef" },
    { $ref: "#/$defs/ParentRef" },
    { $ref: "#/$defs/MapRef" },
  ],
} as const;

export const refObjectSchema = {
  description: "A $ref binding. Resolves to a state entry (reactive) or plain value (static).",
  type: "object",
  required: ["$ref"],
  properties: { $ref: { $ref: "#/$defs/AnyRef" } },
  additionalProperties: false,
} as const;

export const externalComponentRefSchema = {
  type: "object",
  required: ["$ref"],
  properties: {
    $ref: { $ref: "#/$defs/ExternalRef" },
    $props: { $ref: "#/$defs/PropsObject" },
  },
} as const;
