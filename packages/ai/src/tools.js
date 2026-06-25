/**
 * Tools.js — Tool registry infrastructure
 *
 * Provider-agnostic base classes for defining and registering tools that an LLM
 * can call. Tools have JSON Schema parameter definitions and execute functions.
 * The registry validates arguments before execution.
 *
 * @license MIT
 * @module @jxsuite/ai/tools
 */

// ─── ToolResult ──────────────────────────────────────────────────────────────

/**
 * Result returned by a tool execution.
 *
 * @typedef {{
 *   success: boolean;
 *   data?: any;
 *   error?: string;
 *   summary?: string;
 * }} ToolResult
 */

/**
 * Create a successful tool result.
 *
 * @param {any} data - Result data
 * @param {string} [summary] - Human-readable summary
 * @returns {ToolResult}
 */
export function toolSuccess(data, summary) {
  return { success: true, data, summary };
}

/**
 * Create a failed tool result.
 *
 * @param {string} error - Error message
 * @returns {ToolResult}
 */
export function toolError(error) {
  return { success: false, error };
}

// ─── ToolDefinition ──────────────────────────────────────────────────────────

/**
 * A tool that can be called by an LLM.
 *
 * @typedef {{
 *   name: string;
 *   description: string;
 *   parameters: object;
 *   execute: (args: object) => Promise<ToolResult> | ToolResult;
 * }} ToolDefinition
 */

/**
 * Create a tool definition.
 *
 * @param {object} opts
 * @param {string} opts.name - Unique tool name (lowercase, underscores for spaces)
 * @param {string} opts.description - What the tool does (used by the LLM to decide when to call it)
 * @param {object} opts.parameters - JSON Schema for the tool's arguments
 * @param {boolean} [opts.strict] - Whether the registry enforces its own argument validation
 *   (default true). Distinct from `llmStrict`.
 * @param {boolean} [opts.llmStrict] - Whether to send OpenAI `strict: true` in the function schema
 *   (default false). Only enable if the parameter schema is OpenAI-strict-compliant
 *   (additionalProperties:false everywhere, all properties in `required`, every property typed).
 * @param {(args: object) => Promise<ToolResult> | ToolResult} opts.execute - The tool
 *   implementation
 * @returns {ToolDefinition}
 */
export function createToolDefinition({
  name,
  description,
  parameters,
  strict = true,
  llmStrict = false,
  execute,
}) {
  return { name, description, parameters, strict, llmStrict, execute };
}

// ─── ToolRegistry ────────────────────────────────────────────────────────────

/**
 * Registry for LLM-callable tools. Provides registration, listing in OpenAI function-calling
 * format, and argument validation using JSON Schema.
 *
 * @typedef {{
 *   register: (tool: ToolDefinition) => void;
 *   list: () => ToolDefinition[];
 *   listForLLM: () => object[];
 *   validate: (toolName: string, args: object) => { valid: boolean; errors?: string[] };
 *   execute: (toolName: string, args: object) => Promise<ToolResult>;
 *   getDefinition: (toolName: string) => ToolDefinition | undefined;
 * }} ToolRegistry
 */

/**
 * Create a new tool registry.
 *
 * @returns {ToolRegistry}
 */
export function createToolRegistry() {
  /** @type {Map<string, ToolDefinition>} */
  const _tools = new Map();

  return {
    /**
     * Register a tool definition.
     *
     * @param {ToolDefinition} tool
     */
    register(tool) {
      if (_tools.has(tool.name)) {
        console.warn(`Tool "${tool.name}" is being re-registered.`);
      }
      _tools.set(tool.name, tool);
    },

    /**
     * List all registered tool definitions.
     *
     * @returns {ToolDefinition[]}
     */
    list() {
      return [..._tools.values()];
    },

    /**
     * List tools in OpenAI function-calling format.
     *
     * @returns {object[]}
     */
    listForLLM() {
      return [..._tools.values()].map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          // OpenAI strict mode is opt-in per tool via `llmStrict`, NOT the `strict` field — that one
          // drives the registry's own argument validation below. They are different concerns:
          // OpenAI strict requires every object to set additionalProperties:false and list all
          // properties in `required`, which the Jx tools deliberately don't (e.g. set_property's
          // `value` is polymorphic and optional). GPT-5.x rejects the schema otherwise.
          ...(t.llmStrict === true ? { strict: true } : {}),
        },
      }));
    },

    /**
     * Get a single tool definition by name.
     *
     * @param {string} toolName
     * @returns {ToolDefinition | undefined}
     */
    getDefinition(toolName) {
      return _tools.get(toolName);
    },

    /**
     * Validate tool arguments against the tool's JSON Schema.
     *
     * This is a lightweight structural check — it verifies required properties exist and property
     * types match. Full JSON Schema validation (pattern, minimum, maximum, enum, etc.) can be
     * layered on with a proper validator library if needed.
     *
     * @param {string} toolName
     * @param {object} args
     * @returns {{ valid: boolean; errors?: string[] }}
     */
    validate(toolName, args) {
      const tool = _tools.get(toolName);
      if (!tool) {
        return { valid: false, errors: [`Unknown tool: "${toolName}"`] };
      }

      if (!tool.strict) {
        return { valid: true };
      }

      const schema = tool.parameters;
      if (!schema || !schema.properties) {
        return { valid: true };
      }

      const errors = [];
      const props = /** @type {Record<string, object>} */ (schema.properties);
      const required = /** @type {string[]} */ (schema.required || []);

      // Check required properties
      for (const key of required) {
        if (!(key in args) || args[key] === undefined || args[key] === null) {
          errors.push(`Missing required argument: "${key}"`);
        }
      }

      // Check property types (basic)
      for (const [key, value] of Object.entries(args)) {
        const propSchema = props[key];
        if (!propSchema) {
          // Unknown property — warn but don't fail (LLM might send extra)
          continue;
        }

        const expectedType = propSchema.type;
        if (!expectedType) {
          continue;
        }

        const actualType = Array.isArray(value) ? "array" : typeof value;

        // Number / integer type validation with string coercion
        if (expectedType === "number" || expectedType === "integer") {
          if (actualType === "number") {
            continue;
          }
          if (actualType === "string") {
            if (!Number.isNaN(Number(value))) {
              continue;
            }
            errors.push(`Argument "${key}" should be a number, got non-numeric string "${value}"`);
            continue;
          }
          errors.push(`Argument "${key}" should be a number, got ${actualType}`);
          continue;
        }

        if (expectedType === "string" && actualType !== "string") {
          errors.push(`Argument "${key}" should be a string, got ${actualType}`);
        } else if (expectedType === "boolean" && actualType !== "boolean") {
          errors.push(`Argument "${key}" should be a boolean, got ${actualType}`);
        } else if (expectedType === "array" && actualType !== "array") {
          errors.push(`Argument "${key}" should be an array, got ${actualType}`);
        } else if (expectedType === "object" && actualType !== "object") {
          errors.push(`Argument "${key}" should be an object, got ${actualType}`);
        }
      }

      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
    },

    /**
     * Execute a tool by name. Validates arguments before execution.
     *
     * @param {string} toolName
     * @param {object} args
     * @returns {Promise<ToolResult>}
     */
    async execute(toolName, args) {
      const tool = _tools.get(toolName);
      if (!tool) {
        return toolError(`Unknown tool: "${toolName}"`);
      }

      // Validate
      const validation = this.validate(toolName, args);
      if (!validation.valid) {
        return toolError(`Validation failed: ${(validation.errors || []).join("; ")}`);
      }

      try {
        return await tool.execute(args);
      } catch (error) {
        return toolError(
          `Tool "${toolName}" execution error: ${/** @type {Error} */ (error).message}`,
        );
      }
    },
  };
}
