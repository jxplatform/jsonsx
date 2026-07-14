/**
 * Tests for src/services/gated-registry.ts — state-aware tool advertisement.
 *
 * The wrapper filters list()/listForLLM() by live availability predicates and refuses execute() of
 * gated-off tools with an actionable error, while tools without an entry pass through untouched.
 * Predicates are re-evaluated per call, so flipping state between rounds re-advertises (the
 * mid-loop create_project unlock).
 */
import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { createToolRegistry, createToolDefinition } from "@jxsuite/ai";
import { createGatedToolRegistry } from "../src/services/gated-registry";
import type { ToolAvailability } from "../src/services/gated-registry";

function tool(name: string) {
  return createToolDefinition({
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, required: [] },
    execute: () => ({ success: true, summary: `${name} ran` }),
  });
}

function llmNames(registry: ReturnType<typeof createGatedToolRegistry>): string[] {
  return registry
    .listForLLM()
    .map((t) => (t as { function: { name: string } }).function.name)
    .toSorted();
}

function makeGated(flags: { project: boolean }) {
  const inner = createToolRegistry();
  inner.register(tool("create_project"));
  inner.register(tool("list_files"));
  inner.register(tool("always_on"));
  const availability = new Map<string, ToolAvailability>([
    ["create_project", { requires: "no project to be open", when: () => !flags.project }],
    ["list_files", { requires: "an open project", when: () => flags.project }],
  ]);
  return { inner, registry: createGatedToolRegistry(inner, availability) };
}

describe("gated-registry", () => {
  test("list and listForLLM filter by the live predicate; unlisted tools always show", () => {
    const flags = { project: false };
    const { registry } = makeGated(flags);

    expect(
      registry
        .list()
        .map((t) => t.name)
        .toSorted(),
    ).toEqual(["always_on", "create_project"]);
    expect(llmNames(registry)).toEqual(["always_on", "create_project"]);

    // Flipping state between calls re-advertises without re-registering anything.
    flags.project = true;
    expect(llmNames(registry)).toEqual(["always_on", "list_files"]);
  });

  test("executing a gated-off tool refuses with the requirement; available tools run", async () => {
    const flags = { project: false };
    const { registry } = makeGated(flags);

    const refused = await registry.execute("list_files", {});
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("list_files");
    expect(refused.error).toContain("an open project");

    const ran = await registry.execute("create_project", {});
    expect(ran.success).toBe(true);

    flags.project = true;
    const nowRuns = await registry.execute("list_files", {});
    expect(nowRuns.success).toBe(true);
  });

  test("unknown tools fall through to the inner registry's error", async () => {
    const { registry } = makeGated({ project: false });
    const res = await registry.execute("nope", {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unknown tool: "nope"');
  });

  test("register, validate, and getDefinition pass through to the inner registry", () => {
    const { inner, registry } = makeGated({ project: true });
    registry.register(tool("late_tool"));
    expect(inner.getDefinition("late_tool")).toBeDefined();
    expect(registry.getDefinition("list_files")?.name).toBe("list_files");
    expect(registry.validate("list_files", {}).valid).toBe(true);
    expect(registry.validate("nope", {}).valid).toBe(false);
  });
});
