/**
 * Validate — hand-rolled row validation and form-value coercion (plan Part 4a "validate.ts"; ajv is
 * new Function and therefore Workers-forbidden).
 */

import { describe, expect, test } from "bun:test";
import { validateRow } from "../src/validate";
import type { TableDef } from "../src/types";

const TABLE: TableDef = {
  connection: "main",
  schema: {
    properties: {
      approved: { type: "boolean" },
      author: { $ref: "#/data/users" },
      message: { type: "string" },
      meta: { type: "object" },
      mood: { enum: ["happy", "sad"], type: "string" },
      rating: { type: "number" },
      tags: { items: { $ref: "#/content/tags" }, type: "array" },
      views: { type: "integer" },
    },
    required: ["message"],
    type: "object",
  },
};

describe("validateRow", () => {
  test("accepts a fully-typed row", () => {
    const result = validateRow(TABLE, {
      approved: true,
      message: "hello",
      meta: { a: 1 },
      mood: "happy",
      rating: 4.5,
      views: 3,
    });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({
      approved: true,
      message: "hello",
      meta: { a: 1 },
      mood: "happy",
      rating: 4.5,
      views: 3,
    });
  });

  test("coerces form-shaped string values to their column types", () => {
    const result = validateRow(TABLE, {
      approved: "on",
      message: "hi",
      rating: "4.5",
      views: "12",
    });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ approved: true, message: "hi", rating: 4.5, views: 12 });
  });

  test("rejects non-object bodies", () => {
    expect(validateRow(TABLE, null).valid).toBe(false);
    expect(validateRow(TABLE, [1]).valid).toBe(false);
    expect(validateRow(TABLE, "x").errors[0]!.message).toContain("JSON object");
  });

  test("rejects unknown and read-only fields", () => {
    const result = validateRow(TABLE, { id: "x", message: "hi", nope: 1, updated_at: "y" });
    expect(result.valid).toBe(false);
    const fields = result.errors.map((e) => e.field).toSorted();
    expect(fields).toEqual(["id", "nope", "updated_at"]);
  });

  test("enforces required fields on full validation only", () => {
    const full = validateRow(TABLE, {});
    expect(full.valid).toBe(false);
    expect(full.errors[0]).toEqual({ field: "message", message: "Required field is missing" });
    const partial = validateRow(TABLE, {}, { partial: true });
    expect(partial.valid).toBe(true);
  });

  test("type mismatches name the expected type", () => {
    const result = validateRow(TABLE, { message: 42, rating: "abc", views: 1.5 });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      { field: "message", message: "Expected string" },
      { field: "rating", message: "Expected number" },
      { field: "views", message: "Expected integer" },
    ]);
  });

  test("boolean coercion accepts the form vocabulary and rejects junk", () => {
    expect(validateRow(TABLE, { approved: "false", message: "x" }).value.approved).toBe(false);
    expect(validateRow(TABLE, { approved: "1", message: "x" }).value.approved).toBe(true);
    expect(validateRow(TABLE, { approved: "maybe", message: "x" }).valid).toBe(false);
  });

  test("enum membership is enforced after coercion", () => {
    expect(validateRow(TABLE, { message: "x", mood: "happy" }).valid).toBe(true);
    expect(validateRow(TABLE, { message: "x", mood: "angry" }).valid).toBe(false);
  });

  test("reference fields must be id strings; lists must be string arrays", () => {
    expect(validateRow(TABLE, { author: "u1", message: "x" }).valid).toBe(true);
    expect(validateRow(TABLE, { author: 7, message: "x" }).valid).toBe(false);
    expect(validateRow(TABLE, { message: "x", tags: ["a", "b"] }).valid).toBe(true);
    expect(validateRow(TABLE, { message: "x", tags: ["a", 3] }).valid).toBe(false);
    expect(validateRow(TABLE, { message: "x", tags: '["a","b"]' }).value.tags).toEqual(["a", "b"]);
  });

  test("json-looking strings coerce for array/object columns", () => {
    const result = validateRow(TABLE, { message: "x", meta: '{"k":1}' });
    expect(result.valid).toBe(true);
    expect(result.value.meta).toEqual({ k: 1 });
    expect(validateRow(TABLE, { message: "x", meta: "{broken" }).valid).toBe(false);
  });

  test("null clears a column", () => {
    const result = validateRow(TABLE, { mood: null }, { partial: true });
    expect(result.valid).toBe(true);
    expect(result.value.mood).toBeNull();
  });
});
