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

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  summary?: string;
}

/**
 * JSON Schema fragment describing a tool's parameters. Only the subset the registry's lightweight
 * validator inspects is modeled; arbitrary extra keywords are permitted.
 */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  strict: boolean;
  llmStrict: boolean;
  execute: (args: object) => Promise<ToolResult> | ToolResult;
}

export interface ToolRegistry {
  register: (tool: ToolDefinition) => void;
  list: () => ToolDefinition[];
  listForLLM: () => object[];
  validate: (toolName: string, args: object) => { valid: boolean; errors?: string[] };
  execute: (toolName: string, args: object) => Promise<ToolResult>;
  getDefinition: (toolName: string) => ToolDefinition | undefined;
}

// ─── ToolResult ──────────────────────────────────────────────────────────────

/**
 * Create a successful tool result.
 *
 * @param {unknown} data - Result data
 * @param {string} [summary] - Human-readable summary
 * @returns {ToolResult}
 */
export function toolSuccess(data: unknown, summary?: string): ToolResult {
  return { success: true, data, summary } as ToolResult;
}

/**
 * Create a failed tool result.
 *
 * @param {string} error - Error message
 * @returns {ToolResult}
 */
export function toolError(error: string): ToolResult {
  return { success: false, error };
}

// ─── ToolDefinition ──────────────────────────────────────────────────────────

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
}: {
  name: string;
  description: string;
  parameters: JSONSchema;
  strict?: boolean;
  llmStrict?: boolean;
  execute: (args: object) => Promise<ToolResult> | ToolResult;
}): ToolDefinition {
  return { name, description, parameters, strict, llmStrict, execute };
}

// ─── ToolRegistry ────────────────────────────────────────────────────────────

/**
 * Create a new tool registry.
 *
 * @returns {ToolRegistry}
 */
export function createToolRegistry() {
  const _tools = new Map<string, ToolDefinition>();

  return {
    /**
     * Register a tool definition.
     *
     * @param {ToolDefinition} tool
     */
    register(tool: ToolDefinition) {
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
          // Drives the registry's own argument validation below. They are different concerns:
          // OpenAI strict requires every object to set additionalProperties:false and list all
          // Properties in `required`, which the Jx tools deliberately don't (e.g. set_property's
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
    getDefinition(toolName: string) {
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
    validate(toolName: string, args: object) {
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

      const errors: string[] = [];
      const props = schema.properties;
      const required = schema.required || [];
      const argRecord = args as Record<string, unknown>;

      // Check required properties
      for (const key of required) {
        if (!(key in args) || argRecord[key] === undefined || argRecord[key] === null) {
          errors.push(`Missing required argument: "${key}"`);
        }
      }

      // Check property types (basic)
      for (const [key, value] of Object.entries(argRecord)) {
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

      return errors.length > 0 ? { valid: false, errors } : { valid: true };
    },

    /**
     * Execute a tool by name. Validates arguments before execution.
     *
     * @param {string} toolName
     * @param {object} args
     * @returns {Promise<ToolResult>}
     */
    async execute(toolName: string, args: object) {
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
        return toolError(`Tool "${toolName}" execution error: ${(error as Error).message}`);
      }
    },
  };
}
