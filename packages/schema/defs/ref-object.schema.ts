export const internalRefSchema = {
  description: "Reference to a $defs type definition in the current component.",
  examples: ["#/$defs/Count", "#/$defs/TodoItem", "#/$defs/Status"],
  pattern: "^#/\\$defs/",
  type: "string",
} as const;

export const stateRefSchema = {
  description: "Reference to a state entry (runtime variable) in the current component.",
  examples: ["#/state/count", "#/state/addTask", "#/state/items"],
  pattern: "^#/state/",
  type: "string",
} as const;

export const externalRefSchema = {
  description: "Reference to an external Jx component file.",
  examples: ["./card.json", "https://cdn.example.com/button.json"],
  pattern: "^(\\./|\\.\\./).*\\.json$|^https?://",
  type: "string",
} as const;

export const globalRefSchema = {
  description: "Reference to a window or document global.",
  examples: ["window#/currentUser", "document#/appConfig"],
  pattern: "^(window|document)#/",
  type: "string",
} as const;

export const parentRefSchema = {
  description: "Reference to a named state entry passed via $props from a parent component.",
  examples: ["parent#/sharedState", "parent#/theme"],
  pattern: "^parent#/",
  type: "string",
} as const;

export const mapRefSchema = {
  description: "Reference to the current Array map iteration context.",
  examples: ["$map/item", "$map/index", "$map/item/text", "$map/item/done"],
  pattern: "^\\$map/(item|index)(/.*)?$",
  type: "string",
} as const;

export const anyRefSchema = {
  oneOf: [
    { $ref: "#/$defs/InternalRef" },
    { $ref: "#/$defs/StateRef" },
    { $ref: "#/$defs/ExternalRef" },
    { $ref: "#/$defs/GlobalRef" },
    { $ref: "#/$defs/ParentRef" },
    { $ref: "#/$defs/MapRef" },
  ],
  type: "string",
} as const;

export const refObjectSchema = {
  additionalProperties: false,
  description: "A $ref binding. Resolves to a state entry (reactive) or plain value (static).",
  properties: { $ref: { $ref: "#/$defs/AnyRef" } },
  required: ["$ref"],
  type: "object",
} as const;

export const externalComponentRefSchema = {
  properties: {
    $props: { $ref: "#/$defs/PropsObject" },
    $ref: { $ref: "#/$defs/ExternalRef" },
  },
  required: ["$ref"],
  type: "object",
} as const;
