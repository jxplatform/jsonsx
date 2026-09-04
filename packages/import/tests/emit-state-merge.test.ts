/**
 * Component `state` must survive emission.
 *
 * `emit.ts` derives placeholder defaults for every `${state.x}` it finds and then wrote them to
 * `compDoc.state` with a plain assignment, over a spread that had already carried the template's
 * OWN declared state. Anything a pass declares — the `active` index a tab group switches on, the
 * `open` index an accordion toggles — was destroyed on the way out, and the interpolations that
 * referenced it were left pointing at nothing.
 *
 * The failure is silent and total: a tab group whose `active` is gone renders every panel with
 * `hidden` truthy, which is exactly the all-panels-frozen defect a semantic pass exists to remove.
 *
 * The second half is the extractor's own capture group. `${state.active !== 0}` is an expression,
 * not a key, and `([^}]+)` happily minted `"active !== 0"` as a state entry beside the real one.
 */

import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { JxElement } from "@jxsuite/schema/types";
import type { ComponentizeResult } from "../src/componentize.ts";
import { emitMultiPageProject } from "../src/emit.ts";
import { createLocalIo } from "../src/io.ts";

function statefulResult(): ComponentizeResult {
  const panel = (index: number): JxElement => ({
    tagName: "div",
    attributes: { role: "tabpanel", hidden: `\${state.active !== ${index}}` },
    children: [{ tagName: "p", textContent: `\${state.label${index}}` }] as JxElement[],
  });

  const template: JxElement = {
    tagName: "div",
    state: { active: 0 } as unknown as Record<string, string>,
    children: [panel(0), panel(1)] as JxElement[],
  };

  return {
    components: new Map([
      ["tab-group.json", { $id: "TabGroup", tagName: "tab-group", template, instanceCount: 2 }],
    ]),
    rewrittenPages: new Map<string, JxElement>([
      ["pages/index.json", { tagName: "div", children: [{ tagName: "tab-group" }] as JxElement[] }],
    ]),
  };
}

async function emitAndRead(): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "jx-import-state-"));
  try {
    await emitMultiPageProject({
      io: createLocalIo(dir),
      title: "State Test",
      sourceUrl: "https://example.com",
      pages: new Map<string, JxElement>(),
      precomputedComponents: statefulResult(),
    } as Parameters<typeof emitMultiPageProject>[0]);
    const raw = await readFile(join(dir, "components", "tab-group.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("component state survives emission", () => {
  test("declared state is kept, not overwritten by derived defaults", async () => {
    const doc = await emitAndRead();
    const state = doc["state"] as Record<string, unknown>;

    expect(state).toBeDefined();
    // The declared value, not a placeholder "".
    expect(state["active"]).toBe(0);
  });

  test("derived placeholders still fill in for genuinely undeclared props", async () => {
    const doc = await emitAndRead();
    const state = doc["state"] as Record<string, unknown>;

    expect(state["label0"]).toBe("");
    expect(state["label1"]).toBe("");
  });

  test("an interpolated expression never becomes a state key", async () => {
    const doc = await emitAndRead();
    const state = doc["state"] as Record<string, unknown>;

    for (const key of Object.keys(state)) {
      expect(key).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    }
    expect(state["active !== 0"]).toBeUndefined();
    expect(state["active !== 1"]).toBeUndefined();
  });
});
