/// <reference lib="dom" />
// oxlint-disable unicorn/no-thenable -- `then` is the JSON Schema conditional keyword (spec §20), not a promise
/**
 * Statement editor (spec §20) — vertical statement-card list for structured function bodies.
 *
 * Renders a Function entry's `body: JxStatement[]` as cards on a connector line: bare expression
 * nodes (mutation or `call`), `if`/`then`/`else` branches, `$switch`/`cases` multiway branches, and
 * WHATWG `dispatchEvent` statements. Branch bodies render as indented lanes (the expression
 * editor's `border-left` nesting idiom) with their own add-statement pickers. Cards drag-reorder
 * within their lane via the pragmatic-drag-and-drop tree-item pattern (see panels/dnd.ts). All
 * edits flow through `onChange(next)` immutably — no statement object is mutated in place.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { ref } from "lit-html/directives/ref.js";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { disableNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview";
import {
  attachInstruction,
  extractInstruction,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item";
import { isJsonObject } from "@jxsuite/schema/guards";
import { renderExpressionEditor, renderOperandEditor } from "../ui/expression-editor";
import { renderFieldRow } from "../ui/field-row";

import type {
  CemEvent,
  JxDispatchStatement,
  JxIfStatement,
  JxStatement,
  JxStateDefinition,
  JxSwitchStatement,
} from "@jxsuite/schema/types";
import type { TemplateResult } from "lit-html";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface StatementEditorOpts {
  stateDefs: string[];
  stateEntries?: Record<string, JxStateDefinition> | null;
  allowEventRef: boolean;
  /** The entry's declared CEM events — offered as dispatchEvent name completions. */
  emits?: CemEvent[];
}

/**
 * A lane address inside the statement tree: alternating [index, branchKey] steps, where a `cases`
 * step consumes three entries ([index, "cases", caseKey]). The empty path is the top-level
 * statement list.
 */
type LanePath = (string | number)[];

// ─── Statement Kind Detection ────────────────────────────────────────────────

/** Discriminate a statement's kind, mirroring the runtime's detection order (spec §20.2). */
export function statementKind(stmt: unknown): "expression" | "if" | "switch" | "dispatch" {
  if (isJsonObject(stmt)) {
    if ("operator" in stmt) {
      return "expression";
    }
    if ("if" in stmt) {
      return "if";
    }
    if ("$switch" in stmt) {
      return "switch";
    }
    if ("dispatchEvent" in stmt) {
      return "dispatch";
    }
  }
  return "expression";
}

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/="]);

/** Card header label — ECMA/WHATWG naming (spec §20.2). */
function kindLabel(stmt: unknown): string {
  switch (statementKind(stmt)) {
    case "if": {
      return "If / Else";
    }
    case "switch": {
      return "Switch";
    }
    case "dispatch": {
      return "Dispatch event";
    }
    default: {
      const op = isJsonObject(stmt) ? String(stmt.operator ?? "") : "";
      if (ASSIGN_OPS.has(op)) {
        return "Set state";
      }
      if (op === "call") {
        return "Call";
      }
      return "Expression";
    }
  }
}

// ─── Add-statement Seeds (spec §20 shapes) ───────────────────────────────────

const STATEMENT_SEEDS: Record<string, () => JxStatement> = {
  call: () => ({ operator: "call", target: { $ref: "" }, value: [] }),
  dispatch: () => ({ dispatchEvent: "" }),
  if: () => ({
    if: { operator: "===", target: { $ref: "" }, value: null },
    then: [],
  }),
  set: () => ({ operator: "=", target: { $ref: "" }, value: null }),
  switch: () => ({ $switch: { $ref: "" }, cases: {} }),
};

// ─── Lane Addressing (immutable read/write through nested statement lists) ───

/** Resolve the statement list a lane path points at; null when the path is stale. */
export function laneListAt(list: JxStatement[], path: LanePath): JxStatement[] | null {
  if (path.length === 0) {
    return list;
  }
  const [idx, key] = path;
  const stmt = typeof idx === "number" ? (list[idx] as Record<string, unknown> | undefined) : null;
  if (!isJsonObject(stmt) || typeof key !== "string") {
    return null;
  }
  if (key === "cases") {
    const caseKey = path.at(2);
    const { cases } = stmt;
    if (typeof caseKey !== "string" || !isJsonObject(cases) || !Array.isArray(cases[caseKey])) {
      return null;
    }
    return laneListAt(cases[caseKey] as unknown as JxStatement[], path.slice(3));
  }
  if (!Array.isArray(stmt[key])) {
    return null;
  }
  return laneListAt(stmt[key] as unknown as JxStatement[], path.slice(2));
}

/** Rebuild the statement tree with the lane at `path` replaced by `next` — fully immutable. */
export function withLaneList(
  list: JxStatement[],
  path: LanePath,
  next: JxStatement[],
): JxStatement[] {
  if (path.length === 0) {
    return next;
  }
  const idx = path[0] as number;
  const key = path[1] as string;
  const stmt = list[idx] as unknown as Record<string, unknown>;
  let updated: Record<string, unknown>;
  if (key === "cases") {
    const caseKey = path[2] as string;
    const cases = { ...(stmt.cases as Record<string, JxStatement[]>) };
    cases[caseKey] = withLaneList(cases[caseKey] ?? [], path.slice(3), next);
    updated = { ...stmt, cases };
  } else {
    updated = {
      ...stmt,
      [key]: withLaneList((stmt[key] as JxStatement[] | undefined) ?? [], path.slice(2), next),
    };
  }
  return list.map((s, i) => (i === idx ? (updated as unknown as JxStatement) : s));
}

// ─── Drag-reorder (pragmatic-drag-and-drop, per-lane) ────────────────────────

/** Active DnD registration cleanup per editor root — replaced on every re-render. */
const dndRegistrations = new WeakMap<HTMLElement, () => void>();

/**
 * Register drag-reorder on all statement rows under `root` (post-render, like registerLayersDnD).
 * Rows may only reorder within their own lane — the source's lane id must match the target's.
 */
function registerStatementsDnD(
  root: HTMLElement,
  statements: JxStatement[],
  onChange: (next: JxStatement[]) => void,
) {
  requestAnimationFrame(async () => {
    // Deferred adapter import — keeps this panel's import graph adapter-free at module load.
    const { draggable, dropTargetForElements } =
      await import("@atlaskit/pragmatic-drag-and-drop/element/adapter");
    dndRegistrations.get(root)?.();
    const cleanups: (() => void)[] = [];

    for (const row of root.querySelectorAll("[data-stmt-row]") as NodeListOf<HTMLElement>) {
      const laneId = row.dataset.stmtLane ?? "[]";
      const index = Math.trunc(Number(row.dataset.stmtIndex)) || 0;
      const handle = row.querySelector(".statement-drag-handle");

      cleanups.push(
        combine(
          draggable({
            element: row,
            ...(handle ? { dragHandle: handle } : {}),
            getInitialData() {
              return { index, lane: laneId, type: "statement" };
            },
            onGenerateDragPreview({
              nativeSetDragImage,
            }: {
              nativeSetDragImage: ((image: Element, x: number, y: number) => void) | null;
            }) {
              disableNativeDragPreview({ nativeSetDragImage });
            },
            onDragStart() {
              row.classList.add("dragging");
            },
            onDrop() {
              row.classList.remove("dragging");
            },
          }),
          dropTargetForElements({
            element: row,
            canDrop({ source }: { source: { data: Record<string, unknown> } }) {
              return source.data.type === "statement" && source.data.lane === laneId;
            },
            getData({
              input,
              element,
            }: {
              input: Parameters<typeof attachInstruction>[1]["input"];
              element: Element;
            }) {
              return attachInstruction(
                { index },
                {
                  block: ["make-child"],
                  currentLevel: 0,
                  element,
                  indentPerLevel: 16,
                  input,
                  mode: "standard",
                },
              ) as Record<string | symbol, unknown>;
            },
            onDrag({ self }: { self: { data: Record<string, unknown> } }) {
              const instruction = extractInstruction(self.data);
              row.classList.toggle("drop-above", instruction?.type === "reorder-above");
              row.classList.toggle("drop-below", instruction?.type === "reorder-below");
            },
            onDragLeave() {
              row.classList.remove("drop-above", "drop-below");
            },
            onDrop({
              self,
              source,
            }: {
              self: { data: Record<string, unknown> };
              source: { data: Record<string, unknown> };
            }) {
              row.classList.remove("drop-above", "drop-below");
              const instruction = extractInstruction(self.data);
              if (
                !instruction ||
                (instruction.type !== "reorder-above" && instruction.type !== "reorder-below")
              ) {
                return;
              }
              const from = source.data.index as number;
              const lanePath = JSON.parse(laneId) as LanePath;
              const lane = laneListAt(statements, lanePath);
              if (!lane || from === index) {
                return;
              }
              let insertAt = instruction.type === "reorder-above" ? index : index + 1;
              if (from < insertAt) {
                insertAt -= 1;
              }
              if (insertAt === from) {
                return;
              }
              const nextLane = lane.filter((_, i) => i !== from);
              nextLane.splice(insertAt, 0, lane[from]!);
              onChange(withLaneList(statements, lanePath, nextLane));
            },
          }),
        ),
      );
    }

    dndRegistrations.set(root, () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    });
  });
}

// ─── Small shared widgets ────────────────────────────────────────────────────

const laneLabelStyle =
  "font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--spectrum-gray-600, #808080)";

function operandOpts(opts: StatementEditorOpts) {
  return {
    allowEventRef: opts.allowEventRef,
    depth: 0,
    stateDefs: opts.stateDefs,
    stateEntries: opts.stateEntries ?? null,
  };
}

/** The "+ Add statement" picker appended to every lane. */
function renderAddStatement(
  list: JxStatement[],
  commit: (next: JxStatement[]) => void,
): TemplateResult {
  return html`
    <sp-picker
      size="s"
      quiet
      class="statement-add"
      label="+ Add statement"
      placeholder="+ Add statement"
      .value=${live("")}
      @change=${(e: Event) => {
        const kind = (e.target as HTMLInputElement).value;
        const seed = STATEMENT_SEEDS[kind];
        if (!seed) {
          return;
        }
        (e.target as HTMLInputElement).value = "";
        commit([...list, seed()]);
      }}
    >
      <sp-menu-item value="set">Set state</sp-menu-item>
      <sp-menu-item value="call">Call function</sp-menu-item>
      <sp-menu-item value="if">If / Else</sp-menu-item>
      <sp-menu-item value="switch">Switch</sp-menu-item>
      <sp-menu-item value="dispatch">Dispatch event</sp-menu-item>
    </sp-picker>
  `;
}

/** An indented branch lane: header label (+ optional remove) above a nested statement list. */
function renderLane(
  label: string | TemplateResult,
  list: JxStatement[],
  commit: (next: JxStatement[]) => void,
  opts: StatementEditorOpts,
  lanePath: LanePath,
  extras: { onRemove?: () => void } = {},
): TemplateResult {
  return html`
    <div class="statement-lane" style="margin:4px 0 4px 6px">
      <div class="statement-lane-header" style="display:flex;align-items:center;gap:4px">
        <span style=${laneLabelStyle}>${label}</span>
        ${extras.onRemove
          ? html`
              <sp-action-button
                quiet
                size="xs"
                class="statement-lane-remove"
                title="Remove branch"
                @click=${extras.onRemove}
              >
                <sp-icon-delete slot="icon"></sp-icon-delete>
              </sp-action-button>
            `
          : nothing}
      </div>
      ${renderStatementList(list, commit, opts, lanePath)}
    </div>
  `;
}

// ─── Kind-specific card bodies ───────────────────────────────────────────────

function renderIfBody(
  stmt: JxIfStatement,
  commit: (next: JxStatement) => void,
  opts: StatementEditorOpts,
  lanePath: LanePath,
  index: number,
): TemplateResult {
  return html`
    ${renderFieldRow({
      hasValue: false,
      label: "If",
      prop: "if",
      widget: renderOperandEditor(
        stmt.if,
        (v) => commit({ ...stmt, if: v } as JxStatement),
        operandOpts(opts),
      ),
    })}
    ${renderLane("Then", stmt.then ?? [], (next) => commit({ ...stmt, then: next }), opts, [
      ...lanePath,
      index,
      "then",
    ])}
    ${Array.isArray(stmt.else)
      ? renderLane(
          "Else",
          stmt.else,
          (next) => commit({ ...stmt, else: next }),
          opts,
          [...lanePath, index, "else"],
          {
            onRemove: () => {
              const { else: _else, ...rest } = stmt;
              commit(rest as JxStatement);
            },
          },
        )
      : html`
          <sp-action-button
            quiet
            size="s"
            class="statement-add-else"
            @click=${() => commit({ ...stmt, else: [] })}
          >
            + Add else
          </sp-action-button>
        `}
  `;
}

function renderSwitchBody(
  stmt: JxSwitchStatement,
  commit: (next: JxStatement) => void,
  opts: StatementEditorOpts,
  lanePath: LanePath,
  index: number,
): TemplateResult {
  const cases = isJsonObject(stmt.cases) ? (stmt.cases as Record<string, JxStatement[]>) : {};
  const entries = Object.entries(cases);
  const setCases = (next: Record<string, JxStatement[]>) =>
    commit({ ...stmt, cases: next } as JxStatement);

  return html`
    ${renderFieldRow({
      hasValue: false,
      label: "Switch on",
      prop: "$switch",
      widget: renderOperandEditor(
        stmt.$switch,
        (v) => commit({ ...stmt, $switch: v } as JxStatement),
        operandOpts(opts),
      ),
    })}
    ${entries.map(([key, list]) =>
      renderLane(
        html`
          <sp-textfield
            size="s"
            class="statement-case-key"
            style="width:96px"
            placeholder="value"
            .value=${live(key)}
            @change=${(e: Event) => {
              const newKey = (e.target as HTMLInputElement).value;
              if (newKey === key) {
                return;
              }
              const next: Record<string, JxStatement[]> = {};
              for (const [k, v] of entries) {
                next[k === key ? newKey : k] = v;
              }
              setCases(next);
            }}
          ></sp-textfield>
        `,
        Array.isArray(list) ? list : [],
        (next) => setCases({ ...cases, [key]: next }),
        opts,
        [...lanePath, index, "cases", key],
        {
          onRemove: () => {
            const next = { ...cases };
            delete next[key];
            setCases(next);
          },
        },
      ),
    )}
    ${renderLane(
      "Default",
      Array.isArray(stmt.default) ? stmt.default : [],
      (next) => {
        if (next.length === 0) {
          const { default: _default, ...rest } = stmt;
          commit(rest as JxStatement);
          return;
        }
        commit({ ...stmt, default: next } as JxStatement);
      },
      opts,
      [...lanePath, index, "default"],
    )}
    <sp-action-button
      quiet
      size="s"
      class="statement-add-case"
      @click=${() => {
        let n = entries.length + 1;
        let key = `case ${n}`;
        while (Object.hasOwn(cases, key)) {
          n += 1;
          key = `case ${n}`;
        }
        setCases({ ...cases, [key]: [] });
      }}
    >
      + Add case
    </sp-action-button>
  `;
}

function renderDispatchBody(
  stmt: JxDispatchStatement,
  commit: (next: JxStatement) => void,
  opts: StatementEditorOpts,
): TemplateResult {
  const emitNames = (opts.emits ?? [])
    .map((e) => e.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  const commitName = (e: Event) =>
    commit({ ...stmt, dispatchEvent: (e.target as HTMLInputElement).value } as JxStatement);
  const toggle = (key: "bubbles" | "composed") => (e: Event) => {
    const { checked } = e.target as HTMLInputElement;
    const { [key]: _removed, ...rest } = stmt;
    commit((checked ? { ...rest, [key]: true } : rest) as JxStatement);
  };

  return html`
    ${renderFieldRow({
      hasValue: false,
      label: "Event",
      prop: "dispatchEvent",
      widget:
        emitNames.length > 0
          ? html`
              <sp-combobox
                size="s"
                allows-custom-value
                class="statement-dispatch-name"
                style="flex:1"
                .value=${live(stmt.dispatchEvent ?? "")}
                @change=${commitName}
              >
                ${emitNames.map((n) => html`<sp-menu-item value=${n}>${n}</sp-menu-item>`)}
              </sp-combobox>
            `
          : html`
              <sp-textfield
                size="s"
                class="statement-dispatch-name"
                style="flex:1"
                placeholder="event-name"
                .value=${live(stmt.dispatchEvent ?? "")}
                @input=${commitName}
              ></sp-textfield>
            `,
    })}
    ${renderFieldRow({
      hasValue: false,
      label: "Detail",
      prop: "detail",
      widget: renderOperandEditor(
        stmt.detail ?? null,
        (v) => commit({ ...stmt, detail: v } as JxStatement),
        operandOpts(opts),
      ),
    })}
    ${renderFieldRow({
      hasValue: false,
      label: "Options",
      prop: "eventInit",
      widget: html`
        <div style="display:flex;gap:12px;align-items:center">
          <sp-checkbox
            size="s"
            class="statement-dispatch-bubbles"
            ?checked=${Boolean(stmt.bubbles)}
            @change=${toggle("bubbles")}
            >Bubbles</sp-checkbox
          >
          <sp-checkbox
            size="s"
            class="statement-dispatch-composed"
            ?checked=${Boolean(stmt.composed)}
            @change=${toggle("composed")}
            >Composed</sp-checkbox
          >
        </div>
      `,
    })}
  `;
}

// ─── Statement Card + List ───────────────────────────────────────────────────

function renderStatementCard(
  stmt: JxStatement,
  index: number,
  list: JxStatement[],
  commitList: (next: JxStatement[]) => void,
  opts: StatementEditorOpts,
  lanePath: LanePath,
): TemplateResult {
  const kind = statementKind(stmt);
  const commit = (next: JxStatement) => commitList(list.map((s, i) => (i === index ? next : s)));

  let body: TemplateResult;
  switch (kind) {
    case "if": {
      body = renderIfBody(stmt as JxIfStatement, commit, opts, lanePath, index);
      break;
    }
    case "switch": {
      body = renderSwitchBody(stmt as JxSwitchStatement, commit, opts, lanePath, index);
      break;
    }
    case "dispatch": {
      body = renderDispatchBody(stmt as JxDispatchStatement, commit, opts);
      break;
    }
    default: {
      body = renderExpressionEditor(stmt, (n) => commit(n as JxStatement), {
        allowEventRef: opts.allowEventRef,
        stateDefs: opts.stateDefs,
        stateEntries: opts.stateEntries ?? null,
      });
      break;
    }
  }

  return html`
    <div
      class="statement-card"
      data-stmt-row
      data-stmt-kind=${kind}
      data-stmt-lane=${JSON.stringify(lanePath)}
      data-stmt-index=${index}
      style="border:1px solid var(--spectrum-gray-300, #3c3c3c);border-radius:4px;padding:4px 6px;margin:0 0 6px;background:var(--spectrum-gray-75, #1e1e1e)"
    >
      <div class="statement-card-header" style="display:flex;align-items:center;gap:6px">
        <span
          class="statement-drag-handle"
          title="Drag to reorder"
          style="cursor:grab;color:var(--spectrum-gray-500, #6e6e6e);font-size:11px;line-height:1;user-select:none"
          >⠿</span
        >
        <span class="statement-kind-label" style=${laneLabelStyle}>${kindLabel(stmt)}</span>
        <span style="flex:1"></span>
        <sp-action-button
          quiet
          size="xs"
          class="statement-delete"
          title="Delete statement"
          @click=${() => commitList(list.filter((_, i) => i !== index))}
        >
          <sp-icon-delete slot="icon"></sp-icon-delete>
        </sp-action-button>
      </div>
      <div class="statement-card-body">${body}</div>
    </div>
  `;
}

/** One lane's vertical card list on its connector line, ending in the add-statement picker. */
function renderStatementList(
  list: JxStatement[],
  commitList: (next: JxStatement[]) => void,
  opts: StatementEditorOpts,
  lanePath: LanePath,
): TemplateResult {
  return html`
    <div
      class="statement-list"
      style="margin-left:4px;border-left:2px solid var(--spectrum-gray-300, #3c3c3c);padding:2px 0 0 8px"
    >
      ${list.map((stmt, index) =>
        renderStatementCard(stmt, index, list, commitList, opts, lanePath),
      )}
      ${renderAddStatement(list, commitList)}
    </div>
  `;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Render a structured function body (spec §20) as an editable statement-card list. `onChange`
 * receives a fresh statement array on every edit; the input array is never mutated.
 */
export function renderStatementEditor(
  statements: JxStatement[],
  onChange: (next: JxStatement[]) => void,
  opts: StatementEditorOpts,
): TemplateResult {
  const safe = Array.isArray(statements) ? statements : [];
  return html`
    <div
      class="statement-editor"
      ${ref((el) => {
        if (el) {
          registerStatementsDnD(el as HTMLElement, safe, onChange);
        }
      })}
    >
      ${renderStatementList(safe, onChange, opts, [])}
    </div>
  `;
}
