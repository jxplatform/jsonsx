/**
 * Tests for src/services/project-adoption.ts — the late-bound project-open slot the AI
 * create_project tool uses to open freshly scaffolded projects.
 */
import "./with-dom.ts";
import { describe, expect, mock, test } from "bun:test";
import { adoptProject, setProjectAdopter } from "../src/services/project-adoption";

describe("project-adoption", () => {
  test("adoptProject throws an actionable error while no adopter is registered", () => {
    expect(adoptProject("/somewhere")).rejects.toThrow("adoption is not available");
  });

  test("adoptProject delegates to the registered adopter", async () => {
    const adopter = mock(async (_root: string) => {});
    setProjectAdopter(adopter);
    await adoptProject("/projects/new-site");
    expect(adopter).toHaveBeenCalledWith("/projects/new-site");
  });

  test("adopter failures propagate to the caller", () => {
    setProjectAdopter(async () => {
      throw new Error("disk on fire");
    });
    expect(adoptProject("/x")).rejects.toThrow("disk on fire");
  });
});
