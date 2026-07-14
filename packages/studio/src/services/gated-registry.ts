/**
 * Gated-registry.ts — state-aware tool advertisement for the AI assistant.
 *
 * Wraps a `@jxsuite/ai` ToolRegistry so each tool is only advertised to the LLM while its
 * availability predicate holds (no project open → bootstrap tools only; project open → file tools;
 * document open → document tools). `runAgentLoop` calls `listForLLM()` every round, so availability
 * flips mid-loop: after `create_project` succeeds, the very next round advertises the file and
 * document tools without any extra plumbing.
 *
 * Executing a tool whose predicate currently fails returns a tool error naming the missing state
 * instead of throwing, so the agent loop can self-correct.
 *
 * @license MIT
 */

import type { ToolDefinition, ToolRegistry } from "@jxsuite/ai/tools";

export interface ToolAvailability {
  /** Whether the tool is currently advertised/executable. */
  when: () => boolean;
  /** Human-readable requirement, surfaced when execution is refused (e.g. "a project is open"). */
  requires: string;
}

/**
 * Wrap `inner` so tools listed in `availability` are only advertised/executable while their
 * predicate holds. Tools without an entry are always available.
 *
 * @param {ToolRegistry} inner
 * @param {Map<string, ToolAvailability>} availability
 * @returns {ToolRegistry}
 */
export function createGatedToolRegistry(
  inner: ToolRegistry,
  availability: Map<string, ToolAvailability>,
): ToolRegistry {
  function isAvailable(name: string): boolean {
    const gate = availability.get(name);
    return gate ? gate.when() : true;
  }

  return {
    register(tool: ToolDefinition) {
      inner.register(tool);
    },
    list() {
      return inner.list().filter((t) => isAvailable(t.name));
    },
    listForLLM() {
      const available = new Set(this.list().map((t) => t.name));
      return inner
        .listForLLM()
        .filter((t) => available.has((t as { function?: { name?: string } }).function?.name ?? ""));
    },
    getDefinition(toolName: string) {
      return inner.getDefinition(toolName);
    },
    validate(toolName: string, args: object) {
      return inner.validate(toolName, args);
    },
    async execute(toolName: string, args: object) {
      if (inner.getDefinition(toolName) && !isAvailable(toolName)) {
        const gate = availability.get(toolName);
        return {
          success: false,
          error: `Tool "${toolName}" is not available right now — it requires ${gate?.requires ?? "a different studio state"}.`,
        };
      }
      return inner.execute(toolName, args);
    },
  };
}
