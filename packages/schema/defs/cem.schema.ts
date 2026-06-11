export const cemParameterSchema = {
  description:
    "A CEM-compatible parameter definition for a function. " +
    "Follows the Custom Elements Manifest Parameter shape.",
  properties: {
    default: { description: "Default value for the parameter." },
    description: { description: "Parameter documentation.", type: "string" },
    name: { description: "Parameter name.", type: "string" },
    optional: { description: "Whether the parameter is optional.", type: "boolean" },
    type: { description: "Parameter type (JSON Schema or CEM { text } format)." },
  },
  required: ["name"],
  type: "object",
} as const;

export const cemEventSchema = {
  description:
    "A CEM-compatible event definition. " + "Describes a CustomEvent the function dispatches.",
  properties: {
    deprecated: {
      description: "Deprecation notice.",
      oneOf: [{ type: "boolean" }, { type: "string" }],
    },
    description: { description: "Event documentation.", type: "string" },
    name: { description: "Event name (e.g. 'task-toggled').", type: "string" },
    type: { description: "Event type (e.g. { text: 'CustomEvent' })." },
  },
  required: ["name"],
  type: "object",
} as const;
