/**
 * The three verbs over `project.json` `extensions[]`.
 *
 * Two properties carry the file. First, §12.4's rule that a family over one piece of state declares
 * ONE availability rule — asserted over a context matrix rather than by reading three records and
 * hoping. Second, that every argument-dependent refusal NAMES the value and says what to do, which
 * is what makes the same refusal readable to a person in the palette and to the agent in a tool
 * result.
 */
import { installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext } from "../src/commands/context";
import { extensionCommands, extensionOpInFlight } from "../src/settings/extension-commands";
import { refreshFormats, setExtensionCatalog, setExtensions } from "../src/format/format-host";
import type { CommandContext } from "../src/commands/context";
import type { ExtensionCatalogEntry } from "../src/types";

const IDS = ["project.enableExtension", "project.disableExtension", "packages.remove"] as const;

const PARSER: ExtensionCatalogEntry = {
  installed: false,
  name: "@jxsuite/parser",
  sections: [{ key: "content" }],
  source: "first-party",
  title: "Content & Markdown",
};

function registryWith(open: boolean) {
  const base = emptyContext();
  const context = (): CommandContext => ({ ...base, project: { ...base.project, open } });
  const registry = createCommandRegistry({ getContext: context });
  registry.registerAll(extensionCommands());
  return registry;
}

beforeEach(() => {
  resetWorkspaceWithTab();
  refreshFormats();
  installMockPlatform();
  setExtensionCatalog([PARSER]);
  setExtensions([]);
});

afterEach(() => {
  refreshFormats();
});

describe("one availability rule across the family (§12.4)", () => {
  test("all three agree in every context", () => {
    /*
     * The disagreement §12.4 catalogues is always the same shape: the loose member is the one that
     * writes. All three of these write, so a matrix is the honest test — reading the records and
     * eyeballing them is what let six other families drift.
     */
    for (const open of [true, false]) {
      const registry = registryWith(open);
      const answers = IDS.map((id) => registry.isEnabled(id));
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toBe(open);
    }
  });

  test("each refuses with the same sentence a disabled control would print", () => {
    const registry = registryWith(false);
    for (const id of IDS) {
      expect(registry.disabledReason(id)).toBe("an open project");
      expect(registry.refusalMessage(id)).toContain("requires an open project");
    }
  });

  test("every record registers cleanly and is palette-placed", () => {
    const registry = registryWith(true);
    for (const id of IDS) {
      expect(registry.get(id)?.menus).toEqual(["palette"]);
      // A verb that is useless without an argument does not earn chrome, and a chord for
      // "enable WHICH extension?" would be meaningless.
      expect(registry.get(id)?.keybinding).toBeUndefined();
    }
  });

  test("the undo scopes tell the truth about what can be taken back", () => {
    const registry = registryWith(true);
    // Enabling installs, and an install is not a transaction — claiming `project` would promise a
    // ⌘Z that leaves the package on disk.
    expect(registry.get("project.enableExtension")?.undo).toBe("none");
    // Disabling is a pure project.json transaction.
    expect(registry.get("project.disableExtension")?.undo).toBe("project");
    expect(registry.get("packages.remove")?.undo).toBe("none");
  });

  test("only the two verbs the agent can judge carry an aiTool", () => {
    const registry = registryWith(true);
    expect(registry.get("project.enableExtension")?.aiTool?.name).toBe("enable_extension");
    expect(registry.get("project.disableExtension")?.aiTool?.name).toBe("disable_extension");
    // The model has no read that tells it whether a dependency is load-bearing elsewhere, and the
    // Act is destructive and not undoable.
    expect(registry.get("packages.remove")?.aiTool).toBeUndefined();
    expect(registry.get("packages.remove")?.destructive).toBe(true);
  });
});

describe("argument refusals name the value (§12.4)", () => {
  test("an unknown package is refused, and the message lists what is offered", async () => {
    resetStudioState({ projectConfig: { extensions: [] } });
    const registry = registryWith(true);
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(
      registry.run("project.enableExtension", { package: "@acme/nope" }),
    ).rejects.toThrow(/"@acme\/nope" is not an extension this backend offers/);
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(
      registry.run("project.enableExtension", { package: "@acme/nope" }),
    ).rejects.toThrow(/offered: @jxsuite\/parser/);
  });

  test("an extension this backend cannot run is refused with the backend's own sentence", async () => {
    resetStudioState({ projectConfig: { extensions: [] } });
    setExtensionCatalog([{ ...PARSER, problem: "this Worker bundles no parser" }]);
    const registry = registryWith(true);
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(
      registry.run("project.enableExtension", { package: "@jxsuite/parser" }),
    ).rejects.toThrow(/this Worker bundles no parser/);
  });

  test("removing a package that is still enabled is refused, and says to disable it first", async () => {
    resetStudioState({ projectConfig: { extensions: ["@jxsuite/parser"] } });
    const registry = registryWith(true);
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(registry.run("packages.remove", { package: "@jxsuite/parser" })).rejects.toThrow(
      /still enabled in project\.json "extensions" — disable it first/,
    );
  });
});

describe("the verbs are idempotent", () => {
  test("enabling an already-enabled extension writes nothing", async () => {
    resetStudioState({ projectConfig: { extensions: ["@jxsuite/parser"] } });
    const { state } = installMockPlatform();
    const registry = registryWith(true);
    await registry.run("project.enableExtension", { package: "@jxsuite/parser" });
    expect(state.calls.some(([name]) => name === "addPackage")).toBe(false);
    expect(state.calls.some(([name]) => name === "writeFile")).toBe(false);
  });

  test("disabling an extension the project does not have writes nothing", async () => {
    resetStudioState({ projectConfig: { extensions: [] } });
    const { state } = installMockPlatform();
    const registry = registryWith(true);
    await registry.run("project.disableExtension", { package: "@jxsuite/parser" });
    expect(state.calls.some(([name]) => name === "writeFile")).toBe(false);
  });
});

describe("the choice lists are derived, not snapshotted", () => {
  test("enable offers nothing before a project and the catalogue after it", () => {
    /*
     * `derivedEnumProperty`, not `enumProperty`. The records are built at module scope in
     * app-commands.ts, before any project is open, so a snapshot would freeze both lists at [] for
     * the life of the window and the palette would offer an empty choice forever.
     */
    setExtensionCatalog([]);
    resetStudioState({ projectConfig: {} });
    const registry = registryWith(true);
    const schema = registry.get("project.enableExtension")?.args as {
      properties: { package: { enum: string[] } };
    };
    expect(schema.properties.package.enum).toEqual([]);

    setExtensionCatalog([PARSER]);
    expect(schema.properties.package.enum).toEqual(["@jxsuite/parser"]);
  });

  test("disable offers exactly what project.json names", () => {
    resetStudioState({ projectConfig: { extensions: ["@acme/one", "@acme/two"] } });
    const registry = registryWith(true);
    const schema = registry.get("project.disableExtension")?.args as {
      properties: { package: { enum: string[] } };
    };
    expect(schema.properties.package.enum).toEqual(["@acme/one", "@acme/two"]);
  });
});

describe("one operation at a time", () => {
  test("the latch is clear when nothing is running", () => {
    expect(extensionOpInFlight()).toBeNull();
  });

  test("enabling is refused while another operation runs", async () => {
    resetStudioState({ projectConfig: { extensions: [] } });
    let release: (() => void) | undefined;
    installMockPlatform({
      addPackage: () =>
        new Promise<void>((r) => {
          release = r;
        }) as Promise<unknown>,
    });
    setExtensionCatalog([PARSER, { ...PARSER, name: "@jxsuite/feed", title: "Feeds" }]);
    const registry = registryWith(true);
    const first = registry.run("project.enableExtension", { package: "@jxsuite/parser" });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(
      registry.run("project.enableExtension", { package: "@jxsuite/feed" }),
    ).rejects.toThrow(/Another extension operation is running/);
    release?.();
    await first;
  });

  test("removing a package is refused while another operation runs", async () => {
    resetStudioState({ projectConfig: { extensions: [] } });
    let release: (() => void) | undefined;
    installMockPlatform({
      addPackage: () =>
        new Promise<void>((r) => {
          release = r;
        }) as Promise<unknown>,
    });
    const registry = registryWith(true);
    const first = registry.run("project.enableExtension", { package: "@jxsuite/parser" });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(registry.run("packages.remove", { package: "@acme/other" })).rejects.toThrow(
      /Another extension operation is running/,
    );
    release?.();
    await first;
  });

  test("removing a package that is not enabled uninstalls it and reports it", async () => {
    resetStudioState({ projectConfig: { extensions: [] } });
    const { state } = installMockPlatform();
    const registry = registryWith(true);
    await registry.run("packages.remove", { package: "@acme/gone" });
    expect(
      state.calls.some(([name, arg]) => name === "removePackage" && arg === "@acme/gone"),
    ).toBe(true);
  });

  test("a second operation is refused while the first is in flight", async () => {
    resetStudioState({ projectConfig: { extensions: [] } });
    let release: (() => void) | undefined;
    installMockPlatform({
      addPackage: () =>
        new Promise<void>((r) => {
          release = r;
        }) as Promise<unknown>,
    });
    const registry = registryWith(true);
    const first = registry.run("project.enableExtension", { package: "@jxsuite/parser" });
    // The latch is taken synchronously, before the first await — which is what lets the section
    // Repaint every other switch as disabled.
    expect(extensionOpInFlight()).toBe("@jxsuite/parser");
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(
      registry.run("project.disableExtension", { package: "@jxsuite/parser" }),
    ).rejects.toThrow(/Another extension operation is running \(@jxsuite\/parser\)/);
    release?.();
    await first;
    expect(extensionOpInFlight()).toBeNull();
  });
});
