/**
 * CollabSession — the bridge between a tab's transactional document and a shared Y.Doc obtained
 * from `platform.collab(docPath)`.
 *
 * Outbound: the transact observer publishes every local transaction's forward JxDocOps into the Y
 * structure tree (un-instrumented and bypass writes reconcile by diff — the Y.Doc doubles as the
 * before-image). Inbound: remote Y transactions convert back into JxDocOps and replay through
 * `applyExternalDocOps`, riding the surgical canvas patcher; unconvertible shapes hard-reconcile
 * the tab from the Y tree. Undo becomes a local-origin-scoped Y.UndoManager registered as the tab's
 * history delegate. While attached, the shared session persists automatically: `dirty` stays false
 * and Cmd+S becomes a serialize→flush.
 *
 * All yjs code loads behind a dynamic import so the base Studio bundle stays yjs-free.
 */

import { effect, onScopeDispose, toRaw } from "../reactivity";
import { getPlatform } from "../platform";
import { jsonClone } from "../utils/studio-utils";
import {
  applyExternalDocOps,
  isBatching,
  setBatchEndNotifier,
  setHistoryDelegate,
  setTransactObserver,
  transactDoc,
} from "../tabs/transact";
import type { TransactOrigin } from "../tabs/transact";
import type { TransactionRecord } from "../tabs/patch-ops";
import type { Tab } from "../tabs/tab";
import type { JxDocOp } from "@jxsuite/collab/ops";
import type { CollabHandle } from "@jxsuite/collab/provider";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type * as CollabNS from "@jxsuite/collab";
import { collabState, registerCollabPath, unregisterCollabPath } from "./collab-state";

type CollabModule = typeof CollabNS;

/** How long the initial sync may take before falling back to solo editing. */
const SYNC_TIMEOUT_MS = 8000;
/** Debounce for the elected reconciler's structure→source mirror. */
const MIRROR_DEBOUNCE_MS = 800;

let collabModulePromise: Promise<CollabModule> | null = null;

function loadCollab(): Promise<CollabModule> {
  collabModulePromise ??= import("@jxsuite/collab");
  return collabModulePromise;
}

/** Tabs can open before any platform registers (headless tests); collab simply stays off. */
function maybePlatform(): ReturnType<typeof getPlatform> | null {
  try {
    return getPlatform();
  } catch {
    return null;
  }
}

/** Serializer injected at studio init (file-ops' serializeDocument); avoids an import cycle. */
let _serialize: ((tab: Tab) => Promise<string>) | null = null;

export function configureCollabSerializer(fn: ((tab: Tab) => Promise<string>) | null): void {
  _serialize = fn;
}

interface ActiveSession {
  tab: Tab;
  path: string;
  handle: CollabHandle;
  collab: CollabModule;
  undoManager: InstanceType<CollabModule["UndoManager"]> | null;
  /** The last document root reference produced through transactDoc (bypass-write detection). */
  lastSeenRef: object | null;
  /** Buffered forward ops while an AI batch runs; null outside batches. */
  batchOps: JxDocOp[] | null;
  batchNeedsDiff: boolean;
  /** Guards the frontmatter watcher against echoing remote-applied fields. */
  applyingRemoteFrontmatter: boolean;
  synced: boolean;
  canWrite: boolean;
  mirrorTimer: ReturnType<typeof setTimeout> | null;
  disposers: (() => void)[];
}

interface TabRuntime {
  watcherInstalled: boolean;
  /** Bumped on every detach; in-flight attaches abandon when it moves. */
  generation: number;
  session: ActiveSession | null;
  attaching: Promise<void> | null;
}

const runtimes = new WeakMap<Tab, TabRuntime>();

/** Callers hold either the raw tab or a reactive proxy of it; key runtimes by the raw object. */
function rawTab(tab: Tab): Tab {
  return toRaw(tab as unknown as object) as Tab;
}

function runtimeOf(tab: Tab): TabRuntime | undefined {
  return runtimes.get(rawTab(tab));
}

function runtimeFor(tab: Tab): TabRuntime {
  const key = rawTab(tab);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = { attaching: null, generation: 0, session: null, watcherInstalled: false };
    runtimes.set(key, runtime);
  }
  return runtime;
}

// ─── Global transact hooks (installed once; no-ops for unattached tabs) ──────

let hooksInstalled = false;

function installGlobalHooks(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;
  setTransactObserver(onTransact);
  setBatchEndNotifier(onBatchEnd);
}

/** Test hook: uninstall global observers and forget module state. */
export function resetCollabForTests(): void {
  hooksInstalled = false;
  setTransactObserver(null);
  setBatchEndNotifier(null);
  _serialize = null;
}

function onTransact(tab: Tab, record: TransactionRecord, origin: TransactOrigin): void {
  const session = runtimeOf(tab)?.session;
  if (!session || !session.synced) {
    return;
  }
  session.lastSeenRef = toRaw(tab.doc.document) as object;
  if (origin === "remote") {
    // The reconciler keeps source text fresh regardless of WHO edited the structure.
    scheduleMirror(session);
    tab.doc.dirty = false;
    return;
  }
  if (session.canWrite) {
    publishRecord(session, record);
    scheduleMirror(session);
  }
  // The shared session persists automatically; the dirty dot means "unsaved" and stays off.
  tab.doc.dirty = false;
}

function onBatchEnd(tab: Tab): void {
  const session = runtimeOf(tab)?.session;
  if (!session?.synced || session.batchOps === null) {
    return;
  }
  const ops = session.batchOps;
  const needsDiff = session.batchNeedsDiff;
  session.batchOps = null;
  session.batchNeedsDiff = false;
  if (!session.canWrite) {
    return;
  }
  // One Y transaction — one wire message, one undo step for the whole AI run.
  session.undoManager?.stopCapturing();
  if (needsDiff) {
    publishDiff(session);
  } else if (ops.length > 0) {
    try {
      session.collab.applyDocOpsToY(session.handle.doc, ops, session.collab.LOCAL_ORIGIN);
    } catch {
      publishDiff(session);
    }
  }
  session.undoManager?.stopCapturing();
}

function publishRecord(session: ActiveSession, record: TransactionRecord): void {
  const forward = record.docOps.map((pair) => pair.forward);
  if (isBatching()) {
    session.batchOps ??= [];
    if (forward.length === 0) {
      session.batchNeedsDiff = true;
    } else {
      session.batchOps.push(...forward);
    }
    return;
  }
  if (forward.length === 0) {
    // Un-instrumented mutation: the Y tree is the last-synced before-image — diff against it.
    publishDiff(session);
    return;
  }
  try {
    session.collab.applyDocOpsToY(session.handle.doc, forward, session.collab.LOCAL_ORIGIN);
  } catch {
    publishDiff(session);
  }
}

/** Make the Y structure tree match the tab's document (diff when possible, hard replace beyond). */
function publishDiff(session: ActiveSession): void {
  const { collab, handle, tab } = session;
  const before = collab.yDocToJson(handle.doc);
  const after = jsonClone(toRaw(tab.doc.document)) as JxMutableNode;
  const ops = collab.diffDocs(before, after);
  if (ops === null) {
    collab.replaceYStructure(handle.doc, after, collab.LOCAL_ORIGIN);
  } else if (ops.length > 0) {
    try {
      collab.applyDocOpsToY(handle.doc, ops, collab.LOCAL_ORIGIN);
    } catch {
      collab.replaceYStructure(handle.doc, after, collab.LOCAL_ORIGIN);
    }
  }
}

/** Replace the tab document in place from the Y tree (remote origin, full-render fallback). */
function reconcileTabFromY(session: ActiveSession): void {
  const next = session.collab.yDocToJson(session.handle.doc);
  transactDoc(
    session.tab,
    (t) => {
      const target = t.doc.document as Record<string, unknown>;
      for (const key of Object.keys(target)) {
        if (!(key in next)) {
          delete target[key];
        }
      }
      Object.assign(target, next);
    },
    { origin: "remote", skipHistory: true },
  );
}

// ─── Source mirror (Phase A: canonical is always "structure") ────────────────

/** The elected reconciler: lowest write-capable clientID keeps source Y.Text fresh. */
function isReconciler(session: ActiveSession): boolean {
  if (!session.canWrite) {
    return false;
  }
  const { awareness } = session.handle;
  let lowest = awareness.clientID;
  for (const [clientId, state] of awareness.getStates()) {
    if ((state as { canWrite?: boolean }).canWrite !== false && clientId < lowest) {
      lowest = clientId;
    }
  }
  return lowest === session.handle.awareness.clientID;
}

function scheduleMirror(session: ActiveSession): void {
  if (!_serialize || !isReconciler(session)) {
    return;
  }
  if (session.mirrorTimer) {
    clearTimeout(session.mirrorTimer);
  }
  session.mirrorTimer = setTimeout(() => {
    session.mirrorTimer = null;
    void mirrorNow(session);
  }, MIRROR_DEBOUNCE_MS);
}

/** Serialize the tab and fold the text into source Y.Text (what providers persist and commit). */
async function mirrorNow(session: ActiveSession): Promise<void> {
  if (!_serialize || !session.synced) {
    return;
  }
  try {
    const text = await _serialize(session.tab);
    session.collab.updateSourceText(session.handle.doc, text, session.collab.MIRROR_ORIGIN);
  } catch {
    // Serialization failures leave the previous mirror in place; the next edit retries.
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

/**
 * Cmd+S for a collab tab: refresh the source mirror and ask the provider to persist now. Returns
 * false when the tab has no active session (caller saves through the file path as usual).
 */
export async function collabSave(tab: Tab): Promise<boolean> {
  const session = runtimeOf(tab)?.session;
  if (!session?.synced) {
    return false;
  }
  if (session.mirrorTimer) {
    clearTimeout(session.mirrorTimer);
    session.mirrorTimer = null;
  }
  if (session.canWrite) {
    await mirrorNow(session);
  }
  await session.handle.flush();
  return true;
}

/** Refresh mirrors and flush every active session (call before commits). */
export async function flushAllCollab(): Promise<void> {
  for (const tab of liveTabs) {
    const session = runtimeOf(tab)?.session;
    if (session?.synced) {
      await collabSave(tab);
    }
  }
}

// ─── Attach / detach ─────────────────────────────────────────────────────────

/** Tabs with installed watchers (module-scoped so flushAllCollab can walk them). */
const liveTabs = new Set<Tab>();

/**
 * Idempotently wire collaboration for a tab. Installs a per-tab watcher that attaches a session for
 * the tab's file while it is at the top of its document stack, detaches while drilled into a
 * component, and tears everything down when the tab's scope is disposed.
 */
export function ensureCollab(tab: Tab): void {
  const platform = maybePlatform();
  if (!platform?.collab || !tab.documentPath) {
    return;
  }
  const runtime = runtimeFor(tab);
  if (runtime.watcherInstalled) {
    return;
  }
  runtime.watcherInstalled = true;
  installGlobalHooks();
  liveTabs.add(tab);
  tab.scope.run(() => {
    effect(() => {
      const drilled = (tab.session.documentStack?.length ?? 0) > 0;
      if (drilled) {
        detachSession(tab);
      } else {
        void attachSession(tab);
      }
    });
    onScopeDispose(() => {
      liveTabs.delete(tab);
      detachSession(tab);
    });
  });
}

/** Re-key after a file rename: tear down and re-attach against the new path. */
export function rekeyCollab(tab: Tab): void {
  const runtime = runtimeOf(tab);
  if (!runtime?.watcherInstalled) {
    ensureCollab(tab);
    return;
  }
  detachSession(tab);
  void attachSession(tab);
}

async function attachSession(tab: Tab): Promise<void> {
  const runtime = runtimeFor(tab);
  if (runtime.session || runtime.attaching) {
    return;
  }
  const { documentPath: path } = tab;
  const platform = maybePlatform();
  if (!path || !platform?.collab) {
    return;
  }
  const { generation } = runtime;
  const state = collabState(tab);
  state.status = "connecting";
  const attempt = (async () => {
    try {
      const [collab, handle] = await Promise.all([loadCollab(), platform.collab!(path)]);
      if (!handle) {
        state.status = "detached";
        return;
      }
      if (runtime.generation !== generation) {
        handle.destroy();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("collab-sync-timeout")), SYNC_TIMEOUT_MS);
      });
      try {
        await Promise.race([handle.whenSynced, timeout]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      if (runtime.generation !== generation) {
        handle.destroy();
        return;
      }
      runtime.session = createSession(tab, path, collab, handle);
      state.active = true;
      state.status = "synced";
      state.readOnly = !runtime.session.canWrite;
      registerCollabPath(path);
    } catch {
      state.status = "detached";
      state.active = false;
    } finally {
      runtime.attaching = null;
    }
  })();
  runtime.attaching = attempt;
  await attempt;
}

function detachSession(tab: Tab): void {
  const runtime = runtimeOf(tab);
  if (!runtime) {
    return;
  }
  runtime.generation += 1;
  const { session } = runtime;
  runtime.session = null;
  const state = collabState(tab);
  state.active = false;
  state.status = "detached";
  state.peers = [];
  if (!session) {
    return;
  }
  unregisterCollabPath(session.path);
  if (session.mirrorTimer) {
    clearTimeout(session.mirrorTimer);
  }
  for (const dispose of session.disposers) {
    try {
      dispose();
    } catch {
      // Disposal is best-effort; the handle teardown below is what matters.
    }
  }
  setHistoryDelegate(tab, null);
  // Re-base the op-log history on the current document for solo editing.
  tab.history.snapshots = [
    {
      document: jsonClone(toRaw(tab.doc.document)) as Record<string, unknown>,
      selection: tab.session.selection ? [...tab.session.selection] : null,
    },
  ];
  tab.history.index = 0;
  session.undoManager?.destroy();
  session.handle.destroy();
}

function createSession(
  tab: Tab,
  path: string,
  collab: CollabModule,
  handle: CollabHandle,
): ActiveSession {
  const identity = handle.identity();
  const session: ActiveSession = {
    applyingRemoteFrontmatter: false,
    batchNeedsDiff: false,
    batchOps: null,
    canWrite: identity ? identity.permission !== "read" : true,
    collab,
    disposers: [],
    handle,
    lastSeenRef: toRaw(tab.doc.document) as object,
    mirrorTimer: null,
    path,
    synced: false,
    tab,
    undoManager: null,
  };

  // Initial reconcile: first client seeds structure from the parsed doc; later clients adopt the
  // Shared tree when it differs from their local parse.
  const meta = collab.metaMap(handle.doc);
  if (meta.get("structureSeeded") === true) {
    const yJson = collab.yDocToJson(handle.doc);
    const tabJson = jsonClone(toRaw(tab.doc.document)) as JxMutableNode;
    if (!collab.deepEqual(yJson, tabJson)) {
      const ops = collab.diffDocs(tabJson, yJson);
      if (ops === null) {
        session.synced = true;
        reconcileTabFromY(session);
        session.synced = false;
      } else if (ops.length > 0) {
        applyExternalDocOps(tab, ops);
      }
    }
    session.applyingRemoteFrontmatter = true;
    const sharedFrontmatter = collab.frontmatterMap(handle.doc);
    for (const [key, value] of sharedFrontmatter.entries()) {
      tab.doc.content.frontmatter[key] = value as never;
    }
    session.applyingRemoteFrontmatter = false;
  } else if (session.canWrite) {
    collab.seedStructure(handle.doc, jsonClone(toRaw(tab.doc.document)) as JxMutableNode, {
      frontmatter: jsonClone(toRaw(tab.doc.content.frontmatter)),
      origin: collab.SEED_ORIGIN,
      sourceFormat: tab.doc.sourceFormat,
    });
  }
  session.lastSeenRef = toRaw(tab.doc.document) as object;
  tab.doc.dirty = false;

  // Presence identity + write capability (drives reconciler election).
  handle.awareness.setLocalState({
    canWrite: session.canWrite,
    focusedPath: path,
    selection: null,
    user: identity
      ? {
          avatarUrl: identity.avatarUrl,
          color: identity.color,
          login: identity.login,
          name: identity.name,
        }
      : {
          color: collab.colorForKey(String(handle.awareness.clientID)),
          login: `guest-${handle.awareness.clientID % 1000}`,
        },
  });

  // Undo: local-origin-scoped Y.UndoManager replaces the op-log while attached.
  const undoManager = new collab.UndoManager(
    [collab.structureMap(handle.doc), collab.frontmatterMap(handle.doc)],
    { trackedOrigins: new Set([collab.LOCAL_ORIGIN]) },
  );
  session.undoManager = undoManager;
  const onStackAdd = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
    stackItem.meta.set("selection", tab.session.selection ? [...tab.session.selection] : null);
  };
  const onStackPop = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
    const selection = stackItem.meta.get("selection") as (string | number)[] | null | undefined;
    tab.session.selection = selection ? [...selection] : null;
  };
  undoManager.on("stack-item-added", onStackAdd);
  undoManager.on("stack-item-popped", onStackPop);
  session.disposers.push(() => {
    undoManager.off("stack-item-added", onStackAdd);
    undoManager.off("stack-item-popped", onStackPop);
  });
  setHistoryDelegate(tab, {
    canRedo: () => undoManager.canRedo(),
    canUndo: () => undoManager.canUndo(),
    redo: () => {
      undoManager.redo();
    },
    undo: () => {
      undoManager.undo();
    },
  });

  // Inbound: remote structure transactions → JxDocOps → the surgical pipeline.
  const structure = collab.structureMap(handle.doc);
  const structureObserver = (events: unknown, transaction: { origin: unknown }) => {
    if (transaction.origin === collab.LOCAL_ORIGIN || !session.synced) {
      return;
    }
    const ops = collab.yEventsToDocOps(events as never);
    if (ops === null) {
      reconcileTabFromY(session);
      return;
    }
    if (ops.length === 0) {
      return;
    }
    try {
      applyExternalDocOps(tab, ops);
    } catch {
      reconcileTabFromY(session);
    }
  };
  structure.observeDeep(structureObserver);
  session.disposers.push(() => structure.unobserveDeep(structureObserver));

  // Inbound frontmatter (per-field).
  const frontmatter = collab.frontmatterMap(handle.doc);
  const frontmatterObserver = (
    event: { changes: { keys: Map<string, { action: string }> }; target: unknown },
    transaction: { origin: unknown },
  ) => {
    if (transaction.origin === collab.LOCAL_ORIGIN || !session.synced) {
      return;
    }
    session.applyingRemoteFrontmatter = true;
    try {
      for (const [key, change] of event.changes.keys) {
        if (change.action === "delete") {
          delete tab.doc.content.frontmatter[key];
        } else {
          tab.doc.content.frontmatter[key] = frontmatter.get(key) as never;
        }
      }
    } finally {
      session.applyingRemoteFrontmatter = false;
    }
  };
  frontmatter.observe(frontmatterObserver as never);
  session.disposers.push(() => frontmatter.unobserve(frontmatterObserver as never));

  // Outbound frontmatter: mutateUpdateFrontmatter bypasses transactDoc, so watch the map deeply.
  tab.scope.run(() => {
    let lastJson = JSON.stringify(tab.doc.content.frontmatter);
    effect(() => {
      const json = JSON.stringify(tab.doc.content.frontmatter);
      if (json === lastJson) {
        return;
      }
      lastJson = json;
      if (session.applyingRemoteFrontmatter || !session.synced || !session.canWrite) {
        return;
      }
      const local = JSON.parse(json) as Record<string, unknown>;
      handle.doc.transact(() => {
        // Detached copy: keys are deleted while iterating.
        const sharedKeys = [...frontmatter.keys()];
        for (const key of sharedKeys) {
          if (!(key in local)) {
            frontmatter.delete(key);
          }
        }
        for (const [key, value] of Object.entries(local)) {
          if (!collab.deepEqual(frontmatter.get(key), value)) {
            frontmatter.set(key, value);
          }
        }
      }, collab.LOCAL_ORIGIN);
      scheduleMirror(session);
    });

    // Publish the local structural selection for remote cursor overlays (peers filter by
    // FocusedPath, so per-doc boxes come free from the one project-level awareness state).
    effect(() => {
      const selection = tab.session.selection ? [...tab.session.selection] : null;
      const local = handle.awareness.getLocalState();
      if (local) {
        handle.awareness.setLocalState({ ...local, selection });
      }
    });

    // Bypass-write net: any doc root swap that did not come through transactDoc (Monaco parse
    // Flush) reconciles by diff. Deferred one microtask so the transact observer marks its own
    // Refs first (the assignment happens mid-transaction, before the observer runs).
    effect(() => {
      const ref = toRaw(tab.doc.document) as object;
      queueMicrotask(() => {
        const current = runtimeOf(tab)?.session;
        if (current !== session || !session.synced || !session.canWrite) {
          return;
        }
        const nowRef = toRaw(tab.doc.document) as object;
        if (nowRef !== ref || nowRef === session.lastSeenRef) {
          return;
        }
        session.lastSeenRef = nowRef;
        publishDiff(session);
        scheduleMirror(session);
        tab.doc.dirty = false;
      });
    });
  });

  // Presence roster + status.
  const state = collabState(tab);
  const awarenessObserver = () => {
    const peers: { clientId: number; state: never }[] = [];
    for (const [clientId, peerState] of handle.awareness.getStates()) {
      if (clientId !== handle.awareness.clientID && peerState["user"]) {
        peers.push({ clientId, state: peerState as never });
      }
    }
    state.peers = peers;
  };
  awarenessObserver();
  handle.awareness.on("change", awarenessObserver);
  session.disposers.push(
    () => handle.awareness.off("change", awarenessObserver),
    handle.onStatus((status) => {
      if (status === "offline" || status === "connecting") {
        state.status = "offline";
      } else if (session.synced) {
        state.status = "synced";
      }
    }),
    handle.onReset(() => {
      // The server replaced this doc's history: drop the session and re-attach fresh.
      detachSession(tab);
      void attachSession(tab);
    }),
  );

  session.synced = true;
  return session;
}
