/**
 * State.js — Builder state model and mutation API
 *
 * All state changes go through named mutation functions. State is immutable — every mutation
 * produces a new state object. History is a linear stack of { document, selection } snapshots.
 *
 * Path convention: [] = root document ['children', 0] = first child ['children', 0, 'children', 2]
 * = third child of first child
 */

/**
 * @typedef {Record<string, any>} JxNode
 *
 * @typedef {(string | number)[]} JxPath
 *
 * @typedef {{ document: JxNode; selection: JxPath | null }} HistorySnapshot
 *
 * @typedef {{
 *   document: JxNode;
 *   selection: JxPath | null;
 *   hover: JxPath | null;
 *   history: HistorySnapshot[];
 *   historyIndex: number;
 *   dirty: boolean;
 *   fileHandle: any;
 *   documentPath: string | null;
 *   documentStack: any[];
 *   handlersSource: string | null;
 *   mode: string;
 *   content: { frontmatter: Record<string, any> };
 *   ui: Record<string, any>;
 *   canvas: { status: string; scope: any; error: string | null };
 * }} StudioState
 */

const HISTORY_LIMIT = 100;

// ─── Path utilities ───────────────────────────────────────────────────────────

/**
 * Walk the document tree and return the node at the given path.
 *
 * @param {any} doc
 * @param {JxPath} path
 * @returns {any}
 */
export function getNodeAtPath(doc, path) {
  let node = doc;
  for (const key of path) {
    if (node == null) return undefined;
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
export function parentElementPath(path) {
  return path.length >= 2 ? path.slice(0, -2) : null;
}

/**
 * Return the child index (last segment of the path).
 *
 * @param {JxPath} path
 * @returns {string | number}
 */
export function childIndex(path) {
  return path[path.length - 1];
}

/**
 * Serialize a path to a string key for Map lookups.
 *
 * @param {JxPath} path
 * @returns {string}
 */
export function pathKey(path) {
  return path.join("/");
}

/**
 * Compare two paths for equality.
 *
 * @param {JxPath | null} a
 * @param {JxPath | null} b
 * @returns {boolean}
 */
export function pathsEqual(a, b) {
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
export function isAncestor(path, descendant) {
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
 * @param {any} doc
 * @param {JxPath} [path]
 * @param {number} [depth]
 * @returns {{ node: any; path: JxPath; depth: number; nodeType: string }[]}
 */
export function flattenTree(doc, path = [], depth = 0) {
  // Text node children: bare primitives get a "text" row
  if (typeof doc === "string" || typeof doc === "number" || typeof doc === "boolean") {
    return [{ node: doc, path, depth, nodeType: "text" }];
  }

  /** @type {{ node: any; path: JxPath; depth: number; nodeType: string }[]} */
  const rows = [{ node: doc, path, depth, nodeType: "element" }];

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
  } else if (children && typeof children === "object" && children.$prototype === "Array") {
    // $map — emit the map container, then recurse into the template
    rows.push({ node: children, path: [...path, "children"], depth: depth + 1, nodeType: "map" });
    const mapDef = children.map;
    if (mapDef && typeof mapDef === "object") {
      rows.push(...flattenTree(mapDef, [...path, "children", "map"], depth + 2));
    }
  }

  // $switch — emit each case as a virtual child
  if (doc.$switch && doc.cases && typeof doc.cases === "object") {
    for (const [caseName, caseDef] of Object.entries(doc.cases)) {
      const casePath = [...path, "cases", caseName];
      if (caseDef && typeof caseDef === "object" && /** @type {any} */ (caseDef).$ref) {
        rows.push({ node: caseDef, path: casePath, depth: depth + 1, nodeType: "case-ref" });
      } else if (caseDef && typeof caseDef === "object") {
        rows.push({ node: caseDef, path: casePath, depth: depth + 1, nodeType: "case" });
        // Recurse into case children (skip the case node itself — already emitted)
        const caseChildren = flattenTree(caseDef, casePath, depth + 2);
        rows.push(...caseChildren.slice(1));
      }
    }
  }

  return rows;
}

/**
 * Get a display label for a node (for layers + overlays).
 *
 * @param {any} node
 * @returns {string}
 */
export function nodeLabel(node) {
  if (!node) return "?";
  // $map container (Repeater)
  if (node.$prototype === "Array") {
    const ref = node.items?.$ref || "items";
    return `Repeater → ${ref}`;
  }
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
 * @param {any} doc
 * @returns {StudioState}
 */
export function createState(doc) {
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
      leftTab: "layers", // 'files' | 'layers' | 'blocks' | 'state' | 'data'
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
 * @param {any} doc
 * @param {any} session
 * @returns {StudioState}
 */
export function toFlat(doc, session) {
  return { ...doc, ...session };
}

/**
 * Decompose a flat StudioState into doc and session slices.
 *
 * @param {StudioState} S
 * @returns {{ doc: any; session: any }}
 */
export function fromFlat(S) {
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

/** @type {any} */
export let projectState = null;

/** @param {any} ps */
export function setProjectState(ps) {
  projectState = ps;
}

// ─── Frontmatter mutation ───────────────────────────────────────────────────

/**
 * Update a frontmatter field. Does not use applyMutation because frontmatter lives in S.content,
 * not S.document.
 *
 * @param {StudioState} state
 * @param {string} field
 * @param {any} value
 * @returns {StudioState}
 */
export function updateFrontmatter(state, field, value) {
  const fm = { ...state.content?.frontmatter };
  if (value === undefined || value === null || value === "") delete fm[field];
  else fm[field] = value;
  return {
    ...state,
    content: { ...state.content, frontmatter: fm },
    dirty: true,
  };
}

// ─── Core mutation ────────────────────────────────────────────────────────────

/**
 * Apply a mutation to the document. Clones the document immutably, applies the mutation function to
 * the clone, and pushes to history.
 *
 * @param {StudioState} state
 * @param {(doc: any) => void} mutationFn
 * @returns {StudioState}
 */
export function applyMutation(state, mutationFn) {
  const newDoc = structuredClone(state.document);
  mutationFn(newDoc);
  const truncated = state.history.slice(0, state.historyIndex + 1);
  truncated.push({ document: newDoc, selection: state.selection });
  if (truncated.length > HISTORY_LIMIT) truncated.shift();
  return {
    ...state,
    document: newDoc,
    history: truncated,
    historyIndex: truncated.length - 1,
    dirty: true,
  };
}

// ─── Selection / hover ────────────────────────────────────────────────────────

/**
 * @param {StudioState} state
 * @param {JxPath | null} path
 * @returns {StudioState}
 */
export function selectNode(state, path) {
  return { ...state, selection: path };
}

/**
 * @param {StudioState} state
 * @param {JxPath | null} path
 * @returns {StudioState}
 */
export function hoverNode(state, path) {
  return { ...state, hover: path };
}

// ─── Undo / redo ──────────────────────────────────────────────────────────────

/**
 * @param {StudioState} state
 * @returns {StudioState}
 */
export function undo(state) {
  if (state.historyIndex <= 0) return state;
  const idx = state.historyIndex - 1;
  const snap = state.history[idx];
  return {
    ...state,
    document: snap.document,
    selection: snap.selection,
    historyIndex: idx,
    dirty: true,
  };
}

/**
 * @param {StudioState} state
 * @returns {StudioState}
 */
export function redo(state) {
  if (state.historyIndex >= state.history.length - 1) return state;
  const idx = state.historyIndex + 1;
  const snap = state.history[idx];
  return {
    ...state,
    document: snap.document,
    selection: snap.selection,
    historyIndex: idx,
    dirty: true,
  };
}

// ─── Document mutations ───────────────────────────────────────────────────────

/**
 * @param {StudioState} state
 * @param {JxPath} parentPath
 * @param {number} index
 * @param {any} nodeDef
 * @returns {StudioState}
 */
export function insertNode(state, parentPath, index, nodeDef) {
  return applyMutation(state, (doc) => {
    const parent = getNodeAtPath(doc, parentPath);
    if (!parent.children) parent.children = [];
    parent.children.splice(index, 0, nodeDef);
  });
}

/**
 * @param {StudioState} state
 * @param {JxPath} path
 * @returns {StudioState}
 */
export function removeNode(state, path) {
  if (!path || path.length < 2) return state; // can't remove root
  const elemPath = parentElementPath(path);
  const idx = childIndex(path);
  const newState = applyMutation(state, (doc) => {
    getNodeAtPath(doc, /** @type {JxPath} */ (elemPath)).children.splice(idx, 1);
  });
  // Clear selection if we removed the selected node
  if (state.selection && isAncestor(path, state.selection)) {
    return { ...newState, selection: null };
  }
  return newState;
}

/**
 * @param {StudioState} state
 * @param {JxPath} path
 * @returns {StudioState}
 */
export function duplicateNode(state, path) {
  if (!path || path.length < 2) return state;
  const node = getNodeAtPath(state.document, path);
  if (!node) return state;
  const elemPath = /** @type {JxPath} */ (parentElementPath(path));
  const idx = /** @type {number} */ (childIndex(path));
  const newState = insertNode(state, elemPath, idx + 1, structuredClone(node));
  return selectNode(newState, [...elemPath, "children", idx + 1]);
}

/**
 * Wrap the node at `path` in a new wrapper element (e.g. a div).
 *
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} wrapperTag
 * @returns {StudioState}
 */
export function wrapNode(state, path, wrapperTag = "div") {
  if (!path || path.length < 2) return state;
  const node = getNodeAtPath(state.document, path);
  if (!node) return state;
  const elemPath = /** @type {JxPath} */ (parentElementPath(path));
  const idx = /** @type {number} */ (childIndex(path));
  const wrapper = { tagName: wrapperTag, children: [structuredClone(node)] };
  const newState = applyMutation(state, (doc) => {
    const parent = getNodeAtPath(doc, elemPath);
    parent.children.splice(idx, 1, wrapper);
  });
  return selectNode(newState, [...elemPath, "children", idx]);
}

/**
 * @param {StudioState} state
 * @param {JxPath} fromPath
 * @param {JxPath} toParentPath
 * @param {number} toIndex
 * @returns {StudioState}
 */
export function moveNode(state, fromPath, toParentPath, toIndex) {
  const newState = applyMutation(state, (doc) => {
    const fromParentPath = /** @type {JxPath} */ (parentElementPath(fromPath));
    const fromParent = getNodeAtPath(doc, fromParentPath);
    const fromIdx = childIndex(fromPath);
    const [node] = fromParent.children.splice(fromIdx, 1);
    const toParent = getNodeAtPath(doc, toParentPath);
    if (!toParent.children) toParent.children = [];
    // Adjust target index if moving within the same parent and source was before target
    let adjustedIndex = toIndex;
    if (fromParent === toParent && /** @type {number} */ (fromIdx) < toIndex) {
      adjustedIndex--;
    }
    toParent.children.splice(adjustedIndex, 0, node);
  });
  // Update selection to follow the moved node
  if (pathsEqual(newState.selection, fromPath)) {
    let adjustedIdx = toIndex;
    // Adjust if same parent and source was before target
    const fromParentPath = /** @type {JxPath} */ (parentElementPath(fromPath));
    const fromIdx = childIndex(fromPath);
    if (
      fromParentPath.length === toParentPath.length &&
      fromParentPath.every((v, i) => v === toParentPath[i]) &&
      /** @type {number} */ (fromIdx) < toIndex
    ) {
      adjustedIdx = toIndex - 1;
    }
    newState.selection = [...toParentPath, "children", adjustedIdx];
  }
  return newState;
}

/**
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} key
 * @param {any} value
 * @returns {StudioState}
 */
export function updateProperty(state, path, key, value) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (value === undefined || value === null || value === "") delete node[key];
    else node[key] = value;
  });
}

/**
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} prop
 * @param {any} value
 * @returns {StudioState}
 */
export function updateStyle(state, path, prop, value) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (!node.style) node.style = {};
    if (value === undefined || value === "") delete node.style[prop];
    else node.style[prop] = value;
    if (Object.keys(node.style).length === 0) delete node.style;
  });
}

/**
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} attr
 * @param {any} value
 * @returns {StudioState}
 */
export function updateAttribute(state, path, attr, value) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (!node.attributes) node.attributes = {};
    if (value === undefined || value === "") delete node.attributes[attr];
    else node.attributes[attr] = value;
    if (Object.keys(node.attributes).length === 0) delete node.attributes;
  });
}

/**
 * @param {StudioState} state
 * @param {string} name
 * @param {any} def
 * @returns {StudioState}
 */
export function addDef(state, name, def) {
  return applyMutation(state, (doc) => {
    if (!doc.state) doc.state = {};
    doc.state[name] = def;
  });
}

/**
 * @param {StudioState} state
 * @param {string} name
 * @returns {StudioState}
 */
export function removeDef(state, name) {
  return applyMutation(state, (doc) => {
    if (doc.state) {
      delete doc.state[name];
      if (Object.keys(doc.state).length === 0) delete doc.state;
    }
  });
}

/**
 * @param {StudioState} state
 * @param {string} name
 * @param {Record<string, any>} updates
 * @returns {StudioState}
 */
export function updateDef(state, name, updates) {
  return applyMutation(state, (doc) => {
    if (!doc.state) doc.state = {};
    if (!doc.state[name]) doc.state[name] = {};
    Object.assign(doc.state[name], updates);
    for (const k of Object.keys(doc.state[name])) {
      if (doc.state[name][k] === undefined || doc.state[name][k] === null) {
        delete doc.state[name][k];
      }
    }
  });
}

/**
 * @param {StudioState} state
 * @param {string} oldName
 * @param {string} newName
 * @returns {StudioState}
 */
export function renameDef(state, oldName, newName) {
  return applyMutation(state, (doc) => {
    if (!doc.state || !doc.state[oldName]) return;
    doc.state[newName] = doc.state[oldName];
    delete doc.state[oldName];
  });
}

// ─── Media mutations ─────────────────────────────────────────────────────────

/**
 * Update a style property inside a media override block (e.g., `@--md`).
 *
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string} prop
 * @param {any} value
 * @returns {StudioState}
 */
export function updateMediaStyle(state, path, mediaName, prop, value) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (!node.style) node.style = {};
    const key = `@${mediaName}`;
    if (!node.style[key]) node.style[key] = {};
    if (value === undefined || value === "") {
      delete node.style[key][prop];
      if (Object.keys(node.style[key]).length === 0) delete node.style[key];
    } else {
      node.style[key][prop] = value;
    }
    if (Object.keys(node.style).length === 0) delete node.style;
  });
}

/**
 * Update a style property inside a nested selector block (e.g., :hover).
 *
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} selector
 * @param {string} prop
 * @param {any} value
 * @returns {StudioState}
 */
export function updateNestedStyle(state, path, selector, prop, value) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (!node.style) node.style = {};
    if (!node.style[selector]) node.style[selector] = {};
    if (value === undefined || value === "") {
      delete node.style[selector][prop];
      if (Object.keys(node.style[selector]).length === 0) delete node.style[selector];
    } else {
      node.style[selector][prop] = value;
    }
    if (Object.keys(node.style).length === 0) delete node.style;
  });
}

/**
 * Update a style property inside a nested selector within a media block (e.g., `@--md` > `:hover`).
 *
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string} selector
 * @param {string} prop
 * @param {any} value
 * @returns {StudioState}
 */
export function updateMediaNestedStyle(state, path, mediaName, selector, prop, value) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (!node.style) node.style = {};
    const key = `@${mediaName}`;
    if (!node.style[key]) node.style[key] = {};
    if (!node.style[key][selector]) node.style[key][selector] = {};
    if (value === undefined || value === "") {
      delete node.style[key][selector][prop];
      if (Object.keys(node.style[key][selector]).length === 0) delete node.style[key][selector];
      if (Object.keys(node.style[key]).length === 0) delete node.style[key];
    } else {
      node.style[key][selector][prop] = value;
    }
    if (Object.keys(node.style).length === 0) delete node.style;
  });
}

/**
 * Add or update a named media entry at the document root.
 *
 * @param {StudioState} state
 * @param {string} name
 * @param {any} query
 * @returns {StudioState}
 */
export function updateMedia(state, name, query) {
  return applyMutation(state, (doc) => {
    if (!doc.$media) doc.$media = {};
    if (query === undefined || query === "") {
      delete doc.$media[name];
      if (Object.keys(doc.$media).length === 0) delete doc.$media;
    } else {
      doc.$media[name] = query;
    }
  });
}

// ─── Document stack (component navigation) ──────────────────────────────────

/**
 * Push current document onto the stack and switch to editing a new document.
 *
 * @param {StudioState} state
 * @param {any} doc
 * @param {string | null} documentPath
 * @returns {StudioState}
 */
export function pushDocument(state, doc, documentPath) {
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
  newState.ui = { ...state.ui, leftTab: "layers", activeMedia: null, activeSelector: null };
  return newState;
}

/**
 * Pop the document stack and return to the previous document.
 *
 * @param {StudioState} state
 * @returns {StudioState}
 */
export function popDocument(state) {
  if (!state.documentStack || state.documentStack.length === 0) return state;
  const stack = [...state.documentStack];
  const frame = stack.pop();
  return {
    ...state,
    ...frame,
    documentStack: stack,
    ui: { ...state.ui, leftTab: "layers" },
  };
}

// ─── $props mutations ────────────────────────────────────────────────────────

/**
 * Update a $prop on a component instance.
 *
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} propName
 * @param {any} value
 * @returns {StudioState}
 */
export function updateProp(state, path, propName, value) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (!node.$props) node.$props = {};
    if (value === undefined || value === null || value === "") delete node.$props[propName];
    else node.$props[propName] = value;
    if (Object.keys(node.$props).length === 0) delete node.$props;
  });
}

// ─── $switch case mutations ──────────────────────────────────────────────────

/**
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} caseName
 * @param {any} [caseDef]
 * @returns {StudioState}
 */
export function addSwitchCase(state, path, caseName, caseDef) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (!node.cases) node.cases = {};
    node.cases[caseName] = caseDef || { tagName: "div", textContent: caseName };
  });
}

/**
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} caseName
 * @returns {StudioState}
 */
export function removeSwitchCase(state, path, caseName) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (node.cases) {
      delete node.cases[caseName];
    }
  });
}

/**
 * @param {StudioState} state
 * @param {JxPath} path
 * @param {string} oldName
 * @param {string} newName
 * @returns {StudioState}
 */
export function renameSwitchCase(state, path, oldName, newName) {
  return applyMutation(state, (doc) => {
    const node = getNodeAtPath(doc, path);
    if (!node.cases || !node.cases[oldName]) return;
    node.cases[newName] = node.cases[oldName];
    delete node.cases[oldName];
  });
}
