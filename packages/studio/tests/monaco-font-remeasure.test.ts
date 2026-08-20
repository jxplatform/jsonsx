/**
 * Monaco-setup font remeasure test, isolated from monaco-setup.test.ts so this file gets its own
 * module registry: monaco-setup.ts wires the fonts.ready remeasure on import, and happy-dom has no
 * document.fonts by default, so document.fonts must be stubbed before the module is imported here.
 */
import { flush } from "./harness";
import { describe, expect, mock, test } from "bun:test";
import { installMonacoSetupMocks } from "./monaco-setup-mocks";

const remeasureFonts = mock(() => {});

installMonacoSetupMocks({ editorApi: { editor: { remeasureFonts } } });

(globalThis as any).self ??= globalThis;

let resolveReady!: () => void;
(document as any).fonts = {
  ready: new Promise<void>((resolve) => {
    resolveReady = resolve;
  }),
};

await import("../src/services/monaco-setup");

describe("monaco-setup — font remeasure on fonts.ready", () => {
  test("remeasures Monaco glyph widths once vendored webfonts finish loading", async () => {
    resolveReady();
    await flush();
    expect(remeasureFonts).toHaveBeenCalledTimes(1);
  });
});
