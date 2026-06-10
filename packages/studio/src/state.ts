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
    if (node == null) return undefined as unknown as JxMutableNode;
    node = node[key];
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
  return path[path.length - 1];
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
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
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
  if (path.length > descendant.length) return false;
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
export type FlatRow = {
  node: JxMutableNode | string | number | boolean;
  path: JxPath;
  depth: number;
  nodeType: string;
};

export function flattenTree(
  doc: JxMutableNode | string | number | boolean,
  path: JxPath = [],
  depth: number = 0,
): FlatRow[] {
  // Text node children: bare primitives get a "text" row
  if (typeof doc === "string" || typeof doc === "number" || typeof doc === "boolean") {
    return [{ node: doc, path, depth, nodeType: "text" }];
  }

  const rows: FlatRow[] = [{ node: doc, path, depth, nodeType: "element" }];

  // Custom component instances without user-authored children are atomic in the layer tree
  if (doc.$props && (doc.tagName || "").includes("-") && !Array.isArray(doc.children)) {
    return rows;
  }

  const children = doc.children;

  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const childPath = [...path, "children", i];
      rows.push(...flattenTree(children[i], childPath, depth + 1));
    }
  } else if (
    children &&
    typeof children === "object" &&
    (children as JxMutableNode).$prototype === "Array"
  ) {
    // $map — emit the map container, then recurse into the template
    rows.push({
      node: children as JxMutableNode,
      path: [...path, "children"],
      depth: depth + 1,
      nodeType: "map",
    });
    const mapDef = (children as JxMutableNode).map;
    if (mapDef && typeof mapDef === "object") {
      rows.push(...flattenTree(mapDef as JxMutableNode, [...path, "children", "map"], depth + 2));
    }
  }

  // $switch — emit each case as a virtual child
  if (doc.$switch && doc.cases && typeof doc.cases === "object") {
    for (const [caseName, caseDef] of Object.entries(doc.cases)) {
      const casePath = [...path, "cases", caseName];
      if (caseDef && typeof caseDef === "object" && (caseDef as JxMutableNode).$ref) {
        rows.push({
          node: caseDef as JxMutableNode,
          path: casePath,
          depth: depth + 1,
          nodeType: "case-ref",
        });
      } else if (caseDef && typeof caseDef === "object") {
        rows.push({
          node: caseDef as JxMutableNode,
          path: casePath,
          depth: depth + 1,
          nodeType: "case",
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
  if (!node) return "?";
  // $map container (Repeater)
  if (node.$prototype === "Array") {
    const ref = node.items?.$ref || "items";
    return `Repeater → ${ref}`;
  }
  if (node.$title) return node.$title;
  if (node.$id) return node.$id;
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
    document: doc,
    selection: null,
    hover: null,
    history: [initial],
    historyIndex: 0,
    dirty: false,
    fileHandle: null,
    documentPath: null, // root-relative path, e.g. "examples/markdown/blog.json"
    documentStack: [], // frames for component navigation
    handlersSource: null,
    mode: "component", // 'component' | 'content'
    content: { frontmatter: {} }, // frontmatter metadata for .md files
    ui: {
      rightTab: "properties", // 'properties' | 'events' | 'style'
      zoom: 1,
      activeMedia: null, // '--md' | null (base) — focused canvas/breakpoint
      activeSelector: null, // ':hover' | '.child' | null (base) — nested selector context
      featureToggles: {}, // { '--dark': true } — non-size media toggles
      styleSections: {}, // { layout: true, ... } — section open/closed state
      inspectorSections: {}, // { identity: true, ... } — properties panel section open/closed state
      styleShorthands: {}, // { padding: true, ... } — shorthand expand/collapse state
      styleFilter: "", // free-text filter for CSS property names
      styleFilterActive: false, // true = show only props with values set
      editingFunction: null, // null | { type: 'def', defName } | { type: 'event', path, eventKey }
      stylebookSelection: null, // tag name string, e.g. "h1"
      stylebookTab: "elements", // "elements" | "variables"
      stylebookFilter: "", // search filter text
      stylebookCustomizedOnly: false, // show only customized elements
      settingsTab: "stylebook", // "stylebook" | "definitions" | "contentTypes"
      gitStatus: null, // { branch, ahead, behind, files: [] }
      gitBranches: null, // { current, branches: [] }
      gitCommitMessage: "", // commit message input
      gitLoading: false, // loading indicator during async ops
      gitError: null, // error message string
      gitDiffState: null,
      pendingInlineEdit: null, // null | { path, mediaName } — deferred inline edit awaiting canvas readiness
    },
    canvas: {
      status: "idle", // "idle" | "loading" | "ready" | "error"
      scope: null, // $defs scope from runtime buildScope
      error: null, // error message on failure
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
    },
    session: { selection, hover, ui, canvas },
  };
}

// ─── Project state (persists across document switches) ────────────────────────
//
// Shape: { root, name, projectRoot, isSiteProject, projectConfig,
//          dirs: Map<string, DirEntry[]>, expanded: Set<string>,
//          selectedPath: string|null, searchQuery: string }
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
  if (value === undefined || value === null || value === "") delete fm[field];
  else fm[field] = value;
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
    document: state.document,
    selection: state.selection,
    fileHandle: state.fileHandle,
    documentPath: state.documentPath,
    dirty: state.dirty,
    history: state.history,
    historyIndex: state.historyIndex,
    mode: state.mode,
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
  if (!state.documentStack || state.documentStack.length === 0) return state;
  const stack = [...state.documentStack];
  const frame = stack.pop();
  return {
    ...state,
    ...frame,
    documentStack: stack,
    ui: { ...state.ui },
  };
}
