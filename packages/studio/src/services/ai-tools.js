/**
 * Ai-tools.js — Jx document manipulation tools for the AI assistant
 *
 * Concrete `.jx` AST tools registered into a `@jxsuite/ai` ToolRegistry. Each tool wraps an
 * existing `transactDoc()` mutation helper so AI edits get the same undo/redo history as manual
 * edits (ADR docs/ai-assistant-decision.md §5 — optimistic apply + undo).
 *
 * @license MIT
 */

import { createToolDefinition } from "@jxsuite/ai/tools";
import { getNodeAtPath } from "../state";
import { toRaw } from "../reactivity";
import {
  mutateInsertNode,
  mutateRemoveNode,
  mutateUpdateProperty,
  transactDoc,
} from "../tabs/transact";
import { validateDoc } from "./jx-validate";

const PATH_DESCRIPTION =
  "Path to a node in the document, as a JSON array of keys/indices from the root " +
  '(e.g. ["children", 0, "children", 1]). Use read_document to discover valid paths.';

/**
 * Translate a raw JSON Schema validation error into a Jx-specific actionable message. The LLM needs
 * concrete guidance on HOW to fix errors, not just what rule was violated.
 *
 * @param {string} rawError - Message from ajv (e.g. "/children/0/style: must NOT have additional
 *   property")
 * @returns {string}
 */
function translateValidationError(rawError) {
  const lower = rawError.toLowerCase();

  // Additional property — extract the offending key from the message if present
  if (
    lower.includes("must not have additional property") ||
    lower.includes("additional properties")
  ) {
    return `${rawError}\n  → Fix: Remove or move the unexpected property. Style properties must be camelCase (e.g. "backgroundColor", not "background-color"). Non-IDL HTML attributes (aria-*, data-*, role, ...) must go inside an "attributes" object: { "attributes": { "aria-label": "..." } }.`;
  }

  // Pattern — usually tagName hyphen rule
  if (lower.includes("must match pattern")) {
    return `${rawError}\n  → Fix: Custom element tag names must contain a hyphen (e.g. "newsletter-form", "feature-card"). Standard HTML elements use their exact name (e.g. "div", "input", "button").`;
  }

  // Type error
  if (lower.includes("must be string")) {
    return `${rawError}\n  → Fix: Wrap the value in quotes — all Jx property values should be strings. For example, use "10px" (string) not 10px (unquoted).`;
  }

  if (lower.includes("must be number") || lower.includes("must be integer")) {
    return `${rawError}\n  → Fix: Remove quotes from the numeric value — it should be a plain number, not a string.`;
  }

  if (lower.includes("must be object") || lower.includes("must be array")) {
    return `${rawError}\n  → Fix: The value must be an object/array (use {} or []), not a string or number.`;
  }

  if (lower.includes("must be boolean")) {
    return `${rawError}\n  → Fix: Use true or false without quotes for boolean values.`;
  }

  // Required property
  if (lower.includes("must have required property")) {
    return `${rawError}\n  → Fix: Add the missing required property. Every Jx element must have at least a "tagName" field.`;
  }

  // Enum / allowed values
  if (lower.includes("must be equal to one of the allowed values")) {
    return `${rawError}\n  → Fix: Change the value to one of the allowed options listed in the error.`;
  }

  return rawError;
}

/**
 * Apply a mutation, then validate the document and report only the schema errors the edit newly
 * introduced (the eval signal — ADR §6b). The change stays applied either way (optimistic apply +
 * undo, ADR §5); reporting the errors lets the agent loop self-correct on the next round.
 *
 * @param {import("../tabs/tab").Tab} tab
 * @param {(t: import("../tabs/tab").Tab) => void} mutationFn
 * @param {string} summary
 * @param {(doc: unknown) => Promise<string[]>} validate
 * @returns {Promise<import("@jxsuite/ai/tools").ToolResult>}
 */
async function applyAndValidate(tab, mutationFn, summary, validate) {
  const before = new Set(await validate(toRaw(tab.doc.document)));
  transactDoc(tab, mutationFn);
  const after = await validate(toRaw(tab.doc.document));
  const newErrors = after.filter((e) => !before.has(e));
  if (newErrors.length > 0) {
    const formatted = newErrors.map((e) => `- ${translateValidationError(e)}`).join("\n");
    return {
      success: false,
      error: `Change applied, but it introduced schema errors. Fix these issues with follow-up edits:\n${formatted}`,
    };
  }
  return { success: true, summary };
}

/**
 * Register the document-manipulation tools into a tool registry.
 *
 * @param {import("@jxsuite/ai/tools").ToolRegistry} registry
 * @param {{
 *   getTab: () => import("../tabs/tab").Tab | null;
 *   validate?: (doc: unknown) => Promise<string[]>;
 * }} ctx
 */
export function registerAiTools(registry, { getTab, validate = validateDoc }) {
  registry.register(
    createToolDefinition({
      name: "read_document",
      description:
        "Read the current Jx document, or the subtree at a given path. Use this to discover " +
        "node paths before calling set_property, add_child, or remove_node.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "array",
            description: `${PATH_DESCRIPTION} Omit to read the whole document.`,
            items: { type: ["string", "number"] },
          },
        },
        required: [],
      },
      execute(args) {
        const tab = getTab();
        if (!tab) {
          return { success: false, error: "No document is open." };
        }
        const { path } = args;
        const node =
          path && path.length > 0 ? getNodeAtPath(tab.doc.document, path) : tab.doc.document;
        if (node === undefined) {
          return { success: false, error: `No node exists at path ${JSON.stringify(path)}.` };
        }
        return { success: true, data: node };
      },
    }),
  );

  registry.register(
    createToolDefinition({
      name: "set_property",
      description:
        "Set or remove a property on a node (e.g. tagName, textContent, className, style, " +
        "attributes, $props). Pass value: null to remove the property.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "array",
            description: PATH_DESCRIPTION,
            items: { type: ["string", "number"] },
          },
          key: {
            type: "string",
            description: 'The property name to set, e.g. "textContent" or "className".',
          },
          value: {
            description: "The new value, or null to remove the property.",
          },
        },
        required: ["path", "key", "value"],
      },
      async execute(args) {
        const tab = getTab();
        if (!tab) {
          return { success: false, error: "No document is open." };
        }
        const { path } = args;
        const node = getNodeAtPath(tab.doc.document, path);
        if (node === undefined) {
          return { success: false, error: `No node exists at path ${JSON.stringify(path)}.` };
        }
        return applyAndValidate(
          tab,
          (t) =>
            mutateUpdateProperty(
              t,
              path,
              /** @type {string} */ (args.key),
              args.value ?? undefined,
            ),
          `Set "${args.key}" at ${JSON.stringify(path)}.`,
          validate,
        );
      },
    }),
  );

  registry.register(
    createToolDefinition({
      name: "add_child",
      description:
        "Insert a new child node into the children array of the node at parentPath, at the " +
        "given index (0 = first child). The node definition follows the Jx document schema " +
        '(e.g. { "tagName": "p", "textContent": "Hello" }).',
      parameters: {
        type: "object",
        properties: {
          parentPath: {
            type: "array",
            description: `${PATH_DESCRIPTION} Must point at a node, not a children array.`,
            items: { type: ["string", "number"] },
          },
          index: { type: "integer", description: "Position in the children array to insert at." },
          node: {
            type: "object",
            description:
              'The Jx node definition to insert, e.g. { "tagName": "div", "children": [] }.',
          },
        },
        required: ["parentPath", "index", "node"],
      },
      async execute(args) {
        const tab = getTab();
        if (!tab) {
          return { success: false, error: "No document is open." };
        }
        const { parentPath } = args;
        const parent = getNodeAtPath(tab.doc.document, parentPath);
        if (parent === undefined) {
          return { success: false, error: `No node exists at path ${JSON.stringify(parentPath)}.` };
        }
        if (parent.children !== undefined && !Array.isArray(parent.children)) {
          return {
            success: false,
            error: "Cannot insert into mapped-array children; edit the map template instead.",
          };
        }
        const { index } = args;
        return applyAndValidate(
          tab,
          (t) =>
            mutateInsertNode(
              t,
              parentPath,
              index,
              /** @type {import("@jxsuite/schema/types").JxMutableNode} */ (args.node),
            ),
          `Inserted node at ${JSON.stringify([...parentPath, "children", index])}.`,
          validate,
        );
      },
    }),
  );

  registry.register(
    createToolDefinition({
      name: "remove_node",
      description: "Remove the node at the given path from its parent's children array.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "array",
            description: `${PATH_DESCRIPTION} Cannot be the document root.`,
            items: { type: ["string", "number"] },
          },
        },
        required: ["path"],
      },
      async execute(args) {
        const tab = getTab();
        if (!tab) {
          return { success: false, error: "No document is open." };
        }
        const { path } = args;
        if (path.length < 2) {
          return { success: false, error: "Cannot remove the document root." };
        }
        if (getNodeAtPath(tab.doc.document, path) === undefined) {
          return { success: false, error: `No node exists at path ${JSON.stringify(path)}.` };
        }
        return applyAndValidate(
          tab,
          (t) => mutateRemoveNode(t, path),
          `Removed node at ${JSON.stringify(path)}.`,
          validate,
        );
      },
    }),
  );
}
