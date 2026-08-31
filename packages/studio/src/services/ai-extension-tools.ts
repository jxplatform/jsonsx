/**
 * Ai-extension-tools — the assistant's two verbs over `project.json` `extensions[]`.
 *
 * **They run the human's commands rather than reimplementing the writes.**
 * `specs/studio-ui-guidelines.md` §12.4 is explicit that "the agent counts as a surface": a tool
 * that writes what a command writes is bound by the command's rule, and binds to it by READING the
 * same registry, not by recomputing the same tests. So `execute` is a thin call into
 * `project.enableExtension` / `project.disableExtension`, and every refusal the person would see —
 * the availability sentence, the "not an extension this backend offers" list, the "disable it
 * first" — reaches the model as the identical string.
 *
 * **There is no `list_extensions` read tool, deliberately.** The system prompt already carries the
 * catalogue, the enabled set and each entry's sections at turn start, so a read tool could only
 * answer a question the prompt has answered. The one thing it would add — "what changed after I
 * enabled that" — is served by `enable_extension`'s own result summary, which costs no prompt
 * budget because it is a result rather than an advertisement.
 *
 * @license MIT
 */

import { createToolDefinition } from "@jxsuite/ai/tools";
import { activeRegistry } from "../commands/active-registry";
import { buildRows } from "../settings/extension-rows";
import type { ToolRegistry, ToolResult } from "@jxsuite/ai/tools";

/**
 * Run a command as the agent, and report its own refusal verbatim.
 *
 * `CommandUnavailableError`'s message IS `refusalSentence` — the same string a disabled control's
 * tooltip and the palette's grey subtitle print — and a `RangeError` from an argument gate already
 * names the value and lists the alternatives. Passing both through untouched is what makes an agent
 * refusal read exactly like the person's.
 *
 * There is deliberately no pre-check with `refusalMessage`: `run` refuses with the same sentence,
 * and a second call site for one predicate is precisely the divergence §12.4 is about.
 *
 * @param {string} id - Command id
 * @param {Record<string, unknown>} args
 * @returns {Promise<ToolResult>}
 */
async function runAsTool(id: string, args: Record<string, unknown>): Promise<ToolResult> {
  const registry = activeRegistry();
  if (!registry) {
    return { error: `Cannot run "${id}" — this window has no command registry.`, success: false };
  }
  try {
    await registry.run(id, args);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), success: false };
  }
  return { success: true };
}

/** The `project.json` sections an extension owns, for the result summary. */
function sectionsOf(name: string): string[] {
  return buildRows().find((row) => row.name === name || row.specifier === name)?.sections ?? [];
}

/** The specifiers the project enables right now, for the result summary. */
function enabledNow(): string[] {
  return buildRows()
    .filter((row) => row.enabled)
    .map((row) => row.specifier);
}

/**
 * Register the extension tools.
 *
 * Takes no context: the writes go through the command registry, which the assistant already reads
 * for its `document-tree` gate, so there is nothing for a caller to inject.
 *
 * @param {Pick<ToolRegistry, "register">} registry
 */
export function registerExtensionTools(registry: Pick<ToolRegistry, "register">): void {
  registry.register(
    createToolDefinition({
      description:
        "Turn on a Jx extension for this project. Installs its npm package if it is missing, then " +
        'adds it to project.json "extensions". Call this BEFORE writing the project.json section ' +
        "the extension owns: a section belonging to a disabled extension is a schema error, and an " +
        '"extensions" entry whose package is not installed fails the build. The names available, ' +
        "and what each contributes, are listed in the project context. Installing is not undoable.",
      async execute(args) {
        const { package: name } = args as { package: string };
        const result = await runAsTool("project.enableExtension", { package: name });
        if (!result.success) {
          return result;
        }
        const sections = sectionsOf(name);
        const owned =
          sections.length > 0
            ? ` Its project.json sections are now valid: ${sections.join(", ")}.`
            : "";
        return {
          success: true,
          summary: `Enabled ${name}.${owned} Enabled extensions: ${enabledNow().join(", ") || "none"}.`,
        };
      },
      name: "enable_extension",
      parameters: {
        properties: {
          package: {
            description: 'The extension\'s npm package name, e.g. "@jxsuite/parser".',
            type: "string",
          },
        },
        required: ["package"],
        type: "object",
      },
    }),
  );

  registry.register(
    createToolDefinition({
      description:
        'Remove an extension from project.json "extensions". Its npm package stays installed, and ' +
        "the settings sections it contributed disappear. Remove any project.json sections it owns " +
        "first, or the configuration will not validate.",
      async execute(args) {
        const { package: name } = args as { package: string };
        const result = await runAsTool("project.disableExtension", { package: name });
        if (!result.success) {
          return result;
        }
        return {
          success: true,
          summary:
            `Disabled ${name}; its npm package is still installed. Ask before uninstalling it. ` +
            `Enabled extensions: ${enabledNow().join(", ") || "none"}.`,
        };
      },
      name: "disable_extension",
      parameters: {
        properties: {
          package: {
            description: "The extension to turn off, by package name.",
            type: "string",
          },
        },
        required: ["package"],
        type: "object",
      },
    }),
  );
}
