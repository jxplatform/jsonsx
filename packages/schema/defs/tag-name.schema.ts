export const tagNameSchema = {
  description:
    "HTML element tag name or custom element name (must contain a hyphen per Web Components spec).",
  minLength: 1,
  type: "string",
} as const;
