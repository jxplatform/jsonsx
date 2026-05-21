import { toRaw } from "../reactivity.js";
import { getNodeAtPath, parentElementPath, childIndex, pathsEqual, isAncestor } from "../state.js";

/**
 * @typedef {import("../tabs/tab.js").Tab} Tab
 *
 * @typedef {import("../state.js").JxPath} JxPath
 *
 * @typedef {import("../state.js").JxNode} JxNode
 *
 * @typedef {string | number | boolean | object | null | undefined} JsonValue
 */

const HISTORY_LIMIT = 100;

// ─── Transactional layer ─────────────────────────────────────────────────────

/**
 * Apply a document mutation transactionally: push to history and mark dirty. The mutationFn
 * receives the tab and should mutate tab.doc.document in place.
 *
 * @param {Tab} tab
 * @param {(tab: Tab) => void} mutationFn
 * @param {{ skipHistory?: boolean }} [opts]
 */
export function transactDoc(tab, mutationFn, { skipHistory = false } = {}) {
  mutationFn(tab);

  // Replace the document root reference so effects tracking tab.doc.document re-trigger.
  // Nested objects are shared — the mutation already modified them in place.
  const raw = toRaw(tab.doc.document);
  tab.doc.document = { ...raw };

  if (!skipHistory) {
    const snapshot = {
      document: structuredClone(raw),
      selection: tab.session.selection ? [...tab.session.selection] : null,
    };
    const truncated = tab.history.snapshots.slice(0, tab.history.index + 1);
    truncated.push(snapshot);
    if (truncated.length > HISTORY_LIMIT) truncated.shift();
    tab.history.snapshots = truncated;
    tab.history.index = truncated.length - 1;
  }

  tab.doc.dirty = true;
}

/**
 * Convenience: transact with a mutation fn that receives the document directly.
 *
 * @param {Tab} tab
 * @param {(doc: JxNode) => void} fn
 * @param {{ skipHistory?: boolean }} [opts]
 */
export function transact(tab, fn, opts) {
  transactDoc(tab, (t) => fn(t.doc.document), opts);
}

// ─── Undo / Redo ─────────────────────────────────────────────────────────────

/** @param {Tab} tab */
export function undo(tab) {
  if (tab.history.index <= 0) return;
  tab.history.index--;
  const snap = tab.history.snapshots[tab.history.index];
  tab.doc.document = structuredClone(toRaw(snap.document));
  tab.session.selection = snap.selection ? [...toRaw(snap.selection)] : null;
  tab.doc.dirty = true;
}

/** @param {Tab} tab */
export function redo(tab) {
  if (tab.history.index >= tab.history.snapshots.length - 1) return;
  tab.history.index++;
  const snap = tab.history.snapshots[tab.history.index];
  tab.doc.document = structuredClone(toRaw(snap.document));
  tab.session.selection = snap.selection ? [...toRaw(snap.selection)] : null;
  tab.doc.dirty = true;
}

// ─── In-place document mutators ──────────────────────────────────────────────

/**
 * @param {Tab} tab
 * @param {JxPath} parentPath
 * @param {number} index
 * @param {JxNode} nodeDef
 */
export function mutateInsertNode(tab, parentPath, index, nodeDef) {
  const parent = getNodeAtPath(tab.doc.document, parentPath);
  if (!parent.children) parent.children = [];
  parent.children.splice(index, 0, structuredClone(nodeDef));
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 */
export function mutateRemoveNode(tab, path) {
  if (!path || path.length < 2) return;
  const elemPath = /** @type {JxPath} */ (parentElementPath(path));
  const idx = /** @type {number} */ (childIndex(path));
  getNodeAtPath(tab.doc.document, elemPath).children.splice(idx, 1);
  if (tab.session.selection && isAncestor(path, tab.session.selection)) {
    tab.session.selection = null;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 */
export function mutateDuplicateNode(tab, path) {
  if (!path || path.length < 2) return;
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) return;
  const elemPath = /** @type {JxPath} */ (parentElementPath(path));
  const idx = /** @type {number} */ (childIndex(path));
  const clone = structuredClone(toRaw(node));
  getNodeAtPath(tab.doc.document, elemPath).children.splice(idx + 1, 0, clone);
  tab.session.selection = [...elemPath, "children", idx + 1];
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} wrapperTag
 */
export function mutateWrapNode(tab, path, wrapperTag = "div") {
  if (!path || path.length < 2) return;
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) return;
  const elemPath = /** @type {JxPath} */ (parentElementPath(path));
  const idx = /** @type {number} */ (childIndex(path));
  const wrapper = { tagName: wrapperTag, children: [structuredClone(toRaw(node))] };
  getNodeAtPath(tab.doc.document, elemPath).children.splice(idx, 1, wrapper);
  tab.session.selection = [...elemPath, "children", idx];
}

/**
 * @param {Tab} tab
 * @param {JxPath} fromPath
 * @param {JxPath} toParentPath
 * @param {number} toIndex
 */
export function mutateMoveNode(tab, fromPath, toParentPath, toIndex) {
  const doc = tab.doc.document;
  const fromParentPath = /** @type {JxPath} */ (parentElementPath(fromPath));
  const fromIdx = /** @type {number} */ (childIndex(fromPath));
  const fromParent = getNodeAtPath(doc, fromParentPath);
  const [node] = fromParent.children.splice(fromIdx, 1);
  const toParent = getNodeAtPath(doc, toParentPath);
  if (!toParent.children) toParent.children = [];
  let adjustedIndex = toIndex;
  if (fromParent === toParent && fromIdx < toIndex) adjustedIndex--;
  toParent.children.splice(adjustedIndex, 0, node);

  if (pathsEqual(tab.session.selection, fromPath)) {
    let idx = toIndex;
    if (
      fromParentPath.length === toParentPath.length &&
      fromParentPath.every((v, i) => v === toParentPath[i]) &&
      fromIdx < toIndex
    ) {
      idx = toIndex - 1;
    }
    tab.session.selection = [...toParentPath, "children", idx];
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} key
 * @param {JsonValue} value
 */
export function mutateUpdateProperty(tab, path, key, value) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (value === undefined || value === null || value === "") delete node[key];
  else node[key] = value;
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateStyle(tab, path, prop, value) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.style) node.style = {};
  if (value === undefined || value === "") delete node.style[prop];
  else node.style[prop] = value;
  if (Object.keys(node.style).length === 0) delete node.style;
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} attr
 * @param {string | undefined} value
 */
export function mutateUpdateAttribute(tab, path, attr, value) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.attributes) node.attributes = {};
  if (value === undefined || value === "") delete node.attributes[attr];
  else node.attributes[attr] = value;
  if (Object.keys(node.attributes).length === 0) delete node.attributes;
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateMediaStyle(tab, path, mediaName, prop, value) {
  const node = getNodeAtPath(tab.doc.document, path);
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
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} selector
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateNestedStyle(tab, path, selector, prop, value) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.style) node.style = {};
  if (!node.style[selector]) node.style[selector] = {};
  if (value === undefined || value === "") {
    delete node.style[selector][prop];
    if (Object.keys(node.style[selector]).length === 0) delete node.style[selector];
  } else {
    node.style[selector][prop] = value;
  }
  if (Object.keys(node.style).length === 0) delete node.style;
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string} selector
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateMediaNestedStyle(tab, path, mediaName, selector, prop, value) {
  const node = getNodeAtPath(tab.doc.document, path);
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
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {Record<string, any> | undefined} style
 */
export function mutateReplaceStyle(tab, path, style) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (style && Object.keys(style).length > 0) {
    node.style = style;
  } else {
    delete node.style;
  }
}

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {Record<string, JsonValue>} def
 */
export function mutateAddDef(tab, name, def) {
  const doc = tab.doc.document;
  if (!doc.state) doc.state = {};
  doc.state[name] = def;
}

/**
 * @param {Tab} tab
 * @param {string} name
 */
export function mutateRemoveDef(tab, name) {
  const doc = tab.doc.document;
  if (doc.state) {
    delete doc.state[name];
    if (Object.keys(doc.state).length === 0) delete doc.state;
  }
}

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {Record<string, any>} updates
 */
export function mutateUpdateDef(tab, name, updates) {
  const doc = tab.doc.document;
  if (!doc.state) doc.state = {};
  if (!doc.state[name]) doc.state[name] = {};
  Object.assign(doc.state[name], updates);
  for (const k of Object.keys(doc.state[name])) {
    if (doc.state[name][k] === undefined || doc.state[name][k] === null) {
      delete doc.state[name][k];
    }
  }
}

/**
 * @param {Tab} tab
 * @param {string} oldName
 * @param {string} newName
 */
export function mutateRenameDef(tab, oldName, newName) {
  const doc = tab.doc.document;
  if (!doc.state || !doc.state[oldName]) return;
  doc.state[newName] = doc.state[oldName];
  delete doc.state[oldName];
}

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {string | undefined} query
 */
export function mutateUpdateMedia(tab, name, query) {
  const doc = tab.doc.document;
  if (!doc.$media) doc.$media = {};
  if (query === undefined || query === "") {
    delete doc.$media[name];
    if (Object.keys(doc.$media).length === 0) delete doc.$media;
  } else {
    doc.$media[name] = query;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} propName
 * @param {JsonValue} value
 */
export function mutateUpdateProp(tab, path, propName, value) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.$props) node.$props = {};
  if (value === undefined || value === null || value === "") delete node.$props[propName];
  else node.$props[propName] = value;
  if (Object.keys(node.$props).length === 0) delete node.$props;
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} caseName
 * @param {JxNode} [caseDef]
 */
export function mutateAddSwitchCase(tab, path, caseName, caseDef) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.cases) node.cases = {};
  node.cases[caseName] = caseDef || { tagName: "div", textContent: caseName };
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} caseName
 */
export function mutateRemoveSwitchCase(tab, path, caseName) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (node.cases) delete node.cases[caseName];
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} oldName
 * @param {string} newName
 */
export function mutateRenameSwitchCase(tab, path, oldName, newName) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.cases || !node.cases[oldName]) return;
  node.cases[newName] = node.cases[oldName];
  delete node.cases[oldName];
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

/**
 * Update a frontmatter field on a tab. Does not push document history.
 *
 * @param {Tab} tab
 * @param {string} field
 * @param {JsonValue} value
 */
export function mutateUpdateFrontmatter(tab, field, value) {
  if (value === undefined || value === null || value === "") {
    delete tab.doc.content.frontmatter[field];
  } else {
    tab.doc.content.frontmatter[field] = value;
  }
  tab.doc.dirty = true;
}
