/// <reference lib="dom" />
import { toRaw } from "../reactivity";
import { jsonClone } from "../utils/studio-utils";
import { childIndex, getNodeAtPath, isAncestor, parentElementPath, pathsEqual } from "../state";

import type { Tab } from "../tabs/tab";
import type { JxPath } from "../state";

import type { JsonValue } from "../types";
import type { JxEventBinding, JxMutableNode, JxStateObject, JxStyle } from "@jxsuite/schema/types";
import { ensureNestedStyle, getNestedStyle } from "@jxsuite/schema/guards";

const HISTORY_LIMIT = 100;

/** Any value that can sit at a document node key (undefined/null/"" deletes it). */
export type JxNodeValue =
  | JsonValue
  | JxMutableNode
  | (JxMutableNode | string)[]
  | JxEventBinding
  | undefined;

/**
 * The editable children array of a node, created when absent. Mapped-array children (`$prototype:
 * "Array"`) cannot be index-mutated — fail loudly instead of corrupting.
 */
function childArray(node: JxMutableNode): (JxMutableNode | string)[] {
  if (!node.children) {
    node.children = [];
  }
  if (!Array.isArray(node.children)) {
    throw new TypeError("Cannot insert into mapped-array children; edit the map template instead");
  }
  return node.children;
}

// ─── Transactional layer ─────────────────────────────────────────────────────

/**
 * Apply a document mutation transactionally: push to history and mark dirty. The mutationFn
 * receives the tab and should mutate tab.doc.document in place.
 *
 * @param {Tab | null} tab
 * @param {(tab: Tab) => void} mutationFn
 * @param {{ skipHistory?: boolean }} [opts]
 */
export function transactDoc(
  tab: Tab | null,
  mutationFn: (tab: Tab) => void,
  { skipHistory = false }: { skipHistory?: boolean } = {},
) {
  if (!tab) {
    return;
  }
  mutationFn(tab);

  // Replace the document root reference so effects tracking tab.doc.document re-trigger.
  // Nested objects are shared — the mutation already modified them in place.
  const raw = toRaw(tab.doc.document);
  tab.doc.document = { ...raw };

  if (!skipHistory) {
    const snapshot = {
      document: jsonClone(raw),
      selection: tab.session.selection ? [...tab.session.selection] : null,
    };
    const truncated = tab.history.snapshots.slice(0, tab.history.index + 1);
    truncated.push(snapshot);
    if (truncated.length > HISTORY_LIMIT) {
      truncated.shift();
    }
    tab.history.snapshots = truncated;
    tab.history.index = truncated.length - 1;
  }

  tab.doc.dirty = true;
}

/**
 * Convenience: transact with a mutation fn that receives the document directly.
 *
 * @param {Tab | null} tab
 * @param {(doc: JxMutableNode) => void} fn
 * @param {{ skipHistory?: boolean }} [opts]
 */
export function transact(
  tab: Tab | null,
  fn: (doc: JxMutableNode) => void,
  opts?: { skipHistory?: boolean },
) {
  transactDoc(tab, (t) => fn(t.doc.document), opts);
}

// ─── Undo / Redo ─────────────────────────────────────────────────────────────

/** @param {Tab} tab */
export function undo(tab: Tab) {
  if (tab.history.index <= 0) {
    return;
  }
  tab.history.index -= 1;
  const snap = tab.history.snapshots[tab.history.index];
  tab.doc.document = structuredClone(toRaw(snap.document));
  tab.session.selection = snap.selection ? [...toRaw(snap.selection)] : null;
  tab.doc.dirty = true;
}

/** @param {Tab} tab */
export function redo(tab: Tab) {
  if (tab.history.index >= tab.history.snapshots.length - 1) {
    return;
  }
  tab.history.index += 1;
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
 * @param {JxMutableNode} nodeDef
 */
export function mutateInsertNode(
  tab: Tab,
  parentPath: JxPath,
  index: number,
  nodeDef: JxMutableNode,
) {
  const parent = getNodeAtPath(tab.doc.document, parentPath);
  if (!parent) {
    return;
  }
  childArray(parent).splice(index, 0, structuredClone(nodeDef));
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 */
export function mutateRemoveNode(tab: Tab, path: JxPath) {
  if (!path || path.length < 2) {
    return;
  }
  const elemPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  (getNodeAtPath(tab.doc.document, elemPath).children as JxMutableNode[]).splice(idx, 1);
  if (tab.session.selection && isAncestor(path, tab.session.selection)) {
    tab.session.selection = null;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 */
export function mutateDuplicateNode(tab: Tab, path: JxPath) {
  if (!path || path.length < 2) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }
  const elemPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  const clone = structuredClone(toRaw(node));
  (getNodeAtPath(tab.doc.document, elemPath).children as JxMutableNode[]).splice(idx + 1, 0, clone);
  tab.session.selection = [...elemPath, "children", idx + 1];
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} wrapperTag
 */
export function mutateWrapNode(tab: Tab, path: JxPath, wrapperTag = "div") {
  if (!path || path.length < 2) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }
  const elemPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  const wrapper = {
    children: [structuredClone(toRaw(node))],
    tagName: wrapperTag,
  };
  (getNodeAtPath(tab.doc.document, elemPath).children as JxMutableNode[]).splice(idx, 1, wrapper);
  tab.session.selection = [...elemPath, "children", idx];
}

/**
 * @param {Tab} tab
 * @param {JxPath} fromPath
 * @param {JxPath} toParentPath
 * @param {number} toIndex
 */
export function mutateMoveNode(tab: Tab, fromPath: JxPath, toParentPath: JxPath, toIndex: number) {
  const doc = tab.doc.document;
  const fromParentPath = parentElementPath(fromPath) as JxPath;
  const fromIdx = childIndex(fromPath) as number;
  if (!fromParentPath || typeof fromIdx !== "number") {
    return;
  }
  const fromParent = getNodeAtPath(doc, fromParentPath);
  const toParent = getNodeAtPath(doc, toParentPath);
  if (!fromParent || !Array.isArray(fromParent.children) || !toParent) {
    return;
  }
  const [node] = fromParent.children.splice(fromIdx, 1);
  if (node === undefined) {
    return;
  }
  let adjustedIndex = toIndex;
  if (fromParent === toParent && fromIdx < toIndex) {
    adjustedIndex -= 1;
  }
  childArray(toParent).splice(adjustedIndex, 0, node);

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
 * @param {JxNodeValue} value
 */
export function mutateUpdateProperty(tab: Tab, path: JxPath, key: string, value?: JxNodeValue) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (value === undefined || value === null || value === "") {
    delete node[key];
  } else {
    node[key] = value;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateStyle(tab: Tab, path: JxPath, prop: string, value: string | undefined) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.style) {
    node.style = {};
  }
  if (value === undefined || value === "") {
    delete node.style[prop];
  } else {
    node.style[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} attr
 * @param {string | undefined} value
 */
export function mutateUpdateAttribute(
  tab: Tab,
  path: JxPath,
  attr: string,
  value?: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.attributes) {
    node.attributes = {};
  }
  if (value === undefined || value === "") {
    delete node.attributes[attr];
  } else {
    node.attributes[attr] = value;
  }
  if (Object.keys(node.attributes).length === 0) {
    delete node.attributes;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateMediaStyle(
  tab: Tab,
  path: JxPath,
  mediaName: string,
  prop: string,
  value: string | undefined,
) {
  if (!mediaName) {
    return mutateUpdateStyle(tab, path, prop, value);
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.style) {
    node.style = {};
  }
  const key = `@${mediaName}`;
  const media = ensureNestedStyle(node.style, key);
  if (value === undefined || value === "") {
    delete media[prop];
    if (Object.keys(media).length === 0) {
      delete node.style[key];
    }
  } else {
    media[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} selector
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateNestedStyle(
  tab: Tab,
  path: JxPath,
  selector: string,
  prop: string,
  value: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.style) {
    node.style = {};
  }
  const block = ensureNestedStyle(node.style, selector);
  if (value === undefined || value === "") {
    delete block[prop];
    if (Object.keys(block).length === 0) {
      delete node.style[selector];
    }
  } else {
    block[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string} selector
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateMediaNestedStyle(
  tab: Tab,
  path: JxPath,
  mediaName: string,
  selector: string,
  prop: string,
  value: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.style) {
    node.style = {};
  }
  const key = `@${mediaName}`;
  const media = ensureNestedStyle(node.style, key);
  const block = ensureNestedStyle(media, selector);
  if (value === undefined || value === "") {
    delete block[prop];
    if (Object.keys(block).length === 0) {
      delete media[selector];
    }
    if (Object.keys(media).length === 0) {
      delete node.style[key];
    }
  } else {
    block[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
}

/**
 * Update a style property at a nested style path (e.g., ["table", "th"]). Creates intermediate
 * objects as needed.
 *
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string[]} stylePath
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateNestedStylePath(
  tab: Tab,
  path: JxPath,
  stylePath: string[],
  prop: string,
  value: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.style) {
    node.style = {};
  }
  let obj = node.style;
  for (const seg of stylePath) {
    obj = ensureNestedStyle(obj, seg);
  }
  if (value === undefined || value === "") {
    delete obj[prop];
    // Clean up empty parent objects
    let cur: JxStyle | undefined = node.style;
    for (let i = 0; i < stylePath.length && cur; i++) {
      const child = getNestedStyle(cur, stylePath[i]);
      if (child && Object.keys(child).length === 0) {
        delete cur[stylePath[i]];
        break;
      }
      cur = child;
    }
  } else {
    obj[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
}

/**
 * Update a style property at a nested style path within a media query.
 *
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} mediaName
 * @param {string[]} stylePath
 * @param {string} prop
 * @param {string | undefined} value
 */
export function mutateUpdateMediaNestedStylePath(
  tab: Tab,
  path: JxPath,
  mediaName: string,
  stylePath: string[],
  prop: string,
  value: string | undefined,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.style) {
    node.style = {};
  }
  const key = `@${mediaName}`;
  const media = ensureNestedStyle(node.style, key);
  let obj = media;
  for (const seg of stylePath) {
    obj = ensureNestedStyle(obj, seg);
  }
  if (value === undefined || value === "") {
    delete obj[prop];
    let cur: JxStyle | undefined = media;
    for (let i = 0; i < stylePath.length && cur; i++) {
      const child = getNestedStyle(cur, stylePath[i]);
      if (child && Object.keys(child).length === 0) {
        delete cur[stylePath[i]];
        break;
      }
      cur = child;
    }
    if (Object.keys(media).length === 0) {
      delete node.style[key];
    }
  } else {
    obj[prop] = value;
  }
  if (Object.keys(node.style).length === 0) {
    delete node.style;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {Record<string, string | undefined> | undefined} style
 */
export function mutateReplaceStyle(tab: Tab, path: JxPath, style: JxStyle | undefined) {
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
export function mutateAddDef(tab: Tab, name: string, def: Record<string, JsonValue>) {
  const doc = tab.doc.document;
  if (!doc.state) {
    doc.state = {};
  }
  doc.state[name] = def;
}

/**
 * @param {Tab} tab
 * @param {string} name
 */
export function mutateRemoveDef(tab: Tab, name: string) {
  const doc = tab.doc.document;
  if (doc.state) {
    delete doc.state[name];
    if (Object.keys(doc.state).length === 0) {
      delete doc.state;
    }
  }
}

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {Record<string, JsonValue>} updates
 */
export function mutateUpdateDef(tab: Tab, name: string, updates: Record<string, unknown>) {
  const doc = tab.doc.document;
  if (!doc.state) {
    doc.state = {};
  }
  const existing = doc.state[name];
  const entry: JxStateObject =
    existing == null
      ? {}
      : typeof existing !== "object" || Array.isArray(existing)
        ? { default: existing }
        : (existing as JxStateObject);
  doc.state[name] = entry;
  Object.assign(entry, updates);
  for (const k of Object.keys(entry)) {
    if (entry[k] === undefined || entry[k] === null) {
      delete entry[k];
    }
  }
}

/**
 * @param {Tab} tab
 * @param {string} oldName
 * @param {string} newName
 */
export function mutateRenameDef(tab: Tab, oldName: string, newName: string) {
  const doc = tab.doc.document;
  if (!doc.state || !doc.state[oldName]) {
    return;
  }
  doc.state[newName] = doc.state[oldName];
  delete doc.state[oldName];
}

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {string | undefined} query
 */
export function mutateUpdateMedia(tab: Tab, name: string, query?: string | undefined) {
  const doc = tab.doc.document;
  if (!doc.$media) {
    doc.$media = {};
  }
  if (query === undefined || query === "") {
    delete doc.$media[name];
    if (Object.keys(doc.$media).length === 0) {
      delete doc.$media;
    }
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
export function mutateUpdateProp(tab: Tab, path: JxPath, propName: string, value: JsonValue) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.$props) {
    node.$props = {};
  }
  if (value === undefined || value === null || value === "") {
    delete node.$props[propName];
  } else {
    node.$props[propName] = value;
  }
  if (Object.keys(node.$props).length === 0) {
    delete node.$props;
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} caseName
 * @param {JxMutableNode} [caseDef]
 */
export function mutateAddSwitchCase(
  tab: Tab,
  path: JxPath,
  caseName: string,
  caseDef?: JxMutableNode,
) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.cases) {
    node.cases = {};
  }
  node.cases[caseName] = caseDef || { tagName: "div", textContent: caseName };
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} caseName
 */
export function mutateRemoveSwitchCase(tab: Tab, path: JxPath, caseName: string) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (node.cases) {
    delete node.cases[caseName];
  }
}

/**
 * @param {Tab} tab
 * @param {JxPath} path
 * @param {string} oldName
 * @param {string} newName
 */
export function mutateRenameSwitchCase(tab: Tab, path: JxPath, oldName: string, newName: string) {
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node.cases || !node.cases[oldName]) {
    return;
  }
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
export function mutateUpdateFrontmatter(tab: Tab, field: string, value?: JsonValue) {
  if (value === undefined || value === null || value === "") {
    delete tab.doc.content.frontmatter[field];
  } else {
    tab.doc.content.frontmatter[field] = value;
  }
  tab.doc.dirty = true;
}
