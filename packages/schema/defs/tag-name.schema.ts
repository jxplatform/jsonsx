export const tagNameSchema = {
  description:
    "HTML element tag name or custom element name (must contain a hyphen per Web Components spec).",
  type: "string",
  minLength: 1,
} as const;
