/**
 * Tests for src/style/live-preview.ts — the one call every project-style writer makes.
 *
 * The defect it exists to close: `postSiteStyleToLiveHosts` skips stylebook hosts by construction,
 * so a token edited in the token editor reached every page canvas and left the Project Styles
 * canvas — the one the plan puts beside the editor — showing the previous palette. Two hosts, two
 * messages, one event.
 */
import "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const siteCalls: number[] = [];
const stylebookCalls: Record<string, unknown>[] = [];

void mock.module("../src/canvas/iframe-host", () => ({
  postSiteStyleToLiveHosts: () => {
    siteCalls.push(stylebookCalls.length);
  },
  postStyleUpdateToStylebookHosts: (style: Record<string, unknown>) => {
    stylebookCalls.push(style);
    return 0;
  },
}));

const { pushProjectStylesToCanvas } = await import("../src/style/live-preview");
const { resetStudioState, resetWorkspaceWithTab } = await import("./harness");
const { closeAllTabs } = await import("../src/workspace/workspace");

beforeEach(() => {
  siteCalls.length = 0;
  stylebookCalls.length = 0;
});

afterEach(() => {
  closeAllTabs();
});

describe("pushProjectStylesToCanvas", () => {
  test("both host kinds are told, in one call", () => {
    resetStudioState({ projectConfig: { style: { "--color-primary": "#007acc" } } as unknown });
    pushProjectStylesToCanvas();
    expect(siteCalls).toHaveLength(1);
    expect(stylebookCalls).toHaveLength(1);
    // The tokens ride at the top of the transposed root so they inherit into every specimen.
    expect(stylebookCalls[0]!["--color-primary"]).toBe("#007acc");
  });

  test("with no tab open the project's own style is what the specimen canvas gets", () => {
    resetStudioState({ projectConfig: { style: { "& h1": { color: "red" } } } as unknown });
    pushProjectStylesToCanvas();
    expect(Object.keys(stylebookCalls[0]!).some((k) => k.includes("h1"))).toBe(true);
  });

  test("the open document's own element defaults are not dropped on the way through", () => {
    /* The stylebook canvas renders the EFFECTIVE style. Posting the site style alone would blank a
       component's own `& <tag>` defaults out of the specimen until the next full render. */
    resetStudioState({ projectConfig: { style: { "--color-primary": "#007acc" } } as unknown });
    resetWorkspaceWithTab({
      children: [],
      style: { "& h2": { color: "rebeccapurple" } },
      tagName: "div",
    } as never);
    pushProjectStylesToCanvas();
    const posted = JSON.stringify(stylebookCalls.at(-1));
    expect(posted).toContain("rebeccapurple");
    expect(posted).toContain("#007acc");
  });
});
