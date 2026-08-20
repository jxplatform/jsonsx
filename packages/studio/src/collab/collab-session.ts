/**
 * CollabSession — the bridge between a tab's transactional document and a shared Y.Doc obtained
 * from `platform.collab(docPath)`.
 *
 * Outbound: the transact observer publishes every local transaction's forward JxDocOps into the Y
 * structure tree (un-instrumented and bypass writes reconcile by diff — the Y.Doc doubles as the
 * before-image). Inbound: remote Y transactions convert back into JxDocOps and replay through
 * `applyExternalDocOps`, riding the surgical canvas patcher; unconvertible shapes hard-reconcile
 * the tab from the Y tree. Undo becomes a local-origin-scoped Y.UndoManager registered as the tab's
 * history delegate.
 *
 * Saving is EXPLICIT even while attached: syncing edits to peers (the Y.Doc) is automatic, but
 * folding the shared source to disk is not. Local edits mark `tab.doc.dirty` immediately for
 * instant Save-button feedback; the room-level, server-authoritative unsaved state then arrives via
 * `handle.onDirty` (any peer's edit dirties the room for everyone; a save clears it for everyone).
 * Cmd+S / Save runs a serialize→mirror→flush, and the provider broadcasts the room clean once the
 * write lands.
 *
 * All yjs code sits behind a dynamic import: the unsplit bundle inlines the bytes, but module
 * evaluation defers until a collab session actually attaches.
 */

import { effect, onScopeDispose, reactive, toRaw } from "../reactivity";
import { getPlatform } from "../platform";
import { jsonClone } from "../utils/studio-utils";
import { cloneSelection } from "../tabs/selection";
import {
  applyExternalDocOps,
  isBatching,
  setBatchEndNotifier,
  setHistoryDelegate,
  setTransactGate,
  setTransactObserver,
  transactDoc,
} from "../tabs/transact";
import { PROJECT_CONFIG_PATH } from "../tabs/tab";
import type { TransactOrigin } from "../tabs/transact";
import type { TransactionRecord } from "../tabs/patch-ops";
import type { Tab } from "../tabs/tab";
import type { JxDocOp } from "@jxsuite/collab/ops";
import type { CollabHandle } from "@jxsuite/collab/provider";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type * as CollabNS from "@jxsuite/collab";
import { collabState, registerCollabPath, unregisterCollabPath } from "./collab-state";
import { notify } from "../services/notify";

type CollabModule = typeof CollabNS;

/** How long the initial sync may take before falling back to solo editing. */
const SYNC_TIMEOUT_MS = 8000;
/** Debounce for the elected reconciler's structure→source mirror. */
const MIRROR_DEBOUNCE_MS = 800;

/**
 * The longest the shared source text may lag behind local edits while typing continues.
 *
 * The debounce above is re-armed on EVERY transaction, so any commit cadence faster than it starves
 * the mirror completely — and the canvas now commits on a ~500ms typing pause. Without a ceiling,
 * sustained writing would leave the source Y.Text (what peers preview and what providers persist)
 * frozen for the whole session. This bounds the lag instead: the debounce still coalesces bursts,
 * but a mirror is forced once the text is this stale.
 */
const MIRROR_MAX_LAG_MS = 2500;

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

/** Parser injected at studio init (file-ops' parseSourceForPath) for the source reconciler. */
export type CollabParser = (
  tab: Tab,
  text: string,
) => Promise<{ document: JxMutableNode; frontmatter?: Record<string, unknown> }>;

let _parse: CollabParser | null = null;

export function configureCollabParser(fn: CollabParser | null): void {
  _parse = fn;
}

/** Status-message sink injected at studio init (a direct statusbar import would cycle). */
let _notify: (message: string) => void = () => {};

export function configureCollabNotifier(fn: ((message: string) => void) | null): void {
  _notify = fn ?? (() => {});
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
  /** When the shared source text was last brought up to date; bounds the debounce's max lag. */
  lastMirrorAt?: number;
  /** Debounce for the source reconciler's Y.Text → structure parse mirror. */
  sourceParseTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Which source surface currently speaks for this client's canonical lock.
   *
   * The lock is a room-level fact with no owner, and `leave()` reaches it from exactly one place —
   * the cleanup {@link canvas/canvas-render.ts}'s `createSourceCollabBinding` returns. Toggling Code
   * view off and on inside one round trip runs two mounts that overlap: the second `enter()` has
   * already re-flipped the lock by the time the first mount's cleanup fires, and that cleanup
   * released a lock the live mount was holding — leaving a co-edited buffer bound to a Y.Text that
   * the room no longer treats as canonical, with the structure mirror free to serialize over it.
   *
   * A token, minted synchronously by each `enter()`, is the identity the release checks. Call
   * order, not resolution order: `enter()` awaits a serialization, so the last mount to be ASKED
   * must win regardless of which round trip returns first.
   */
  sourceLockOwner: object | null;
  disposers: (() => void)[];
}

interface TabRuntime {
  watcherInstalled: boolean;
  /** Bumped on every detach; in-flight attaches abandon when it moves. */
  generation: number;
  session: ActiveSession | null;
  attaching: Promise<void> | null;
  /**
   * The user asked to leave this document's session.
   *
   * Reactive, because the watcher effect that owns attach/detach has to re-run when it changes —
   * which is also why leaving is a STATE rather than a teardown verb: the effect stays the single
   * owner of the session lifecycle, and `Collaborate: Stop sharing` sets a flag it reads.
   */
  optedOut: { value: boolean };
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
    runtime = {
      attaching: null,
      generation: 0,
      optedOut: reactive({ value: false }),
      session: null,
      watcherInstalled: false,
    };
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
  /* Soft-freeze structural editing while ANYONE holds source-canonical (remote origins pass — they
     ARE the reconciler's mirror of the frozen representation).
     **Including the client holding the lock, which used to be exempt** (`&& !session.inSourceMode`).
     The exemption assumed a carrier that does not exist: a structural edit made by the lock holder
     never reaches the shared `Y.Text`, because `scheduleMirror` returns early while canonical is
     `"source"`, and nothing notices, because the source observer fires on TEXT changes only. So the
     tree and the text diverged, held apart until `leave()` — which runs `sourceParseNow` before
     releasing the lock, parses the UNCHANGED text back into a tree, and reverts the author's edit
     under `MIRROR_ORIGIN`. It then arrives at every peer through `applyExternalDocOps` (origin
     `"remote"`, which passes this gate by design), so the layer they deleted in the Outline
     reappeared seconds later with no explanation — and they were the one client this toast was
     never shown to.
     Mirroring the other way while source is canonical is not the alternative: it is exactly the
     round trip `services/monaco-buffer.ts`'s clause 5 exists to refuse. Clause 5's own reasoning
     settles this one — if the CRDT owns that text and the tree is DERIVED from it, then nobody may
     edit the tree directly, and "nobody" includes whoever is holding the pen. */
  setTransactGate((tab) => {
    const session = runtimeOf(tab)?.session;
    if (session?.synced && collabState(tab).sourceCanonical) {
      _notify("Source editing in progress — structural edits are paused");
      return "source-canonical";
    }
    return null;
  });
}

/** Test hook: uninstall global observers and forget module state. */
export function resetCollabForTests(): void {
  hooksInstalled = false;
  setTransactObserver(null);
  setBatchEndNotifier(null);
  setTransactGate(null);
  _serialize = null;
  _parse = null;
  _notify = () => {};
}

function onTransact(tab: Tab, record: TransactionRecord, origin: TransactOrigin): void {
  const session = runtimeOf(tab)?.session;
  if (!session || !session.synced) {
    return;
  }
  session.lastSeenRef = toRaw(tab.doc.document) as object;
  if (origin === "remote") {
    // The reconciler keeps source text fresh regardless of WHO edited the structure. The tab's
    // Dirty state is driven by the server's room-level `doc-dirty` broadcast (see onDirty in
    // CreateSession), not forced here.
    scheduleMirror(session);
    return;
  }
  if (session.canWrite) {
    publishRecord(session, record);
    scheduleMirror(session);
  }
  // Local edits leave the tab dirty (transactDoc already set it) until an explicit save flushes and
  // The provider broadcasts the room clean.
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
  // While source holds the canonical lock, mirroring runs the OTHER way (parse, not serialize).
  if (session.collab.canonicalOf(session.handle.doc) === "source") {
    return;
  }
  // Re-arming on every transaction means a faster commit cadence would push the mirror out
  // Forever. Once the shared text is MIRROR_MAX_LAG_MS stale, stop deferring and mirror now.
  const now = Date.now();
  session.lastMirrorAt ??= now;
  if (now - session.lastMirrorAt >= MIRROR_MAX_LAG_MS) {
    if (session.mirrorTimer) {
      clearTimeout(session.mirrorTimer);
      session.mirrorTimer = null;
    }
    session.lastMirrorAt = now;
    void mirrorNow(session);
    return;
  }
  if (session.mirrorTimer) {
    clearTimeout(session.mirrorTimer);
  }
  session.mirrorTimer = setTimeout(() => {
    session.mirrorTimer = null;
    session.lastMirrorAt = Date.now();
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

/** Parse the shared source text back into the structure tree (the source reconciler's duty). */
async function sourceParseNow(session: ActiveSession): Promise<void> {
  if (!_parse || !session.synced || !session.canWrite) {
    return;
  }
  const { collab, handle, tab } = session;
  const rev = collab.canonicalRevOf(handle.doc);
  const text = collab.sourceText(handle.doc).toString();
  let parsed: Awaited<ReturnType<CollabParser>>;
  try {
    parsed = await _parse(tab, text);
  } catch {
    // Unparseable source: keep the last good structure (the preview goes stale, not wrong).
    return;
  }
  if (!session.synced || collab.canonicalRevOf(handle.doc) !== rev) {
    // The lock flipped while parsing; this mirror was computed against a dead representation.
    return;
  }
  const ops = collab.diffDocs(collab.yDocToJson(handle.doc), parsed.document);
  if (ops === null) {
    collab.replaceYStructure(handle.doc, parsed.document, collab.MIRROR_ORIGIN);
  } else if (ops.length > 0) {
    try {
      collab.applyDocOpsToY(handle.doc, ops, collab.MIRROR_ORIGIN);
    } catch {
      collab.replaceYStructure(handle.doc, parsed.document, collab.MIRROR_ORIGIN);
    }
  }
  const frontmatter = collab.frontmatterMap(handle.doc);
  const next = parsed.frontmatter ?? {};
  handle.doc.transact(() => {
    // Detached copy: keys are deleted while iterating.
    const sharedKeys = [...frontmatter.keys()];
    for (const key of sharedKeys) {
      if (!(key in next)) {
        frontmatter.delete(key);
      }
    }
    for (const [key, value] of Object.entries(next)) {
      if (!collab.deepEqual(frontmatter.get(key), value)) {
        frontmatter.set(key, value);
      }
    }
  }, collab.MIRROR_ORIGIN);
}

/**
 * The code view's co-editing surface for a tab, or null when the tab isn't in a synced session.
 * `enter()` flips the canonical lock to source (seeding the text from the flipper's serialization);
 * `leave()` reverts to structure-canonical when the last source editor departs. `text` is the real
 * Y.Text and `awareness` the connection's Awareness — exactly what `collab/monaco-binding.ts`'s
 * `bindMonacoToYText` consumes (it owns the awareness `selection` field while bound).
 */
export function collabSourceContext(tab: Tab): {
  text: unknown;
  awareness: CollabHandle["awareness"];
  localOrigin: unknown;
  readOnly: boolean;
  enter: () => Promise<void>;
  leave: () => void;
} | null {
  const session = runtimeOf(tab)?.session;
  if (!session?.synced) {
    return null;
  }
  const { collab, handle } = session;
  /* THIS CONTEXT'S CLAIM ON THE LOCK, and the reason a release needs one.
     One context object is handed to one mount, and `leave()` is called by that mount's cleanup —
     but the lock it releases is the SESSION's, shared by every mount this client makes. Toggling
     Code view off and on inside one round trip overlaps two of them, and the first one's cleanup
     handed back a lock the second one had just taken. The token is minted synchronously at
     `enter()` so the ordering is the order the surfaces were asked for, not the order two
     serializations happened to resolve in. */
  let claim: object | null = null;
  const holdsClaim = () => claim !== null && session.sourceLockOwner === claim;
  return {
    awareness: handle.awareness,
    enter: async () => {
      claim = {};
      session.sourceLockOwner = claim;
      const local = handle.awareness.getLocalState();
      if (local) {
        handle.awareness.setLocalState({ ...local, mode: "source" });
      }
      if (!session.canWrite) {
        return;
      }
      let serialized: string | null = null;
      if (_serialize) {
        try {
          serialized = await _serialize(tab);
        } catch {
          serialized = null;
        }
      }
      // Asked again across the await: a later mount owns the surface now, and seeding the shared
      // Text from THIS mount's serialization would push a stale document at the room.
      if (!holdsClaim()) {
        return;
      }
      collab.acquireSourceCanonical(
        handle.doc,
        serialized ?? collab.sourceText(handle.doc).toString(),
        collab.LOCAL_ORIGIN,
      );
    },
    leave: () => {
      // Not this mount's lock to hand back, and not its awareness state to reset either — the live
      // Mount is in source mode and says so.
      if (!holdsClaim()) {
        claim = null;
        return;
      }
      claim = null;
      session.sourceLockOwner = null;
      const local = handle.awareness.getLocalState();
      if (local) {
        handle.awareness.setLocalState({ ...local, mode: "structure" });
      }
      /* A client with no write access never reached `acquireSourceCanonical` above, so it holds
         nothing to hand back — and `releaseSourceCanonical` is itself a write to shared state,
         which the relay drops from a read-only socket anyway. The guard is right; it was never the
         asymmetry. See below for the one that was. */
      if (!session.canWrite) {
        return;
      }
      /* AND A READ-ONLY VIEWER MUST NOT COUNT AS SOMEONE STILL HOLDING THE LOCK.
         `otherSourceEditors` answers "who else has Code view open", per awareness, which is a
         different question from the one asked here: who else could be the reason not to release.
         A read-only guest publishes `mode: "source"` when they open Code view and then returns at
         the guard above — they can neither acquire the lock nor hand it back. Counted, they made
         the LAST WRITE-CAPABLE editor's departure release nothing, and their own departure release
         nothing: `meta.canonical` stayed `"source"` for the whole room, forever, and with the
         lock-holder exemption gone from the transact gate that is every client frozen out of every
         structural edit, with only the keyed "structural edits are paused" toast to explain it.
         The same `canWrite !== false` filter the reconciler election above uses, for the same
         reason: a client that cannot write cannot be the one holding a write. */
      const others = collab
        .otherSourceEditors(handle.awareness, session.path, handle.awareness.clientID)
        .filter((clientId) => {
          const peer = handle.awareness.getStates().get(clientId) as
            | { canWrite?: boolean }
            | undefined;
          return peer?.canWrite !== false;
        });
      if (others.length === 0) {
        // Freshen the structure mirror once more, then hand the lock back.
        void sourceParseNow(session).then(() => {
          collab.releaseSourceCanonical(handle.doc, collab.LOCAL_ORIGIN);
        });
      }
    },
    localOrigin: collab.LOCAL_ORIGIN,
    readOnly: !session.canWrite,
    text: collab.sourceText(handle.doc),
  };
}

/**
 * Whether this client is in `tab`'s session **without write access**.
 *
 * The single spelling of "this tab cannot be saved by me". A read-only client edits its local
 * reactive document freely — nothing blocks structural editing, and `transactDoc` still marks the
 * tab dirty — but `onTransact` gates BOTH `publishRecord` and `scheduleMirror` behind `canWrite`,
 * so those edits exist in this browser and nowhere else: not in the Y-doc, not on the relay, not on
 * disk. Every question that turns on "is this work recoverable from somewhere?" has to ask this
 * one, which is why it is exported rather than re-derived per caller.
 */
export function collabReadOnly(tab: Tab): boolean {
  const state = collabState(tab);
  return state.active && state.readOnly;
}

/**
 * Cmd+S for a collab tab: refresh the source mirror and ask the provider to persist now. Returns
 * false when the tab has no active session (caller saves through the file path as usual), and false
 * when this client cannot write to the session it does have.
 *
 * **The read-only `false` is the load-bearing one.** This used to skip `mirrorNow` for a read-only
 * client and then flush and return `true` anyway — flushing a Y-doc that had received none of the
 * edits, and reporting the result as a save. `saveFile` stamped "Saved just now" on it and the tab
 * strip's Save button closed the tab on top of work that was still only in the browser. Answering
 * `false` is the truth; `saveFile` is where the read-only tab is refused outright, so this never
 * becomes a licence to write the file behind the room's back.
 */
export async function collabSave(tab: Tab): Promise<boolean> {
  const session = runtimeOf(tab)?.session;
  if (!session?.synced || !session.canWrite) {
    return false;
  }
  if (session.mirrorTimer) {
    clearTimeout(session.mirrorTimer);
    session.mirrorTimer = null;
  }
  await mirrorNow(session);
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
 * the tab's file unless the author has opted out, and tears everything down when the tab's scope is
 * disposed.
 *
 * The watcher used to carry a second condition — detach while the tab is "drilled into" a
 * sub-document — guarding a `session.documentStack` that nothing could ever push onto. It never
 * fired, and a tab holds one document now: drilling in opens a tab of its own, which gets its own
 * watcher for its own file.
 *
 * **`project.json` is out of replication.** It is the one document whose edits arrive from surfaces
 * that are not the canvas — every settings form, the imports panel, the deploy flow — and whose
 * value the studio ITSELF reads to configure formats, extensions, schemas and the style cascade. A
 * shared Y.Doc over it would mean a peer's extension list reconfiguring your editor mid-keystroke,
 * and the source-canonical freeze would pause configuration edits that have nothing to do with
 * text. Returning here is the whole gate: no session is attached, so `setHistoryDelegate` is never
 * called for this tab and its history stays the local op log `tabs/project-config.ts` transacts
 * on.
 */
export function ensureCollab(tab: Tab): void {
  const platform = maybePlatform();
  if (!platform?.collab || !tab.documentPath || tab.documentPath === PROJECT_CONFIG_PATH) {
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
      if (runtime.optedOut.value) {
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

/**
 * Join or leave this document's collaboration session — the idempotent setter behind `Collaborate:
 * Share this document` and `Collaborate: Stop sharing` (§7.4).
 *
 * Leaving sets a flag the watcher effect reads rather than calling `detachSession` directly, so the
 * effect remains the one owner of the session lifecycle and re-joining is the same call with the
 * other value. Calling it twice with the same value does nothing, which is the property the
 * `app-commands` pairing test checks for.
 *
 * @param {Tab} tab @param {boolean} enabled
 */
export function setCollabEnabled(tab: Tab, enabled: boolean): void {
  const runtime = runtimeFor(tab);
  if (runtime.optedOut.value === !enabled) {
    return;
  }
  runtime.optedOut.value = !enabled;
  if (!runtime.watcherInstalled && enabled) {
    ensureCollab(tab);
  }
}

/** True while the user has not opted this tab out of collaboration. */
export function isCollabEnabled(tab: Tab): boolean {
  return runtimeOf(tab)?.optedOut.value !== true;
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
    /* Not a failure and not a session: this build/platform has no collaboration to offer. Saying
       so is the difference between "nobody else is here" and "something broke" (§7.4). */
    collabState(tab).status = "unavailable";
    return;
  }
  const { generation } = runtime;
  const state = collabState(tab);
  state.status = "connecting";
  state.attachError = "";
  const attempt = (async () => {
    try {
      const [collab, handle] = await Promise.all([loadCollab(), platform.collab!(path)]);
      if (!handle) {
        // The platform offers collaboration; this document is simply not shared. Solo, not broken.
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
      state.attachError = "";
      registerCollabPath(path);
    } catch (error) {
      /* An attach that threw is a FAILURE, and it used to be reported as "detached" — the same
         value a solo document carries. A relay that is down, a token that expired and a document
         nobody shared were one indistinguishable state (§7.4). */
      state.status = "failed";
      state.active = false;
      state.attachError = error instanceof Error ? error.message : String(error);
      notify.warn(`Live collaboration is not available for "${path}" — ${state.attachError}`, {
        key: `collab:${path}`,
        path,
        source: "Collaboration",
      });
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
  state.attachError = "";
  state.peers = [];
  if (!session) {
    return;
  }
  unregisterCollabPath(session.path);
  if (session.mirrorTimer) {
    clearTimeout(session.mirrorTimer);
  }
  if (session.sourceParseTimer) {
    clearTimeout(session.sourceParseTimer);
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
      selection: cloneSelection(tab.session.selection),
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
    sourceLockOwner: null,
    sourceParseTimer: null,
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

  // The server owns the room-level unsaved state: `onDirty` fires synchronously with the current
  // Value on subscribe (delivered during the open handshake), so attaching to a clean room clears
  // Any dirty the initial reconcile set, and attaching to an already-dirty room shows dirty.
  session.disposers.push(
    handle.onDirty((dirty) => {
      tab.doc.dirty = dirty;
    }),
  );

  // Presence identity + write capability (drives reconciler election).
  handle.awareness.setLocalState({
    canWrite: session.canWrite,
    focusedPath: path,
    structuralSelection: null,
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
    stackItem.meta.set("selection", cloneSelection(tab.session.selection));
  };
  const onStackPop = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
    const selection = stackItem.meta.get("selection") as (string | number)[][] | undefined;
    tab.session.selection = cloneSelection(selection ?? []);
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

  // The canonical-representation lock: while source holds it, structural surfaces soft-freeze
  // (Transact gate) and the source reconciler's parses arrive as MIRROR-origin structure changes.
  const tabState = collabState(tab);
  tabState.sourceCanonical = collab.canonicalOf(handle.doc) === "source";
  const lockMeta = collab.metaMap(handle.doc);
  const lockObserver = () => {
    tabState.sourceCanonical = collab.canonicalOf(handle.doc) === "source";
  };
  lockMeta.observe(lockObserver);
  session.disposers.push(() => lockMeta.unobserve(lockObserver));

  // The source reconciler (lowest write clientID in source mode) parses Y.Text back into the
  // Structure tree on a debounce, so every client's canvas previews source edits live.
  const source = collab.sourceText(handle.doc);
  const sourceObserver = (_event: unknown, transaction: { origin: unknown }) => {
    if (transaction.origin === collab.MIRROR_ORIGIN || !session.synced) {
      return;
    }
    if (collab.canonicalOf(handle.doc) !== "source") {
      return;
    }
    if (!collab.isSourceReconciler(handle.awareness, session.path)) {
      return;
    }
    if (session.sourceParseTimer) {
      clearTimeout(session.sourceParseTimer);
    }
    session.sourceParseTimer = setTimeout(() => {
      session.sourceParseTimer = null;
      void sourceParseNow(session);
    }, 600);
  };
  source.observe(sourceObserver as never);
  session.disposers.push(() => source.unobserve(sourceObserver as never));

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

    // Publish the local structural selection for remote canvas overlays (peers filter by
    // FocusedPath, so per-doc boxes come free from the one project-level awareness state). The
    // Plain `selection` field belongs to the code view's Monaco binding (in-buffer text cursors)
    // — never write it here.
    effect(() => {
      // The whole selection SET crosses awareness, so a peer's canvas draws every node the author
      // Has selected. A selection of one publishes a one-entry list, which is the same box.
      // Empty stays `null` rather than `[]`: "this peer is not pointing at anything" is one fact
      // With one wire value, and every consumer already tests it by presence.
      const structuralSelection =
        tab.session.selection.length > 0 ? cloneSelection(tab.session.selection) : null;
      const local = handle.awareness.getLocalState();
      if (local) {
        handle.awareness.setLocalState({ ...local, structuralSelection });
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
        // Dirty stays as the edit left it; the server's doc-dirty broadcast is authoritative.
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
