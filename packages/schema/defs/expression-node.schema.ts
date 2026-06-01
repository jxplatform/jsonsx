export const expressionPointerSchema = {
  description: "A JSON Pointer $ref operand within an expression node.",
  type: "object",
  properties: {
    $ref: {
      type: "string",
      pattern: "^(\\$map/|\\$reduce/|event#/|#/|parent#/|window#/|document#/)",
    },
  },
  required: ["$ref"],
  additionalProperties: false,
} as const;

export const expressionLiteralSchema = {
  description: "A non-reactive operand: scalar or array of operands.",
  anyOf: [
    { type: "string", not: { pattern: "\\$\\{" } },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array", items: { $ref: "#/$defs/ExpressionOperand" } },
  ],
} as const;

export const expressionOperandSchema = {
  description:
    "Anything that may appear in target or value: a pointer, a literal, or a nested expression node.",
  anyOf: [
    { $ref: "#/$defs/ExpressionPointer" },
    { $ref: "#/$defs/ExpressionNode" },
    { $ref: "#/$defs/ExpressionLiteral" },
  ],
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
  description: "The core expression node. operator + target, with value gated by arity.",
  type: "object",
  required: ["operator", "target"],
  additionalProperties: false,
  properties: {
    operator: { type: "string" },
    target: { $ref: "#/$defs/ExpressionOperand" },
    value: { $ref: "#/$defs/ExpressionOperand" },
    initial: { $ref: "#/$defs/ExpressionOperand" },
  },
  oneOf: [
    {
      title: "Unary — target only, no value",
      properties: { operator: { $ref: "#/$defs/UnaryOperator" } },
      required: ["operator"],
      not: { anyOf: [{ required: ["value"] }, { required: ["initial"] }] },
    },
    {
      title: "Binary — left in target, right in value",
      properties: { operator: { $ref: "#/$defs/BinaryOperator" } },
      required: ["operator", "value"],
      not: { required: ["initial"] },
    },
    {
      title: "Assignment — writable target, value required",
      properties: {
        operator: { $ref: "#/$defs/AssignmentOperator" },
        target: { $ref: "#/$defs/ExpressionPointer" },
      },
      required: ["operator", "value"],
      not: { required: ["initial"] },
    },
    {
      title: "pop / shift — array receiver, no value",
      properties: {
        operator: { $ref: "#/$defs/NoArgMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
      },
      required: ["operator"],
      not: { anyOf: [{ required: ["value"] }, { required: ["initial"] }] },
    },
    {
      title: "push / unshift — array receiver, single value argument",
      properties: {
        operator: { $ref: "#/$defs/OneArgMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
      },
      required: ["operator", "value"],
      not: { required: ["initial"] },
    },
    {
      title: "splice — array receiver, [start, deleteCount, ...items]",
      properties: {
        operator: { $ref: "#/$defs/SpliceMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
        value: { type: "array", items: { $ref: "#/$defs/ExpressionOperand" }, minItems: 1 },
      },
      required: ["operator", "value"],
      not: { required: ["initial"] },
    },
    {
      title: "reduce — pure fold; per-item expression in value, seed in initial",
      properties: {
        operator: { $ref: "#/$defs/ReduceMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
        value: { $ref: "#/$defs/ExpressionNode" },
      },
      required: ["operator", "value", "initial"],
    },
    {
      title: "map / filter — pure; per-item expression in value, no initial",
      properties: {
        operator: { $ref: "#/$defs/MapFilterMethod" },
        target: { $ref: "#/$defs/ExpressionPointer" },
        value: { $ref: "#/$defs/ExpressionNode" },
      },
      required: ["operator", "value"],
      not: { required: ["initial"] },
    },
  ],
} as const;

export const expressionEntrySchema = {
  description:
    "A declarative expression entry (Shape 5). Used as a state entry or inline event handler.",
  type: "object",
  required: ["$expression"],
  properties: {
    $expression: { $ref: "#/$defs/ExpressionNode" },
    $title: { type: "string" },
    $description: { type: "string" },
  },
  additionalProperties: false,
} as const;
