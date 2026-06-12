/**
 * Studio shell (C7): ?project= resolving to project.json with no home page available — studio.ts
 * falls back to opening project.json itself in stylebook mode.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { bootStudio, statusMessages, waitFor } from "./studio-shell-fixture";
import { activeTab } from "../src/workspace/workspace";

const SITE = "/abs/empty-site";

await bootStudio({
  overrides: {
    resolveSiteContext: (async () => ({
      fileRelPath: "project.json",
      projectConfig: { name: "EmptySite" },
      sitePath: SITE,
    })) as any,
  },
  seedFiles: {
    "project.json": JSON.stringify({ name: "EmptySite" }),
  },
  url: `http://localhost/?project=${SITE}`,
});

await waitFor(() => statusMessages.includes("Opened project.json"));

describe("?project= with no home page", () => {
  test("opens project.json itself when no pages/index.* candidate exists", () => {
    expect(statusMessages).toContain("Opened project.json");
    expect(activeTab.value?.id).toBe("project.json");
    expect((activeTab.value!.doc.document as any).name).toBe("EmptySite");
  });

  test("defaults the canvas to stylebook mode for project.json", () => {
    expect(activeTab.value?.session.ui.canvasMode).toBe("stylebook");
  });
});
