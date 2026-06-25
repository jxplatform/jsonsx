/**
 * Run-eval.js — driver: run testing-plan prompts through the headless harness and emit
 * turnover-shaped rows.
 *
 * Each test runs N times (default 3, per testing-plan §3.2 determinism) on a _fresh_ harness, and
 * the **worst** run per axis is reported — borderline results don't get to cherry-pick a lucky
 * pass.
 *
 * Usage: JX_AI_KEY=... bun run packages/studio/tests/harness/run-eval.js # all defined tests
 * JX_AI_KEY=... bun run packages/studio/tests/harness/run-eval.js L1.1 L1.3
 *
 * See docs/ai-assistant-headless-harness.md §3 Step 4.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadFixture } from "./load-fixture.js";
import { buildRealHarness, runPrompt } from "./real-llm.js";
import { scoreRun } from "./score.js";
import { textOf, anyStyle, anyNode } from "./doc-query.js";
import { validateDoc } from "../../src/services/jx-validate";

/** A node with this tag (case-insensitive). */
const hasTag = (doc, tag) => anyNode(doc, (n) => String(n.tagName).toLowerCase() === tag);
/** A node whose own visible text includes `s`. */
const nodeWithText = (doc, tag, s) =>
  anyNode(doc, (n) => String(n.tagName).toLowerCase() === tag && JSON.stringify(n).includes(s));
/** Validate a component the model wrote to disk; returns true if a schema-valid file was created. */
async function wroteValidComponent(ctx, pred = () => true) {
  for (const w of ctx.writes ?? []) {
    let doc;
    try {
      doc = JSON.parse(w.content);
    } catch {
      continue;
    }
    const errors = await validateDoc(doc);
    if (errors.length === 0 && pred(doc)) return true;
  }
  return false;
}

/** All candidate docs the model may have targeted: the live page plus any written file. */
function candidateDocs(liveDoc, ctx) {
  const docs = [liveDoc];
  for (const w of ctx.writes ?? []) {
    try {
      docs.push(JSON.parse(w.content));
    } catch {
      /* skip unparseable */
    }
  }
  return docs;
}
/** True if any candidate doc satisfies `pred` (state may live on the page or in a component file). */
const inAnyDoc = (liveDoc, ctx, pred) => candidateDocs(liveDoc, ctx).some(pred);
/** True if a doc declares a non-empty `state` object. */
const hasState = (d) => d && typeof d.state === "object" && Object.keys(d.state).length > 0;
/** True if a doc's JSON contains a marker string (e.g. "$map", "$switch"). */
const hasMarker = (d, s) => JSON.stringify(d).includes(s);

// Load the repo-root .env regardless of cwd — Bun only auto-loads .env from the directory it's run
// in, and `eval:headless` runs inside packages/studio. Existing env vars always win.
loadRepoEnv();
function loadRepoEnv() {
  try {
    const text = readFileSync(resolve(import.meta.dir, "../../../../.env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      let val = m[2].trim().replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no repo-root .env — rely on the ambient environment */
  }
}

const RUNS_PER_TEST = Number(process.env.JX_AI_RUNS || 3);

/**
 * Test catalog — mirrors docs/ai-assistant-testing-plan.md. Start with Layer 1; add layers as the
 * harness earns trust. `check(finalDoc)` asserts the _outcome_ (drives Completeness, independent of
 * which tools were used); `mustReadFirst` flags the §5.1 read-before-mutate constraint.
 *
 * @type {{
 *   id: string;
 *   prompt: string;
 *   check: (doc: any) => boolean;
 *   mustReadFirst?: boolean;
 * }[]}
 */
const TESTS = [
  // ── Layer 1: single property changes ──
  {
    id: "L1.1",
    prompt: "Change the heading text to 'Hello World'",
    mustReadFirst: true,
    check: (d) => textOf(d).includes("Hello World"),
  },
  {
    id: "L1.2",
    prompt: "Make the heading font size 3rem",
    mustReadFirst: true,
    check: (d) => anyStyle(d, "fontSize", "3rem"),
  },
  {
    id: "L1.3",
    prompt: "Change the heading color to #3b82f6 (blue)",
    mustReadFirst: true,
    check: (d) => anyStyle(d, "color", (v) => v.includes("3b82f6") || v.includes("59, 130, 246")),
  },
  {
    id: "L1.4",
    prompt: "Right-align the heading",
    mustReadFirst: true,
    check: (d) => anyStyle(d, "textAlign", "right"),
  },
  {
    id: "L1.5",
    prompt: "Add 20px padding to the heading",
    mustReadFirst: true,
    check: (d) => anyStyle(d, "padding", "20px"),
  },

  // ── Layer 2: structural mutations (self-contained — each runs on a fresh fixture) ──
  {
    id: "L2.1",
    prompt: "Add a paragraph below the heading that says 'This is a test paragraph'",
    mustReadFirst: true,
    check: (d) => hasTag(d, "p") && textOf(d).includes("This is a test paragraph"),
  },
  {
    id: "L2.2",
    prompt: "Add a button labeled 'Click Me' to the page",
    mustReadFirst: true,
    check: (d) => nodeWithText(d, "button", "Click Me"),
  },
  {
    id: "L2.3",
    prompt: "Add a temporary paragraph saying 'temp', then remove it so the page looks unchanged",
    mustReadFirst: true,
    check: (d) => !textOf(d).includes("temp") && hasTag(d, "h1"),
  },
  {
    id: "L2.4",
    prompt: "Add a 3-item bullet list to the page",
    mustReadFirst: true,
    check: (d) =>
      anyNode(
        d,
        (n) =>
          String(n.tagName).toLowerCase() === "ul" &&
          Array.isArray(n.children) &&
          n.children.filter((c) => String(c.tagName).toLowerCase() === "li").length === 3,
      ),
  },
  {
    id: "L2.5",
    prompt:
      "Wrap the heading in a <header> element — the h1 should become a child of a new <header> tag",
    mustReadFirst: true,
    check: (d) =>
      anyNode(
        d,
        (n) =>
          String(n.tagName).toLowerCase() === "header" &&
          Array.isArray(n.children) &&
          n.children.some((c) => String(c.tagName).toLowerCase() === "h1"),
      ),
  },

  // ── Layer 3: new component creation (asserts on the written file, via ctx.writes) ──
  {
    id: "L3.1",
    prompt: "Create a simple card component with a title, description, and a button",
    check: (_d, ctx) => wroteValidComponent(ctx, (c) => textOf(c) || (c.children?.length ?? 0) > 0),
  },
  {
    id: "L3.2",
    prompt: "Create a newsletter signup form component with an email input and a submit button",
    check: (_d, ctx) =>
      wroteValidComponent(
        ctx,
        (c) =>
          anyNode(c, (n) => String(n.tagName).toLowerCase() === "input") &&
          anyNode(c, (n) => String(n.tagName).toLowerCase() === "button"),
      ),
  },
  {
    id: "L3.4",
    prompt: "Create a nav bar component with a logo and 3 links",
    check: (_d, ctx) =>
      wroteValidComponent(ctx, (c) => anyNode(c, (n) => String(n.tagName).toLowerCase() === "nav")),
  },

  // ── Layer 4: error recovery (provoke a tool failure, verify self-correction). The Recovery axis
  // is the real signal here; `check` confirms the model still reached a valid goal state.
  // L4.2 (ambiguous "make it better"), L4.3 (kill server), L4.4 (rapid clicks) are human/browser-
  // only and are NOT seeded — they need qualitative judgement or the live UI. ──
  {
    id: "L4.1",
    prompt:
      "Add a child paragraph inside the heading (path ['children', 0]). " +
      "If the heading doesn't have a children array yet, handle that gracefully.",
    mustReadFirst: true,
    check: (d) =>
      anyNode(
        d,
        (n) =>
          String(n.tagName).toLowerCase() === "h1" &&
          Array.isArray(n.children) &&
          n.children.some((c) => String(c.tagName).toLowerCase() === "p"),
      ),
  },
  {
    id: "L4.5",
    prompt:
      "Add a paragraph saying 'recovered' at path ['children', 999], fixing the path if it is invalid",
    mustReadFirst: true,
    check: (d) => textOf(d).includes("recovered"),
  },

  // ── Layer 5: state & signals (advanced). Assertions check structural markers (state object,
  // $map/$switch) on the page or the written component. ──
  {
    id: "L5.1",
    prompt: "Create a counter component with + and − buttons that increment/decrement a number",
    check: (d, ctx) =>
      inAnyDoc(
        d,
        ctx,
        (c) => hasState(c) && anyNode(c, (n) => String(n.tagName).toLowerCase() === "button"),
      ),
  },
  {
    id: "L5.2",
    prompt:
      "Create a todo list component where you can type text and add items, with a delete button per item",
    // List rendering can surface as the $map item reference and/or the { $prototype: "Array", map }
    // construct — accept either, plus a state array to back the list.
    check: (d, ctx) =>
      inAnyDoc(
        d,
        ctx,
        (c) => hasState(c) && (hasMarker(c, "$map") || hasMarker(c, '"$prototype":"Array"')),
      ),
  },
  {
    id: "L5.3",
    prompt: "Create a tab switcher component with 3 tabs that show different content",
    check: (d, ctx) => inAnyDoc(d, ctx, (c) => hasState(c) && hasMarker(c, "$switch")),
  },
];

/** Wrap a streaming client so we can count model rounds (one streamChat call == one round). */
function countingClient(client) {
  let rounds = 0;
  return {
    rounds: () => rounds,
    async *streamChat(...args) {
      rounds += 1;
      yield* client.streamChat(...args);
    },
  };
}

/** Run a single test once on a fresh harness; returns the scored result. */
async function runOnce(test) {
  const fx = loadFixture();
  const harness = buildRealHarness(fx);
  const counter = countingClient(harness.client);
  harness.client = counter;
  try {
    await runPrompt(harness, test.prompt);
    if (harness.chatState.status === "error") {
      return { error: harness.chatState.error, rounds: counter.rounds() };
    }
    const ctx = { writes: fx.writes, readWritten: fx.readWritten };
    return await scoreRun({
      harness,
      rounds: counter.rounds(),
      check: test.check,
      ctx,
      mustReadFirst: test.mustReadFirst,
    });
  } finally {
    harness.dispose();
  }
}

/** Reduce N runs to the worst score per axis (§3.2: treat the worst run as the score). */
function worstOf(runs) {
  const scored = runs.filter((r) => !r.error);
  if (scored.length === 0) return { failed: true, runs };
  const axisKeys = Object.keys(scored[0].axes);
  const axes = {};
  for (const k of axisKeys) {
    let worst = scored[0].axes[k];
    for (const r of scored) if (r.axes[k].score < worst.score) worst = r.axes[k];
    axes[k] = worst;
  }
  const worstRounds = Math.max(...scored.map((r) => r.rounds));
  const readFirstViolated = scored.some((r) => r.readFirst && r.readFirst.ok === false);
  return {
    axes,
    rounds: worstRounds,
    samples: runs.length,
    errors: runs.filter((r) => r.error).length,
    model: scored[0].model,
    readFirstViolated,
  };
}

const A = (x) => (x?.na ? `${x.score}*` : String(x?.score ?? "?"));

function printRow(id, w) {
  if (w.failed) {
    console.log(`| ${id} | — | — | — | — | — | ALL RUNS ERRORED: ${w.runs[0]?.error ?? "?"} |`);
    return;
  }
  const { completeness: c, correctness: r, efficiency: e, recovery: v, undo: u } = w.axes;
  const errNote = w.errors ? ` (${w.errors}/${w.samples} runs errored)` : "";
  const readNote = w.readFirstViolated ? " ⚠ read-first violated" : "";
  console.log(
    `| ${id} | ${A(c)} | ${A(r)} | ${A(e)} | ${A(v)} | ${A(u)} | ${c.why}${readNote}${errNote} |`,
  );
}

async function main() {
  const ids = process.argv.slice(2);
  const selected = ids.length ? TESTS.filter((t) => ids.includes(t.id)) : TESTS;
  if (!selected.length) {
    console.error(`No matching tests. Known: ${TESTS.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }

  console.log(
    `\nHeadless eval — model=${process.env.JX_AI_MODEL || "gpt-5.4"}, runs/test=${RUNS_PER_TEST}, worst-run reported`,
  );
  console.log(
    `(\`*\` = N/A axis scored 5; Correctness ceiling + Undo seamless are browser-only — see studio)\n`,
  );
  console.log("| Test | C | R | E | V | U | Notes |");
  console.log("| ---- | - | - | - | - | - | ----- |");

  const full = {};
  for (const test of selected) {
    const runs = [];
    for (let i = 0; i < RUNS_PER_TEST; i++) runs.push(await runOnce(test));
    const w = worstOf(runs);
    full[test.id] = { worst: w, runs };
    printRow(test.id, w);
  }

  if (process.env.JX_AI_JSON) console.log("\n" + JSON.stringify(full, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
