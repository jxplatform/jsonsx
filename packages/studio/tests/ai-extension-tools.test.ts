/**
 * The assistant's two verbs over `project.json` `extensions[]`.
 *
 * The assertion that carries this file is that each tool calls its COMMAND — by id and args, not by
 * effect. Asserting the effect would let a tool grow a second implementation of the write and still
 * pass, which is exactly the divergence `specs/studio-ui-guidelines.md` §12.4 catalogues: the human
 * and the agent must share one predicate, not two that agree today.
 */
import { resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { refreshFormats, setExtensionCatalog, setExtensions } from "../src/format/format-host";
import { registerExtensionTools } from "../src/services/ai-extension-tools";
import { setActiveRegistry } from "../src/commands/active-registry";
import { createToolRegistry } from "@jxsuite/ai";
import type { CommandRegistry } from "../src/commands/registry";

type Call = [string, Record<string, unknown> | undefined];

/** A registry that records what it was asked to run, and can be told to refuse. */
function stubRegistry(refuse?: Error): { calls: Call[]; registry: CommandRegistry } {
  const calls: Call[] = [];
  const registry = {
    run: (id: string, args?: Record<string, unknown>) => {
      calls.push([id, args]);
      if (refuse) {
        throw refuse;
      }
    },
  } as unknown as CommandRegistry;
  return { calls, registry };
}

function tools() {
  const registry = createToolRegistry();
  registerExtensionTools(registry);
  return registry;
}

beforeEach(() => {
  refreshFormats();
  setExtensions([]);
  setExtensionCatalog([
    {
      name: "@jxsuite/parser",
      sections: [{ key: "content" }],
      source: "first-party",
      title: "Content & Markdown",
    },
  ]);
  resetStudioState({ projectConfig: { extensions: ["@jxsuite/parser"] } });
});

afterEach(() => {
  // `active-registry.ts` documents this as the unmount contract.
  setActiveRegistry(null);
  refreshFormats();
});

describe("the tools run the human's commands", () => {
  test("enable_extension calls project.enableExtension with the package", async () => {
    const { calls, registry } = stubRegistry();
    setActiveRegistry(registry);
    const result = await tools().execute("enable_extension", { package: "@jxsuite/parser" });
    expect(result.success).toBe(true);
    expect(calls).toEqual([["project.enableExtension", { package: "@jxsuite/parser" }]]);
  });

  test("disable_extension calls project.disableExtension with the package", async () => {
    const { calls, registry } = stubRegistry();
    setActiveRegistry(registry);
    const result = await tools().execute("disable_extension", { package: "@jxsuite/parser" });
    expect(result.success).toBe(true);
    expect(calls).toEqual([["project.disableExtension", { package: "@jxsuite/parser" }]]);
  });
});

describe("a refusal reaches the model as the person's own sentence", () => {
  test("an unavailable command's refusal is passed through verbatim", async () => {
    const refusal =
      'Command "project.enableExtension" is not available right now — it requires an open project.';
    setActiveRegistry(stubRegistry(new Error(refusal)).registry);
    const result = await tools().execute("enable_extension", { package: "@jxsuite/parser" });
    expect(result.success).toBe(false);
    expect(result.error).toBe(refusal);
  });

  test("an argument gate's RangeError is passed through, naming the value", async () => {
    const refusal =
      'command "project.enableExtension" argument "package": "@acme/nope" is not an extension ' +
      "this backend offers and is not installed — offered: @jxsuite/parser";
    setActiveRegistry(stubRegistry(new RangeError(refusal)).registry);
    const result = await tools().execute("enable_extension", { package: "@acme/nope" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("@acme/nope");
    expect(result.error).toContain("offered: @jxsuite/parser");
  });

  test("a window with no registry says so rather than pretending to succeed", async () => {
    setActiveRegistry(null);
    const result = await tools().execute("enable_extension", { package: "@jxsuite/parser" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("no command registry");
  });
});

describe("the tool surface", () => {
  test("both tools require a package argument", async () => {
    setActiveRegistry(stubRegistry().registry);
    for (const name of ["enable_extension", "disable_extension"]) {
      const result = await tools().execute(name, {});
      expect(result.success).toBe(false);
    }
  });

  test("the descriptions carry the ordering rule that prevents a schema error", () => {
    const registry = tools();
    expect(registry.getDefinition("enable_extension")?.description).toContain("BEFORE writing");
    expect(registry.getDefinition("disable_extension")?.description).toContain(
      "Remove any project.json sections it owns first",
    );
  });

  test("the enable summary names the sections the extension made valid", async () => {
    setActiveRegistry(stubRegistry().registry);
    const result = await tools().execute("enable_extension", { package: "@jxsuite/parser" });
    // The result carries what a read tool would otherwise have to be advertised to answer.
    expect(result.summary).toContain("sections are now valid: content");
    expect(result.summary).toContain("Enabled extensions: @jxsuite/parser");
  });

  test("the disable summary says the package is still installed", async () => {
    setActiveRegistry(stubRegistry().registry);
    const result = await tools().execute("disable_extension", { package: "@jxsuite/parser" });
    expect(result.summary).toContain("still installed");
  });
});
