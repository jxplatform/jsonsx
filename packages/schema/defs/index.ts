// Leaf schemas
export { tagNameSchema } from "./tag-name.schema";
export { stringOrRefSchema, boolOrRefSchema, numberOrRefSchema } from "./string-or-ref.schema";
export { headEntrySchema } from "./head-entry.schema";
export { cemParameterSchema, cemEventSchema } from "./cem.schema";
export { imageConfigSchema } from "./image-config.schema";
export { jsonSchemaTypeSchema } from "./json-schema-type.schema";

// Ref schemas
export {
  internalRefSchema,
  stateRefSchema,
  externalRefSchema,
  globalRefSchema,
  parentRefSchema,
  mapRefSchema,
  anyRefSchema,
  refObjectSchema,
  externalComponentRefSchema,
} from "./ref-object.schema";

// Style & element
export { styleObjectSchema } from "./style-object.schema";
export { arrayNamespaceSchema, childrenValueSchema } from "./children-value.schema";
export {
  attributesObjectSchema,
  propsObjectSchema,
  elementPropertyValueSchema,
  switchDefSchema,
  switchNodeSchema,
  elementDefSchema,
} from "./element-def.schema";

// State shapes
export { typedStateDefSchema } from "./typed-state-def.schema";
export { functionDefSchema } from "./function-def.schema";
export { externalClassDefSchema, BUILT_IN_PROTOTYPES } from "./external-class-def.schema";
export { pureTypeDefSchema } from "./pure-type-def.schema";

// Expression system
export {
  expressionPointerSchema,
  expressionLiteralSchema,
  expressionOperandSchema,
  expressionNodeSchema,
  expressionEntrySchema,
  unaryOperatorSchema,
  binaryOperatorSchema,
  assignmentOperatorSchema,
  noArgMethodSchema,
  oneArgMethodSchema,
  spliceMethodSchema,
  reduceMethodSchema,
  mapFilterMethodSchema,
} from "./expression-node.schema";

// State/defs maps
export {
  stateEntrySchema,
  stateMapSchema,
  defsMapSchema,
  typeDefEntrySchema,
} from "./state-entry.schema";

// Class definitions
export {
  classParameterDefSchema,
  classFieldDefSchema,
  classConstructorDefSchema,
  classMethodDefSchema,
  classDefSchema,
  formatDefSchema,
  studioHintsSchema,
} from "./class-def.schema";

// Project
export { projectConfigSchema } from "./project-config.schema";

// Extensions (specs/extensions.md)
export { extensionManifestSchema } from "./extension-manifest.schema";
export { jxFieldSchemaDef, relationshipRefSchema } from "./field-schema.schema";
