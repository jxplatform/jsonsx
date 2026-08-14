/**
 * Tests for the non-JSON half of `seedText` in src/content/entry-commands.ts — a collection whose
 * entries are written by a format class, and the two ways that can fail.
 *
 * Separate from `entry-commands.test.ts` because it needs the format registry to ANSWER, and the
 * answer decides both the extension the creation field appends and the serializer the seeded body
 * goes through.
 */
import { resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const created: Record<string, unknown>[] = [];
const notifications: { message: string; detail?: string }[] = [];
let format: { extensions: string[]; name: string } | undefined = {
  extensions: [".md"],
  name: "Markdown",
};
let serializeFails = false;
const serialized: { name: string; doc: Record<string, unknown> }[] = [];

void mock.module("../src/format/format-host", () => ({
  defaultContentFormat: () => format,
  formatByName: (name?: string | null) => (name === "Markdown" ? format : undefined),
  formatForPath: () => format,
  formatSerialize: (name: string, doc: Record<string, unknown>) => {
    if (serializeFails) {
      return Promise.reject(new Error("serializer offline"));
    }
    serialized.push({ doc, name });
    return Promise.resolve(`---\n${Object.keys(doc).join(",")}\n---\n`);
  },
  loadFormats: () => Promise.resolve([]),
}));

void mock.module("../src/services/notify", () => ({
  notify: {
    error: (message: string, options?: { detail?: string }) =>
      notifications.push({
        message,
        ...(options?.detail === undefined ? {} : { detail: options.detail }),
      }),
    info: () => {},
    success: () => {},
    warn: () => {},
  },
}));

void mock.module("../src/files/files", () => ({
  createFileIn: (request: Record<string, unknown>) => {
    created.push(request);
    return Promise.resolve(null); // Cancelled: this file is about what was PREPARED.
  },
  openFileInTab: () => Promise.resolve(),
}));

const { createEntry } = await import("../src/content/entry-commands");

beforeEach(() => {
  created.length = 0;
  notifications.length = 0;
  serialized.length = 0;
  serializeFails = false;
  format = { extensions: [".md"], name: "Markdown" };
  resetStudioState({
    projectConfig: {
      content: {
        blog: {
          format: "Markdown",
          schema: {
            properties: { draft: { default: false, type: "boolean" }, title: { type: "string" } },
            required: ["title"],
          },
          source: "./content/blog/",
        },
      },
    },
  });
});

describe("a format-class collection", () => {
  test("takes its extension from the format and serializes the seed through it", async () => {
    await createEntry("blog");
    expect(created[0]?.ext).toBe(".md");
    expect(serialized[0]?.name).toBe("Markdown");
    // The seed IS the frontmatter; `children` is the empty body the format needs to round-trip.
    expect(serialized[0]?.doc).toEqual({ children: [], draft: false, title: "" });
    expect(created[0]?.content).toContain("title");
  });

  test("no format class at all means a .json entry, serialized natively", async () => {
    format = undefined;
    resetStudioState({
      projectConfig: {
        content: { blog: { format: "Nope", schema: {}, source: "./content/blog/" } },
      },
    });
    await createEntry("blog");
    // The extension and the serializer come off the same lookups: no format class means `.json`,
    // And `.json` is native. There is no state where a Markdown file gets a JSON body.
    expect(created[0]?.ext).toBe(".json");
    expect(serialized).toHaveLength(0);
    expect(created[0]?.content).toBe("{}");
  });

  test("a serializer that throws is reported against the collection's directory", async () => {
    serializeFails = true;
    expect(await createEntry("blog")).toBeNull();
    expect(created).toHaveLength(0);
    expect(notifications[0]?.message).toContain("Could not prepare a new blog entry");
    expect(notifications[0]?.detail).toContain("serializer offline");
  });
});
