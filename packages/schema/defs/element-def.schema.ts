export const attributesObjectSchema = {
  additionalProperties: {
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { $ref: "#/$defs/RefObject" },
    ],
  },
  description: "HTML attributes and ARIA attributes set via element.setAttribute().",
  type: "object",
} as const;

export const propsObjectSchema = {
  // AnyOf, not oneOf: a RefObject value legitimately matches both the plain-object branch and
  // The RefObject branch, and exclusive matching would reject every $ref-bound prop.
  additionalProperties: {
    anyOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "array" },
      { type: "object" },
      { $ref: "#/$defs/RefObject" },
    ],
  },
  description: "Explicit prop passing at a component boundary.",
  type: "object",
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
  additionalProperties: false,
  description: "Reactive $ref that drives which case to render.",
  // The discriminant is a reactive state path (e.g. "#/state/currentRoute") resolved by
  // ResolveRef at render time — not a #/$defs/ type pointer.
  properties: { $ref: { $ref: "#/$defs/StateRef" } },
  required: ["$ref"],
  type: "object",
} as const;

export const switchNodeSchema = {
  properties: {
    $switch: { $ref: "#/$defs/SwitchDef" },
    cases: {
      additionalProperties: {
        oneOf: [{ $ref: "#/$defs/ElementDef" }, { $ref: "#/$defs/ExternalComponentRef" }],
      },
      type: "object",
    },
    tagName: { $ref: "#/$defs/TagName" },
  },
  required: ["$switch", "cases"],
  type: "object",
} as const;

export const elementDefSchema = {
  additionalProperties: { $ref: "#/$defs/ElementPropertyValue" },
  description: "A Jx element definition. Maps directly to a DOM element.",
  properties: {
    "$map/index": { $ref: "#/$defs/RefObject" },
    "$map/item": { $ref: "#/$defs/RefObject" },
    $props: { $ref: "#/$defs/PropsObject" },
    $ref: { $ref: "#/$defs/ExternalRef" },
    $switch: { $ref: "#/$defs/SwitchDef" },
    alt: { $ref: "#/$defs/StringOrRef" },
    attributes: { $ref: "#/$defs/AttributesObject" },
    cases: {
      additionalProperties: {
        oneOf: [{ $ref: "#/$defs/ElementDef" }, { $ref: "#/$defs/ExternalComponentRef" }],
      },
      description:
        "Switch cases for this element. Maps case values to element definitions or external " +
        "component refs, rendered according to the reactive $switch discriminant.",
      type: "object",
    },
    checked: { $ref: "#/$defs/BoolOrRef" },
    children: { $ref: "#/$defs/ChildrenValue" },
    className: { $ref: "#/$defs/StringOrRef" },
    dir: { enum: ["ltr", "rtl", "auto"], type: "string" },
    disabled: { $ref: "#/$defs/BoolOrRef" },
    hidden: { $ref: "#/$defs/BoolOrRef" },
    href: { $ref: "#/$defs/StringOrRef" },
    id: { type: "string" },
    innerHTML: { $ref: "#/$defs/StringOrRef" },
    innerText: { $ref: "#/$defs/StringOrRef" },
    lang: { $ref: "#/$defs/StringOrRef" },
    name: { $ref: "#/$defs/StringOrRef" },
    placeholder: { $ref: "#/$defs/StringOrRef" },
    selected: { $ref: "#/$defs/BoolOrRef" },
    src: { $ref: "#/$defs/StringOrRef" },
    style: { $ref: "#/$defs/StyleObject" },
    tabIndex: { $ref: "#/$defs/NumberOrRef" },
    tagName: { $ref: "#/$defs/ElementTagName" },
    textContent: { $ref: "#/$defs/StringOrRef" },
    title: { $ref: "#/$defs/StringOrRef" },
    type: { $ref: "#/$defs/StringOrRef" },
    value: { $ref: "#/$defs/StringOrRef" },
  },
  required: ["tagName"],
  type: "object",
} as const;
