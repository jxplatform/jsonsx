/**
 * Doubles for every `monaco-editor` entrypoint `src/services/monaco-setup.ts` imports.
 *
 * Monaco cannot load under happy-dom, so a suite that imports `monaco-setup` must intercept ALL of
 * them — and since 0.56 that is a curated list of ~34 `register` modules rather than four
 * contribution barrels. Two suites need it (`monaco-setup.test.ts`,
 * `monaco-font-remeasure.test.ts`) and a list copied into both would drift, so it lives here once.
 *
 * {@link MONACO_SETUP_ENTRIES} is also the drift guard: `monaco-setup.test.ts` asserts it is
 * exactly the set of specifiers the source imports, so adding a feature register without adding it
 * here fails by name rather than by a happy-dom crash in an unrelated suite.
 */

import { mock } from "bun:test";

/** The two entries that carry VALUES monaco-setup reads. */
export const MONACO_EDITOR_ENTRY = "monaco-editor/editor";
export const MONACO_JSON_ENTRY = "monaco-editor/languages/features/json/register";

/** The rest — imported purely to register a capability with the editor. */
export const MONACO_SIDE_EFFECT_ENTRIES = [
  "monaco-editor/features/codeEditor/register",
  "monaco-editor/features/codicon/register",
  "monaco-editor/features/tokenization/register",
  "monaco-editor/features/clipboard/register",
  "monaco-editor/features/comment/register",
  "monaco-editor/features/cursorUndo/register",
  "monaco-editor/features/dnd/register",
  "monaco-editor/features/indentation/register",
  "monaco-editor/features/lineSelection/register",
  "monaco-editor/features/linesOperations/register",
  "monaco-editor/features/multicursor/register",
  "monaco-editor/features/smartSelect/register",
  "monaco-editor/features/wordOperations/register",
  "monaco-editor/features/wordPartOperations/register",
  "monaco-editor/features/find/register",
  "monaco-editor/features/folding/register",
  "monaco-editor/features/gotoError/register",
  "monaco-editor/features/gotoLine/register",
  "monaco-editor/features/bracketMatching/register",
  "monaco-editor/features/codeAction/register",
  "monaco-editor/features/format/register",
  "monaco-editor/features/hover/register",
  "monaco-editor/features/links/register",
  "monaco-editor/features/parameterHints/register",
  "monaco-editor/features/snippet/register",
  "monaco-editor/features/suggest/register",
  "monaco-editor/features/inlineCompletions/register",
  "monaco-editor/features/contextmenu/register",
  "monaco-editor/features/readOnlyMessage/register",
  "monaco-editor/features/toggleTabFocusMode/register",
  "monaco-editor/features/unicodeHighlighter/register",
  "monaco-editor/languages/features/typescript/register",
  "monaco-editor/languages/definitions/javascript/register",
] as const;

/** Every `monaco-editor` specifier the module under test imports. */
export const MONACO_SETUP_ENTRIES: readonly string[] = [
  MONACO_EDITOR_ENTRY,
  MONACO_JSON_ENTRY,
  ...MONACO_SIDE_EFFECT_ENTRIES,
];

export interface MonacoSetupMockOptions {
  /** Stands in for the `jsonDefaults` monaco-setup pushes diagnostics options into. */
  jsonDefaults?: { setDiagnosticsOptions: (options: unknown) => void };
  /** Stands in for the editor API namespace (`editor.remeasureFonts`). */
  editorApi?: Record<string, unknown>;
}

/**
 * Install a double for every entry in {@link MONACO_SETUP_ENTRIES}. Call BEFORE importing
 * `../src/services/monaco-setup`.
 */
export function installMonacoSetupMocks(options: MonacoSetupMockOptions = {}): void {
  const jsonDefaults = options.jsonDefaults ?? { setDiagnosticsOptions: () => {} };
  void mock.module(MONACO_EDITOR_ENTRY, () => options.editorApi ?? {});
  void mock.module(MONACO_JSON_ENTRY, () => ({ jsonDefaults }));
  for (const entry of MONACO_SIDE_EFFECT_ENTRIES) {
    void mock.module(entry, () => ({}));
  }
}
