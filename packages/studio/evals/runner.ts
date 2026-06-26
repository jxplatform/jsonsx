/**
 * Runner.js — headless driver for the AI-assistant eval harness.
 *
 * Exercises the *production* agent loop (the real `runAgentLoop` + `@jxsuite/ai` tool registry +
 * `ai-system-prompt` + `ai-tools`) against a fixed task, swapping only the fake test client for a
 * real OpenAI-compatible streaming client. Each trial gets a fresh tab (clean state — no shared
 * caches, per Anthropic's isolation guidance), then the produced document is graded.
 *
 * @license MIT
 */

import { createChatState, createToolRegistry } from "@jxsuite/ai";
import { createOpenAIStreamingClient } from "@jxsuite/ai/streaming-client";
import type { StreamingClient } from "@jxsuite/ai/streaming-client";
import type { ToolRegistry } from "@jxsuite/ai/tools";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { createTab, disposeTab } from "../src/tabs/tab";
import { registerAiTools } from "../src/services/ai-tools";
import { runAgentLoop } from "../src/services/tool-executor";
import { buildSystemPrompt } from "../src/services/ai-system-prompt";
import { renderCritic } from "./render-critic.js";
import { schemaGrader } from "./schema-grader.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Resolve OpenAI config from env, mirroring the server proxy (packages/server/src/ai-api.js).
 *
 * @returns {{ apiKey: string; baseUrl: string; model: string }}
 */
export function resolveConfig() {
  const apiKey = process.env.OPENAI_API_KEY || "";
  const baseUrl = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  return { apiKey, baseUrl, model };
}

export interface Task {
  id: string;
  prompt: string;
  initialDoc: JxMutableNode;
  intent?: string[];
  tags?: string[];
}

export interface TrialResult {
  pass: boolean;
  render: { pass: boolean; errors: string[] };
  schema: { pass: boolean; errors: string[] };
  rounds: number;
  toolCalls: number;
  loopError: string | null;
  finalDoc: object;
  transcript: object[];
}

/**
 * Run a single trial of a task through the real agent loop and grade the result.
 *
 * @param task
 * @param opts
 * @param opts.client - Override the LLM client (the scripted fake client is injected here in unit
 *   tests).
 */
export async function runTrial(
  task: Task,
  { client }: { client?: StreamingClient | undefined } = {},
): Promise<TrialResult> {
  const cfg = resolveConfig();
  const tab = createTab({
    document: structuredClone(task.initialDoc) as Record<string, unknown>,
    id: `eval-${task.id}`,
  });

  try {
    const chatState = createChatState({ model: cfg.model });
    const toolRegistry = createToolRegistry() as ToolRegistry;
    // Default `validate` is the real validateDoc, so the loop self-corrects just like production.
    registerAiTools(toolRegistry, { getTab: () => tab });

    const streamingClient =
      client ??
      createOpenAIStreamingClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });

    chatState.sendMessage(task.prompt);
    await runAgentLoop({
      chatState,
      streamingClient,
      toolRegistry,
      systemPrompt: buildSystemPrompt({ document: structuredClone(task.initialDoc) }),
    });

    // JSON-clone to strip the Vue reactive proxy and any functions — graders only need the plain
    // JSON shape.
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone throws on the reactive proxy; JSON round-trip is the deliberate way to flatten it
    const finalDoc = JSON.parse(JSON.stringify(tab.doc.document)) as typeof tab.doc.document;
    const render = await renderCritic(finalDoc);
    const schema = await schemaGrader(finalDoc);

    const transcript = chatState.toMessagesArray();
    const toolCalls = transcript.reduce(
      (n, m) => n + (Array.isArray(m.tool_calls) ? m.tool_calls.length : 0),
      0,
    );
    const rounds = transcript.filter((m) => m.role === "assistant").length;

    return {
      pass: render.pass, // Render critic is the PRIMARY signal (per scope decision).
      render,
      schema,
      rounds,
      toolCalls,
      loopError: chatState.status === "error" ? chatState.error : null,
      finalDoc,
      transcript,
    };
  } finally {
    disposeTab(tab);
  }
}

/**
 * Run a task `k` times and compute pass@k / pass^k (Anthropic non-determinism metrics).
 *
 * @param task
 * @param opts
 * @param opts.k
 * @param opts.client
 */
export async function runTask(
  task: Task,
  { k = 3, client }: { k?: number; client?: StreamingClient | undefined } = {},
): Promise<{
  id: string;
  tags: string[];
  k: number;
  passAtK: boolean;
  passHatK: boolean;
  passRate: number;
  trials: TrialResult[];
}> {
  const trials: TrialResult[] = [];
  for (let i = 0; i < k; i++) {
    trials.push(await runTrial(task, { client }));
  }
  const passes = trials.filter((t) => t.pass).length;
  return {
    id: task.id,
    tags: task.tags ?? [],
    k,
    passAtK: passes >= 1, // ≥1 success in k attempts
    passHatK: passes === k, // All k succeed (reliability)
    passRate: passes / k,
    trials,
  };
}
