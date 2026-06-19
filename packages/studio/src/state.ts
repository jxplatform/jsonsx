/// <reference lib="dom" />
/**
 * State.js — Builder state model and mutation API
 *
 * All state changes go through named mutation functions. State is immutable — every mutation
 * produces a new state object. History is a linear stack of { document, selection } snapshots.
 *
 * Path convention: [] = root document ['children', 0] = first child ['children', 0, 'children', 2]
 * = third child of first child
 */

import type { ProjectState } from "./types";
import { isRef } from "@jxsuite/schema/guards";
import type { JxMutableNode } from "@jxsuite/schema/types";

export type JxPath = (string | number)[];

interface HistorySnapshot {
  document: JxMutableNode;
  selection: JxPath | null;
}

export interface StudioState {
  document: JxMutableNode;
  selection: JxPath | null;
  hover: JxPath | null;
  history: HistorySnapshot[];
  historyIndex: number;
  dirty: boolean;
  fileHandle: FileSystemFileHandle | null;
  documentPath: string | null;
  documentStack: StudioStackFrame[];
  handlersSource: string | null;
  mode: string;
  content: { frontmatter: Record<string, unknown> };
  ui: Record<string, unknown>;
  canvas: {
    status: string;
    scope: Record<string, unknown> | null;
    error: string | null;
  };
}

interface StudioStackFrame {
  document: JxMutableNode;
  selection: JxPath | null;
  fileHandle: FileSystemFileHandle | null;
  documentPath: string | null;
  dirty: boolean;
  history: HistorySnapshot[];
  historyIndex: number;
  mode: string;
}

// ─── Path utilities ───────────────────────────────────────────────────────────

/**
 * Walk the document tree and return the node at the given path.
 *
 * @param {JxMutableNode} doc
 * @param {JxPath} path
 * @returns {JxMutableNode}
 */
export function getNodeAtPath(doc: JxMutableNode, path: JxPath) {
  let node = doc;
  for (const key of path) {
    if (node == null) {
      return undefined as unknown as JxMutableNode;
    }
    // Paths address nodes by construction; non-node leaves surface as undefined above.
    node = node[key] as JxMutableNode;
  }
  return node;
}

/**
 * The node's children when they are a static array (the edit-mode invariant); an empty array for
 * mapped-array or absent children.
 *
 * @param {JxMutableNode | null | undefined} node
 * @returns {(JxMutableNode | string)[]}
 */
export function childList(node: JxMutableNode | null | undefined): (JxMutableNode | string)[] {
  return Array.isArray(node?.children) ? node.children : [];
}

/**
 * Normalize a document in place to the canonical array-member form: a legacy whole-children
 * repeater (`children: { $prototype: "Array", … }`) becomes a single member of a children array
 * (`children: [{ $prototype: "Array", … }]`). Recurses through children, repeater templates, and
 * `$switch` cases. Runs once when a document is loaded into a tab so every in-studio doc — and its
 * history checkpoints — uses the member form before any mutation.
 *
 * @param {unknown} node
 * @returns {unknown} The same node (mutated)
 */
export function normalizeArrayChildren(node: unknown): unknown {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      normalizeArrayChildren(child);
    }
    return node;
  }
  const n = node as JxMutableNode;
  const { children } = n;
  if (
    children &&
    typeof children === "object" &&
    !Array.isArray(children) &&
    (children as JxMutableNode).$prototype === "Array"
  ) {
    n.children = [children as JxMutableNode];
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) {
      normalizeArrayChildren(child);
    }
  }
  if (n.$prototype === "Array" && n.map && typeof n.map === "object") {
    normalizeArrayChildren(n.map);
  }
  if (n.cases && typeof n.cases === "object") {
    for (const caseDef of Object.values(n.cases)) {
      normalizeArrayChildren(caseDef);
    }
  }
  return node;
}

/**
 * Return the path to the parent element (strips trailing 'children' + index).
 *
 * @param {JxPath} path
 * @returns {JxPath | null}
 */
export function parentElementPath(path: JxPath) {
  return path.length >= 2 ? path.slice(0, -2) : null;
}

/**
 * Return the child index (last segment of the path).
 *
 * @param {JxPath} path
 * @returns {string | number}
 */
export function childIndex(path: JxPath) {
  return path.at(-1);
}

/**
 * Serialize a path to a string key for Map lookups.
 *
 * @param {JxPath} path
 * @returns {string}
 */
export function pathKey(path: JxPath) {
  return path.join("/");
}

/**
 * Compare two paths for equality.
 *
 * @param {JxPath | null} a
 * @param {JxPath | null} b
 * @returns {boolean}
 */
export function pathsEqual(a: JxPath | null, b: JxPath | null) {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every((v, i) => v === b[i]);
}

/**
 * Returns true if `path` is an ancestor of (or equal to) `descendant`.
 *
 * @param {JxPath} path
 * @param {JxPath} descendant
 * @returns {boolean}
 */
export function isAncestor(path: JxPath, descendant: JxPath) {
  if (path.length > descendant.length) {
    return false;
  }
  return path.every((v, i) => v === descendant[i]);
}

// ─── Tree flattening (for layer panel) ────────────────────────────────────────

/**
 * Flatten a Jx document into an array of { node, path, depth, nodeType } rows. Walks static
 * children arrays, $map templates, and $switch cases.
 *
 * NodeType: 'element' (default) | 'map' | 'case' | 'case-ref'
 *
 * @param {JxMutableNode | string | number | boolean} doc
 * @param {JxPath} [path]
 * @param {number} [depth]
 * @returns {{
 *   node: JxMutableNode | string | number | boolean;
 *   path: JxPath;
 *   depth: number;
 *   nodeType: string;
 * }[]}
 */
export interface FlatRow {
  node: JxMutableNode | string | number | boolean;
  path: JxPath;
  depth: number;
  nodeType: string;
}

export function flattenTree(
  doc: JxMutableNode | string | number | boolean,
  path: JxPath = [],
  depth = 0,
): FlatRow[] {
  // Text node children: bare primitives get a "text" row
  if (typeof doc === "string" || typeof doc === "number" || typeof doc === "boolean") {
    return [{ depth, node: doc, nodeType: "text", path }];
  }

  // Array pseudo-element (repeater): a first-class node at its own path. Emit the "map" row, then
  // Recurse into its single template at `[...path, "map"]`. This is reached both when the array is
  // A member of a children array (path `[…, "children", i]`) and the legacy whole-children form
  // (path `[…, "children"]`).
  if ((doc as JxMutableNode).$prototype === "Array") {
    const rows: FlatRow[] = [{ depth, node: doc, nodeType: "map", path }];
    const mapDef = (doc as JxMutableNode).map;
    if (mapDef && typeof mapDef === "object") {
      rows.push(...flattenTree(mapDef as JxMutableNode, [...path, "map"], depth + 1));
    }
    return rows;
  }

  const rows: FlatRow[] = [{ depth, node: doc, nodeType: "element", path }];

  // Custom component instances without user-authored children are atomic in the layer tree
  if (doc.$props && (doc.tagName || "").includes("-") && !Array.isArray(doc.children)) {
    return rows;
  }

  const { children } = doc;

  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const childPath = [...path, "children", i];
      rows.push(...flattenTree(children[i]!, childPath, depth + 1));
    }
  } else if (
    children &&
    typeof children === "object" &&
    (children as JxMutableNode).$prototype === "Array"
  ) {
    // Legacy whole-children repeater: the array occupies the children slot itself.
    rows.push(...flattenTree(children as JxMutableNode, [...path, "children"], depth + 1));
  }

  // $switch — emit each case as a virtual child
  if (doc.$switch && doc.cases && typeof doc.cases === "object") {
    for (const [caseName, caseDef] of Object.entries(doc.cases)) {
      const casePath = [...path, "cases", caseName];
      if (caseDef && typeof caseDef === "object" && (caseDef as JxMutableNode).$ref) {
        rows.push({
          depth: depth + 1,
          node: caseDef as JxMutableNode,
          nodeType: "case-ref",
          path: casePath,
        });
      } else if (caseDef && typeof caseDef === "object") {
        rows.push({
          depth: depth + 1,
          node: caseDef as JxMutableNode,
          nodeType: "case",
          path: casePath,
        });
        // Recurse into case children (skip the case node itself — already emitted)
        const caseChildren = flattenTree(caseDef as JxMutableNode, casePath, depth + 2);
        rows.push(...caseChildren.slice(1));
      }
    }
  }

  return rows;
}

/**
 * Get a display label for a node (for layers + overlays).
 *
 * @param {JxMutableNode | null} node
 * @returns {string}
 */
export function nodeLabel(node: JxMutableNode | null) {
  if (!node) {
    return "?";
  }
  // $map container (Repeater)
  if (node.$prototype === "Array") {
    const { items } = node;
    const ref = (isRef(items) ? items.$ref : undefined) || "items";
    return `Repeater → ${ref}`;
  }
  if (node.$title) {
    return node.$title;
  }
  if (node.$id) {
    return node.$id;
  }
  if (node.tagName === "slot") {
    const name = node.attributes?.name;
    return typeof name === "string" && name.trim() ? `slot: ${name.trim()}` : "slot";
  }
  const tag = node.tagName ?? "div";
  const suffix = node.$switch ? " ⇆" : "";
  if (typeof node.textContent === "string" && node.textContent.length > 0) {
    return `${tag} — ${node.textContent.slice(0, 24)}${suffix}`;
  }
  return tag + suffix;
}

// ─── State factory ────────────────────────────────────────────────────────────

/**
 * @param {JxMutableNode} doc
 * @returns {StudioState}
 */
export function createState(doc: JxMutableNode): StudioState {
  const initial = { document: doc, selection: null };
  return {
    canvas: {
      error: null, // Error message on failure
      scope: null, // $defs scope from runtime buildScope
      status: "idle", // "idle" | "loading" | "ready" | "error"
    },
    content: { frontmatter: {} }, // Frontmatter metadata for .md files
    dirty: false,
    document: doc,
    documentPath: null, // Root-relative path, e.g. "examples/markdown/blog.json"
    documentStack: [], // Frames for component navigation
    fileHandle: null,
    handlersSource: null,
    history: [initial],
    historyIndex: 0,
    hover: null,
    mode: "component", // 'component' | 'content'
    selection: null,
    ui: {
      activeMedia: null, // '--md' | null (base) — focused canvas/breakpoint
      activeSelector: null, // ':hover' | '.child' | null (base) — nested selector context
      editingFunction: null, // Null | { type: 'def', defName } | { type: 'event', path, eventKey }
      featureToggles: {}, // { '--dark': true } — non-size media toggles
      gitBranches: null, // { current, branches: [] }
      gitCommitMessage: "", // Commit message input
      gitDiffState: null,
      gitError: null, // Error message string
      gitLoading: false, // Loading indicator during async ops
      gitStatus: null, // { branch, ahead, behind, files: [] }
      inspectorSections: {}, // { identity: true, ... } — properties panel section open/closed state
      pendingInlineEdit: null, // Null | { path, mediaName } — deferred inline edit awaiting canvas readiness
      rightTab: "properties", // 'properties' | 'events' | 'style'
      settingsTab: "stylebook", // "stylebook" | "definitions" | "contentTypes"
      styleFilter: "", // Free-text filter for CSS property names
      styleFilterActive: false, // True = show only props with values set
      styleSections: {}, // { layout: true, ... } — section open/closed state
      styleShorthands: {}, // { padding: true, ... } — shorthand expand/collapse state
      stylebookCustomizedOnly: false, // Show only customized elements
      stylebookFilter: "", // Search filter text
      stylebookSelection: null, // Tag name string, e.g. "h1"
      stylebookTab: "elements", // "elements" | "variables"
      zoom: 1,
    },
  };
}

// ─── Doc/Session slice helpers ───────────────────────────────────────────────

/**
 * Compose a flat StudioState from separate doc and session slices.
 *
 * @param {Partial<StudioState>} doc
 * @param {Partial<StudioState>} session
 * @returns {StudioState}
 */
export function toFlat(doc: Partial<StudioState>, session: Partial<StudioState>) {
  return { ...doc, ...session } as StudioState;
}

/**
 * Decompose a flat StudioState into doc and session slices.
 *
 * @param {StudioState} S
 * @returns {{ doc: Partial<StudioState>; session: Partial<StudioState> }}
 */
export function fromFlat(S: StudioState) {
  const {
    document,
    dirty,
    fileHandle,
    documentPath,
    documentStack,
    handlersSource,
    mode,
    content,
    history,
    historyIndex,
    selection,
    hover,
    ui,
    canvas,
  } = S;
  return {
    doc: {
      content,
      dirty,
      document,
      documentPath,
      documentStack,
      fileHandle,
      handlersSource,
      history,
      historyIndex,
      mode,
    },
    session: { canvas, hover, selection, ui },
  };
}

// ─── Project state (persists across document switches) ────────────────────────
//
// Shape: { root, name, projectRoot, isSiteProject, projectConfig,
//          Dirs: Map<string, DirEntry[]>, expanded: Set<string>,
//          SelectedPath: string|null, searchQuery: string }
// DirEntry: { name, path, type: "file"|"directory", size, modified }

export let projectState: ProjectState | null = null;

/** @param {ProjectState | null} ps */
export function setProjectState(ps: ProjectState | null) {
  projectState = ps;
}

/**
 * Return the current project state, asserting it is non-null. Only call when a project is known to
 * be loaded.
 *
 * @returns {ProjectState}
 */
export function requireProjectState() {
  return projectState as ProjectState;
}

// ─── Frontmatter mutation ───────────────────────────────────────────────────

/**
 * Update a frontmatter field. Does not use applyMutation because frontmatter lives in S.content,
 * not S.document.
 *
 * @param {StudioState} state
 * @param {string} field
 * @param {unknown} value
 * @returns {StudioState}
 */
export function updateFrontmatter(state: StudioState, field: string, value: unknown) {
  const fm = { ...state.content?.frontmatter };
  if (value === undefined || value === null || value === "") {
    delete fm[field];
  } else {
    fm[field] = value;
  }
  return {
    ...state,
    content: { ...state.content, frontmatter: fm },
    dirty: true,
  };
}

// ─── Selection / hover ────────────────────────────────────────────────────────

/**
 * @param {StudioState} state
 * @param {JxPath | null} path
 * @returns {StudioState}
 */
export function selectNode(state: StudioState, path: JxPath | null) {
  return { ...state, selection: path };
}

/**
 * @param {StudioState} state
 * @param {JxPath | null} path
 * @returns {StudioState}
 */
export function hoverNode(state: StudioState, path: JxPath | null) {
  return { ...state, hover: path };
}

// ─── Document stack (component navigation) ──────────────────────────────────

/**
 * Push current document onto the stack and switch to editing a new document.
 *
 * @param {StudioState} state
 * @param {JxMutableNode} doc
 * @param {string | null} documentPath
 * @returns {StudioState}
 */
export function pushDocument(state: StudioState, doc: JxMutableNode, documentPath: string | null) {
  const frame = {
    dirty: state.dirty,
    document: state.document,
    documentPath: state.documentPath,
    fileHandle: state.fileHandle,
    history: state.history,
    historyIndex: state.historyIndex,
    mode: state.mode,
    selection: state.selection,
  };
  const newState = createState(doc);
  newState.documentStack = [...(state.documentStack || []), frame];
  newState.documentPath = documentPath;
  newState.ui = { ...state.ui, activeMedia: null, activeSelector: null };
  return newState;
}

/**
 * Pop the document stack and return to the previous document.
 *
 * @param {StudioState} state
 * @returns {StudioState}
 */
export function popDocument(state: StudioState) {
  if (!state.documentStack || state.documentStack.length === 0) {
    return state;
  }
  const stack = [...state.documentStack];
  const frame = stack.pop();
  return {
    ...state,
    ...frame,
    documentStack: stack,
    ui: { ...state.ui },
  };
}
