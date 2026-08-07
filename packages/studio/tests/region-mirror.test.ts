/**
 * `scripts/screenshots/lib/shot.ts` mirrors `src/ui/regions.ts` BY HAND.
 *
 * It has to: `page.evaluate` ships a function's own source into the browser and cannot carry its
 * imports, so the shot runner carries a second copy of region resolution. Its docstring says "the
 * app remains the authority, and an id that only this copy would resolve is a bug in this copy" —
 * and then the inverse happened. A derived resolver for `inspector/field:<prop>/browse` was added
 * to the app, the mirror never got it, and because `(.+)` is greedy the mirror's bare-field rule
 * claimed `image/browse` as a prop of that name and answered nothing. One shot went red, and the
 * only reason it was noticed is that the shot lane happened to run.
 *
 * A docstring is not a guard. This is: both implementations resolve the same corpus of ids against
 * the same DOM, and must agree element-for-element.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRegion, stampShellRegions } from "../src/ui/regions";

/** The mirror, lifted out of `shot.ts` by reading its source — so the test cannot drift from it. */
function mirrorResolver(): (id: string) => HTMLElement | null {
  const src = readFileSync(
    join(import.meta.dir, "../../../scripts/screenshots/lib/shot.ts"),
    "utf8",
  );
  const start = src.indexOf('  const ATTR = "data-jx-region";');
  const end = src.indexOf("  // Last match wins", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end).replaceAll("<HTMLElement>", "").replaceAll("!", "");
  // eslint-disable-next-line no-new-func
  return new Function("id", `${body}\nreturn matches.at(-1) ?? null;`) as (
    id: string,
  ) => HTMLElement | null;
}

function build(): void {
  document.body.innerHTML = `
    <div id="app">
      <div id="toolbar"></div>
      <div id="pane-grid"></div>
      <div id="activity-bar"></div>
      <div id="left-panel"></div>
      <div id="right-panel">
        <div class="kv-row" data-prop="image">
          <sp-action-button class="media-picker-browse"></sp-action-button>
        </div>
        <div class="kv-row" data-prop="og:image">
          <sp-action-button class="media-picker-browse"></sp-action-button>
        </div>
        <div class="kv-row" data-prop="href"></div>
      </div>
      <div id="statusbar"></div>
    </div>`;
  stampShellRegions();
}

/** Every id shape the two copies both claim to answer, including the ones that must answer null. */
const CORPUS = [
  "inspector",
  "inspector/field:image",
  "inspector/field:og:image",
  "inspector/field:href",
  "inspector/field:image/browse",
  "inspector/field:og:image/browse",
  "inspector/field:href/browse",
  "inspector/field:missing",
  "inspector/field:missing/browse",
  "commandbar",
  "statusbar",
  "navigator",
  "pane",
  "pane/tabs",
  "nonsense",
];

describe("the shot runner's region mirror", () => {
  test("resolves every id to the same element the app does", () => {
    build();
    const mirror = mirrorResolver();
    const disagreements: string[] = [];
    for (const id of CORPUS) {
      const mine = resolveRegion(id);
      const theirs = mirror(id);
      if (mine !== theirs) {
        disagreements.push(
          `${id}: app=${mine?.dataset.prop ?? mine?.className ?? mine?.id ?? "null"} ` +
            `mirror=${theirs?.dataset.prop ?? theirs?.className ?? theirs?.id ?? "null"}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("and the derived browse id is one of them, not a coincidence", () => {
    build();
    const mirror = mirrorResolver();
    // The id the mirror used to miss. Both must reach the BUTTON, not the row.
    expect(resolveRegion("inspector/field:image/browse")?.className).toBe("media-picker-browse");
    expect(mirror("inspector/field:image/browse")?.className).toBe("media-picker-browse");
    // A prop with no picker answers null on both sides rather than falling back to the row.
    expect(resolveRegion("inspector/field:href/browse")).toBeNull();
    expect(mirror("inspector/field:href/browse")).toBeNull();
  });
});
