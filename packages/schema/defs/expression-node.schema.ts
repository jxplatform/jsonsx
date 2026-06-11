export const expressionPointerSchema = {
  additionalProperties: false,
  description: "A JSON Pointer $ref operand within an expression node.",
  properties: {
    $ref: {
      pattern: "^(\\$map/|\\$reduce/|event#/|#/|parent#/|window#/|document#/)",
      type: "string",
    },
  },
  required: ["$ref"],
  type: "object",
} as const;

export const expressionLiteralSchema = {
  anyOf: [
    { not: { pattern: "\\$\\{" }, type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { items: { $ref: "#/$defs/ExpressionOperand" }, type: "array" },
  ],
  description: "A non-reactive operand: scalar or array of operands.",
} as const;

export const expressionOperandSchema = {
  anyOf: [
    { $ref: "#/$defs/ExpressionPointer" },
    { $ref: "#/$defs/ExpressionNode" },
    { $ref: "#/$defs/ExpressionLiteral" },
  ],
  description:
    "Anything that may appear in target or value: a pointer, a literal, or a nested expression node.",
} as const;

export const unaryOperatorSchema = { enum: ["!", "-"] } as const;
export const binaryOperatorSchema = {
  enum: ["+", "-", "*", "/", "%", "===", "!==", "<", "<=", ">", ">=", "&&", "||"],
} as const;
export const assignmentOperatorSchema = { enum: ["=", "+=", "-=", "*=", "/="] } as const;
export const noArgMethodSchema = { enum: ["pop", "shift"] } as const;
export const oneArgMethodSchema = { enum: ["push", "unshift"] } as const;
export const spliceMethodSchema = { const: "splice" } as const;
export const reduceMethodSchema = { const: "reduce" } as const;
export const mapFilterMethodSchema = { enum: ["map", "filter"] } as const;

export const expressionNodeSchema = {
  additionalProperties: false,
  description: "The core expression node. operator + target, with value gated by arity.",
  oneOf: [
    {
      not: { anyOf: [{ required: ["value"] }, { required: ["initial"] }] },
      properties: { operator: { $ref: "#/$defs/UnaryOperator" } },
      required: ["operator"],
      title: "Unary — target only, no value",
    },
    {
      not: { required: ["initial"] },
      properties: { operator: { $ref: "#/$defs/BinaryOperator" } },
      required: ["operator", "value"],
      title: "Binary — left in target, right in value",
    },
    {
      not: { required: ["initial"] },
      properties: {
        operator: { $ref: "#/$defs/AssignmentOperator" },
        target: { $ref: "#/$defs/ExpressionPointer" },
      },
      required: ["operator", "value"],
      title: "Assignment — writable target, value required",
    },
    {
      not: { anyOf: [{ required: ["value"] }, { required: ["initial"] }] },
      properties: {
        operator: { $ref: "#/$defs/NoArgMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
      },
      required: ["operator"],
      title: "pop / shift — array receiver, no value",
    },
    {
      not: { required: ["initial"] },
      properties: {
        operator: { $ref: "#/$defs/OneArgMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
      },
      required: ["operator", "value"],
      title: "push / unshift — array receiver, single value argument",
    },
    {
      not: { required: ["initial"] },
      properties: {
        operator: { $ref: "#/$defs/SpliceMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
        value: { items: { $ref: "#/$defs/ExpressionOperand" }, minItems: 1, type: "array" },
      },
      required: ["operator", "value"],
      title: "splice — array receiver, [start, deleteCount, ...items]",
    },
    {
      properties: {
        operator: { $ref: "#/$defs/ReduceMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
        value: { $ref: "#/$defs/ExpressionNode" },
      },
      required: ["operator", "value", "initial"],
      title: "reduce — pure fold; per-item expression in value, seed in initial",
    },
    {
      not: { required: ["initial"] },
      properties: {
        operator: { $ref: "#/$defs/MapFilterMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
        value: { $ref: "#/$defs/ExpressionNode" },
      },
      required: ["operator", "value"],
      title: "map / filter — pure; per-item expression in value, no initial",
    },
  ],
  properties: {
    initial: { $ref: "#/$defs/ExpressionOperand" },
    operator: { type: "string" },
    target: { $ref: "#/$defs/ExpressionOperand" },
    value: { $ref: "#/$defs/ExpressionOperand" },
  },
  required: ["operator", "target"],
  type: "object",
} as const;

export const expressionEntrySchema = {
  additionalProperties: false,
  description:
    "A declarative expression entry (Shape 5). Used as a state entry or inline event handler.",
  properties: {
    $description: { type: "string" },
    $expression: { $ref: "#/$defs/ExpressionNode" },
    $title: { type: "string" },
  },
  required: ["$expression"],
  type: "object",
} as const;
