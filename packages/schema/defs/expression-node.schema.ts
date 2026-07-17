export const expressionPointerSchema = {
  additionalProperties: false,
  description:
    "A JSON Pointer $ref operand within an expression node. $args/<name> resolves a named formula's parameter (callable entries only).",
  properties: {
    $ref: {
      pattern: "^(\\$map/|\\$reduce/|\\$args/|event#/|#/|parent#/|window#/|document#/)",
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
    {
      description:
        "Plain-object literal (e.g. an Intl options bag). Objects carrying $ref or operator keys are pointers/nodes, never literals.",
      not: { anyOf: [{ required: ["$ref"] }, { required: ["operator"] }] },
      type: "object",
    },
  ],
  description: "A non-reactive operand: scalar, plain-object literal, or array of operands.",
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
  enum: ["+", "-", "*", "/", "%", "===", "!==", "<", "<=", ">", ">=", "&&", "||", "??"],
} as const;
export const conditionalOperatorSchema = { const: "?:" } as const;
export const switchOperatorSchema = { const: "switch" } as const;
export const callOperatorSchema = { const: "call" } as const;
export const pureMethodSchema = {
  description:
    "A genuine pure String.prototype / Array.prototype / Number.prototype method (spec §19.4d). The ES2023 change-by-copy family (toSorted, toReversed, toSpliced, with) stands in where mutation would otherwise occur. Receiver in target; value carries the argument (bare scalar) or argument list (array).",
  enum: [
    "includes",
    "indexOf",
    "lastIndexOf",
    "join",
    "slice",
    "concat",
    "at",
    "flat",
    "toSorted",
    "toReversed",
    "toSpliced",
    "with",
    "toUpperCase",
    "toLowerCase",
    "trim",
    "trimStart",
    "trimEnd",
    "split",
    "startsWith",
    "endsWith",
    "padStart",
    "padEnd",
    "replaceAll",
    "repeat",
    "charAt",
    "normalize",
    "toLocaleUpperCase",
    "toLocaleLowerCase",
    "toFixed",
    "toPrecision",
    "toLocaleString",
  ],
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
        target: {
          anyOf: [{ $ref: "#/$defs/ExpressionPointer" }, { $ref: "#/$defs/ExpressionNode" }],
        },
        value: { $ref: "#/$defs/ExpressionNode" },
      },
      required: ["operator", "value", "initial"],
      title: "reduce — pure fold over a pointer or derived array; seed in initial",
    },
    {
      not: { required: ["initial"] },
      properties: {
        operator: { $ref: "#/$defs/MapFilterMethod" },
        target: {
          anyOf: [{ $ref: "#/$defs/ExpressionPointer" }, { $ref: "#/$defs/ExpressionNode" }],
        },
        value: { $ref: "#/$defs/ExpressionNode" },
      },
      required: ["operator", "value"],
      title: "map / filter — pure over a pointer or derived array; per-item expression in value",
    },
    {
      description:
        "The ECMAScript conditional (ternary) operator, pure: target is the test, value the consequent, initial the alternate (the reduce precedent for repurposing initial). Chain else-if by nesting another ?: node in initial.",
      properties: { operator: { $ref: "#/$defs/ConditionalOperator" } },
      required: ["operator", "value", "initial"],
      title: "?: — pure conditional; test in target, consequent in value, alternate in initial",
    },
    {
      description:
        "Value-keyed multiway selection, pure: target is the discriminant (matched against case keys by its string form, like element-level $switch), cases maps matched values to result operands, default is the operand when no case matches (result is undefined without it). Condition-chain branching composes from nested ?: nodes instead.",
      not: { anyOf: [{ required: ["value"] }, { required: ["initial"] }] },
      properties: {
        cases: {
          additionalProperties: { $ref: "#/$defs/ExpressionOperand" },
          type: "object",
        },
        default: { $ref: "#/$defs/ExpressionOperand" },
        operator: { $ref: "#/$defs/SwitchOperator" },
      },
      required: ["operator", "cases"],
      title:
        "switch — pure value-keyed selection; discriminant in target, results in cases/default",
    },
    {
      description:
        "A pure standard-library method call: target is the receiver (any operand — never mutated; change-by-copy names replace the mutating originals), value the optional argument (bare scalar) or argument list (array). A missing receiver or method yields undefined, matching null-safe path reads.",
      not: { required: ["initial"] },
      properties: { operator: { $ref: "#/$defs/PureMethod" } },
      required: ["operator"],
      title: "Pure method — genuine prototype methods; receiver in target, args in value",
    },
    {
      description:
        "Invoke a callable, pure in formula position: target is the callee pointer — a named formula entry (#/state/…) or a blessed pure global via window#/ (Math.*, JSON.*, Object.keys/values/entries, and the Intl helpers Intl/formatNumber, Intl/formatDate, Intl/formatRelativeTime) — and value is the positional argument list (the splice args-in-value precedent). Argument order follows the callee's declared parameters.",
      not: { required: ["initial"] },
      properties: {
        operator: { $ref: "#/$defs/CallOperator" },
        target: { $ref: "#/$defs/ExpressionPointer" },
        value: { items: { $ref: "#/$defs/ExpressionOperand" }, type: "array" },
      },
      required: ["operator"],
      title: "call — invoke a named formula or blessed global; callee in target, args in value",
    },
  ],
  properties: {
    cases: {
      additionalProperties: { $ref: "#/$defs/ExpressionOperand" },
      description: "switch only: matched discriminant value (string form) → result operand.",
      type: "object",
    },
    default: {
      $ref: "#/$defs/ExpressionOperand",
      description: "switch only: result operand when no case key matches.",
    },
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
    "A declarative expression entry (Shape 5). Used as a state entry or inline event handler. With parameters it is a named formula: a pure, reusable computation invoked via the call operator, its parameters resolved through $args/<name> refs in the body.",
  properties: {
    $description: { type: "string" },
    $expression: { $ref: "#/$defs/ExpressionNode" },
    $title: { type: "string" },
    parameters: {
      description:
        "Named-formula parameters (CEM convention, as on Function entries): bare names or CEM parameter objects. Present ⇒ the entry is callable, not a computed value.",
      items: { anyOf: [{ type: "string" }, { $ref: "#/$defs/CemParameter" }] },
      type: "array",
    },
  },
  required: ["$expression"],
  type: "object",
} as const;
