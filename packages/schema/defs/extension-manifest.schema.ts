/**
 * Jx-extension.json manifest schema (specs/extensions.md §4). The manifest is pure data: it
 * enumerates an extension package's classes and schema fragments; behavior lives in the class
 * descriptors it points to.
 */

export const extensionManifestSchema = {
  additionalProperties: false,
  description:
    "Schema for jx-extension.json manifests. Located at the extension package root and " +
    "exported so hosts can resolve <package>/jx-extension.json through the exports map.",
  properties: {
    $schema: { type: "string" },
    classes: {
      additionalProperties: { type: "string" },
      description:
        "$prototype-visible class name → class descriptor path, relative to the manifest.",
      type: "object",
    },
    description: { description: "One-line description.", type: "string" },
    name: { description: "Package name; must match package.json.", type: "string" },
    schemas: {
      additionalProperties: false,
      description: "Schema fragments this package contributes, relative to the manifest.",
      properties: {
        document: {
          description: "Document-schema fragment (positions like $paths values).",
          type: "string",
        },
        project: {
          description: "Project-schema fragment (top-level project.json sections).",
          type: "string",
        },
      },
      type: "object",
    },
    title: { description: "Human-readable name for studio surfaces.", type: "string" },
  },
  required: ["name"],
  type: "object",
} as const;
