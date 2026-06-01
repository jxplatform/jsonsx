export const attributesObjectSchema = {
  description: "HTML attributes and ARIA attributes set via element.setAttribute().",
  type: "object",
  additionalProperties: {
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { $ref: "#/$defs/RefObject" },
    ],
  },
} as const;

export const propsObjectSchema = {
  description: "Explicit prop passing at a component boundary.",
  type: "object",
  additionalProperties: {
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "array" },
      { type: "object" },
      { $ref: "#/$defs/RefObject" },
    ],
  },
} as const;

export const elementPropertyValueSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { $ref: "#/$defs/RefObject" },
  ],
} as const;

export const switchDefSchema = {
  description: "Reactive $ref that drives which case to render.",
  type: "object",
  required: ["$ref"],
  properties: { $ref: { $ref: "#/$defs/InternalRef" } },
  additionalProperties: false,
} as const;

export const switchNodeSchema = {
  type: "object",
  required: ["$switch", "cases"],
  properties: {
    tagName: { $ref: "#/$defs/TagName" },
    $switch: { $ref: "#/$defs/SwitchDef" },
    cases: {
      type: "object",
      additionalProperties: {
        oneOf: [{ $ref: "#/$defs/ElementDef" }, { $ref: "#/$defs/ExternalComponentRef" }],
      },
    },
  },
} as const;

export const elementDefSchema = {
  description: "A Jx element definition. Maps directly to a DOM element.",
  type: "object",
  required: ["tagName"],
  properties: {
    tagName: { $ref: "#/$defs/TagName" },
    id: { type: "string" },
    className: { $ref: "#/$defs/StringOrRef" },
    textContent: { $ref: "#/$defs/StringOrRef" },
    innerHTML: { $ref: "#/$defs/StringOrRef" },
    innerText: { $ref: "#/$defs/StringOrRef" },
    hidden: { $ref: "#/$defs/BoolOrRef" },
    tabIndex: { $ref: "#/$defs/NumberOrRef" },
    title: { $ref: "#/$defs/StringOrRef" },
    lang: { $ref: "#/$defs/StringOrRef" },
    dir: { type: "string", enum: ["ltr", "rtl", "auto"] },
    value: { $ref: "#/$defs/StringOrRef" },
    checked: { $ref: "#/$defs/BoolOrRef" },
    disabled: { $ref: "#/$defs/BoolOrRef" },
    selected: { $ref: "#/$defs/BoolOrRef" },
    src: { $ref: "#/$defs/StringOrRef" },
    href: { $ref: "#/$defs/StringOrRef" },
    alt: { $ref: "#/$defs/StringOrRef" },
    type: { $ref: "#/$defs/StringOrRef" },
    name: { $ref: "#/$defs/StringOrRef" },
    placeholder: { $ref: "#/$defs/StringOrRef" },
    children: { $ref: "#/$defs/ChildrenValue" },
    style: { $ref: "#/$defs/StyleObject" },
    attributes: { $ref: "#/$defs/AttributesObject" },
    $switch: { $ref: "#/$defs/SwitchDef" },
    $ref: { $ref: "#/$defs/ExternalRef" },
    $props: { $ref: "#/$defs/PropsObject" },
    "$map/item": { $ref: "#/$defs/RefObject" },
    "$map/index": { $ref: "#/$defs/RefObject" },
  },
  additionalProperties: { $ref: "#/$defs/ElementPropertyValue" },
} as const;
