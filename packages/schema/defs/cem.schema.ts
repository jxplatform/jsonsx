export const cemParameterSchema = {
  description:
    "A CEM-compatible parameter definition for a function. " +
    "Follows the Custom Elements Manifest Parameter shape.",
  type: "object",
  required: ["name"],
  properties: {
    name: { description: "Parameter name.", type: "string" },
    type: { description: "Parameter type (JSON Schema or CEM { text } format)." },
    description: { description: "Parameter documentation.", type: "string" },
    optional: { description: "Whether the parameter is optional.", type: "boolean" },
    default: { description: "Default value for the parameter." },
  },
} as const;

export const cemEventSchema = {
  description:
    "A CEM-compatible event definition. " + "Describes a CustomEvent the function dispatches.",
  type: "object",
  required: ["name"],
  properties: {
    name: { description: "Event name (e.g. 'task-toggled').", type: "string" },
    type: { description: "Event type (e.g. { text: 'CustomEvent' })." },
    description: { description: "Event documentation.", type: "string" },
    deprecated: {
      description: "Deprecation notice.",
      oneOf: [{ type: "boolean" }, { type: "string" }],
    },
  },
} as const;
