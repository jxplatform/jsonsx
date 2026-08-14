/// <reference lib="dom" />
/**
 * The project configuration document — `project.json` under the transaction log.
 *
 * `project.json` is the file that defines the project, and until now it was the one file Studio
 * edited with no document behind it. Twenty-nine call sites across eight modules each reached for
 * `platform.writeFile("project.json", …)` (directly or through `updateSiteConfig`), in two
 * different serialisations, with no history and no dirty flag — and twenty-one of them dropped a
 * rejected write on the floor, leaving the form showing a value that was never persisted.
 *
 * This module is the one door. Every configuration write is now a TRANSACTION on a real {@link Tab}
 * whose `documentPath` is `project.json`, which is what buys undo, the dirty flag and ⌘S from the
 * machinery every other document already uses (`tabs/transact.ts`). `tab.ts`'s `inferModes` has
 * always answered `["stylebook", "source"]` for this path, so the tab's editor kind is `config`
 * (see `editorKindForMode`) with no new wiring.
 *
 * **The document of record.** When the author has `project.json` open in the workspace, THAT tab is
 * the configuration document: the settings surfaces and the open tab edit one object, so neither
 * can silently clobber the other. When it is not open the module keeps a document of its own, with
 * the same log, and hands over the moment a tab appears. One rule, stated once:
 * `projectState.projectConfig` is always `toRaw(document.doc.document)`.
 *
 * **One object, and a handover that cannot lose an edit.** That rule is restored at the moment a
 * tab is adopted, and adoption is reached lazily — from inside a commit. So a `project.json` tab
 * opened from the Files tree (`files/files.ts` parses the file itself) arrives holding a SECOND
 * configuration object, and until the next commit the settings surfaces are still rendering, and
 * mutating in place, the one they were loaded with. {@link commitProjectConfig} therefore reads the
 * live configuration BEFORE it binds and commits THAT object's content, adopting it into the
 * document; the alternative — letting the tab's parse win because it happened to bind last —
 * dropped the first settings edit after the tab was opened, wrote the drop to disk, and reported
 * success. When the document holds unsaved authoring of its own the two cannot be reconciled, and
 * §16 gets a Problem instead of a silent winner. {@link adoptProjectConfig} is the same handover
 * from the other side: a config that reached disk without passing through here (the assistant's
 * `write_file`) is put INTO the document rather than left beside it as a rival.
 *
 * **One serialisation.** {@link serializeProjectConfig} is `JSON.stringify(config, null, 2)` —
 * byte-for-byte what `files/file-ops.ts`'s native-JSON branch writes, so a ⌘S on the open tab and a
 * settings edit produce the same file. The predecessor had `null, 2` in `site-context.ts` and
 * `"\t"` in both `settings/contributed-section.ts` and `settings/defs-editor.ts`, so a settings
 * edit re-indented the entire file — every `project.json` in this repository is on disk with two
 * spaces.
 *
 * **A no-op edit writes nothing.** A form that re-commits the value it already holds — and every
 * one of these surfaces has such a path — used to rewrite the whole file. A commit now compares the
 * serialised result against what the file itself says and returns without a transaction, without a
 * write, and therefore with an empty diff.
 *
 * **Collaboration.** `project.json` is out of collab replication; the gate is in
 * `collab/collab-session.ts`'s `ensureCollab`, which is what would otherwise register the Yjs
 * history delegate over this tab.
 */

import { errorMessage } from "@jxsuite/schema/parse";
import { effect, toRaw } from "../reactivity";
import { getPlatform } from "../platform";
import { notify } from "../services/notify";
import { requireProjectState, setProjectState } from "../state";
import { setWorkspaceProject, workspace } from "../workspace/workspace";
import { PROJECT_CONFIG_PATH, createTab, disposeTab } from "./tab";
import { transactDoc } from "./transact";

import type { Tab } from "./tab";
import type { ProjectConfig } from "@jxsuite/schema/types";

export { PROJECT_CONFIG_PATH } from "./tab";

/**
 * The project configuration, as a file.
 *
 * The ONE serialisation. Identical to the native-JSON branch of `files/file-ops.ts`'s
 * `serializeDocument`, which is what ⌘S on the open `project.json` tab goes through — the two must
 * agree or every save would fight the last one.
 *
 * @param {ProjectConfig} config
 * @returns {string}
 */
export function serializeProjectConfig(config: ProjectConfig): string {
  return JSON.stringify(config, null, 2);
}

// ─── The document of record ───────────────────────────────────────────────────

/** The bound configuration document, or null before the first bind. */
let _bound: Tab | null = null;

/** The document this module owns while no `project.json` tab is open. */
let _detached: Tab | null = null;

/**
 * What the FILE says, re-serialised through {@link serializeProjectConfig}.
 *
 * Read from disk once per binding rather than assumed from the config in memory, because by the
 * time a commit arrives the caller has usually already mutated that config in place — the CSS
 * variables editor writes into `config.style` and then hands the same object over as a patch. A
 * value taken from memory would call every one of those edits a no-op.
 *
 * Comparing two `JSON.stringify(_, null, 2)` renderings of the same key order is a SEMANTIC test,
 * not a textual one, which is the point: `project.json` on disk is formatted by `oxfmt` (two-space
 * indent, short arrays kept on one line), so a byte comparison against the file would call every
 * edit a change and rewrite the whole file. This calls it unchanged and writes nothing.
 *
 * `null` means "unknown" — no project file, or one that would not parse — and every commit writes.
 */
let _committed: string | null = null;

/** Whether {@link _committed} has been sought for the current binding. One read per project. */
let _seeding: Promise<void> | null = null;

/**
 * The `project.json` tab the author has open, if any.
 *
 * Unwrapped, because `workspace.tabs` is a reactive Map and hands out a proxy: identity is how this
 * module decides whether to rebind, and the raw object is the identity every other tab-keyed
 * structure in Studio uses (`collab-session.ts`'s `rawTab` for the same reason).
 */
function openConfigTab(): Tab | null {
  const tab = workspace.tabs.get(PROJECT_CONFIG_PATH);
  return tab ? (toRaw(tab as unknown as object) as Tab) : null;
}

/** Drop the current binding, disposing the detached document if that is what it was. */
function unbind(): void {
  if (_detached) {
    disposeTab(_detached);
    _detached = null;
  }
  _bound = null;
  _committed = null;
  _seeding = null;
}

/** Learn what the file holds, once per binding. Memoised on the promise so commits cannot race. */
function seedCommitted(): Promise<void> {
  _seeding ??= (async () => {
    try {
      const text = await getPlatform().readFile(PROJECT_CONFIG_PATH);
      _committed = serializeProjectConfig(JSON.parse(text) as ProjectConfig);
    } catch {
      // No file, an unreadable one, or one that does not parse. "Unknown" is the honest answer,
      // And an unknown file is one every commit must write.
      _committed = null;
    }
  })();
  return _seeding;
}

/**
 * Forget the configuration document — the project-switch and test hook.
 *
 * Also reached implicitly: {@link projectConfigDocument} rebinds whenever the project state stops
 * pointing at the bound document, which is what a reload or a second project does.
 */
export function resetProjectConfigDocument(): void {
  unbind();
}

/**
 * Keep `projectState` and the workspace pointing at the document.
 *
 * Called from the bind effect rather than from the commit, so it is equally true after an undo: ⌘Z
 * on the open `project.json` tab replaces the document root, and the app's live configuration has
 * to follow it or the canvas would keep rendering the state the author just took back.
 *
 * @param {ProjectConfig} config
 */
function syncProjectState(config: ProjectConfig): void {
  const state = requireProjectState();
  if (state.projectConfig === config) {
    return;
  }
  setProjectState({ ...state, projectConfig: config });
  setWorkspaceProject(workspace.projectRoot, config);
}

/**
 * The configuration object the app is live on, unwrapped, or `null` before a project has one.
 *
 * Read at the TOP of a commit, before {@link projectConfigDocument} can rebind: this is the object
 * the settings surfaces rendered from and mutated in place, and after a rebind it may no longer be
 * the one `projectState` points at.
 *
 * @returns {ProjectConfig | null}
 */
function liveConfig(): ProjectConfig | null {
  const config = requireProjectState()?.projectConfig;
  return config ? (toRaw(config as unknown as object) as ProjectConfig) : null;
}

/**
 * Make `target` hold exactly `source`'s keys — assignment alone would leave the removals behind.
 *
 * @param {Record<string, unknown>} target
 * @param {ProjectConfig} source
 */
function replaceContents(target: Record<string, unknown>, source: ProjectConfig): void {
  for (const key of Object.keys(target)) {
    if (!Object.hasOwn(source, key)) {
      delete target[key];
    }
  }
  Object.assign(target, source);
}

/**
 * Adopt `tab` as the configuration document and install the state-sync effect in its scope.
 *
 * @param {Tab} tab
 * @returns {Tab}
 */
function bind(tab: Tab): Tab {
  _bound = tab;
  tab.scope.run(() => {
    effect(() => {
      const doc = tab.doc.document;
      if (_bound !== tab || !requireProjectState()) {
        return;
      }
      syncProjectState(toRaw(doc) as unknown as ProjectConfig);
    });
  });
  return tab;
}

/**
 * The configuration document, bound on demand.
 *
 * Rebinding is driven by two observations rather than by a lifecycle callback nobody would remember
 * to call: the workspace's `project.json` tab appearing or going away, and the project state
 * ceasing to point at the bound document (a project switch, or a reload that re-parsed the file).
 *
 * @returns {Tab}
 */
export function projectConfigDocument(): Tab {
  const state = requireProjectState();
  const open = openConfigTab();
  if (
    _bound &&
    (_bound !== (open ?? _detached) || toRaw(_bound.doc.document) !== state.projectConfig)
  ) {
    unbind();
  }
  if (_bound) {
    return _bound;
  }
  if (open) {
    return bind(open);
  }
  _detached = createTab({
    document: (state.projectConfig ?? {}) as unknown as Record<string, unknown>,
    documentPath: PROJECT_CONFIG_PATH,
    id: PROJECT_CONFIG_PATH,
  });
  return bind(_detached);
}

// ─── The chokepoint ───────────────────────────────────────────────────────────

/** What a commit did. A write failure is reported, never thrown — the caller decides the tier. */
export interface ProjectConfigCommit {
  ok: boolean;
  /** The platform's rejection, when the write failed. */
  error?: unknown;
}

/** Extensions, as a comparable value — the enabled-extension surface gate. */
function extensionsKey(config: ProjectConfig): string {
  return JSON.stringify(config.extensions ?? null);
}

/** Rebuild the format registry and the contributed settings sections after an `extensions` edit. */
async function refreshExtensionSurfaces(): Promise<void> {
  const { loadFormats, refreshExtensionUi, refreshFormats } = await import("../format/format-host");
  refreshFormats();
  void loadFormats();
  refreshExtensionUi(getPlatform());
}

/**
 * Commit the project configuration: one transaction, one serialisation, one error path.
 *
 * Two calling styles, because the surfaces have two shapes. Pass a `patch` and its top-level keys
 * are merged onto the document (a value of `undefined` CLEARS the key — `JSON.stringify` drops it,
 * which is how General Settings removes a production URL). Pass nothing and the caller has already
 * mutated the live configuration in place, which is what the master-detail editors do; the empty
 * transaction is what puts that mutation into the log.
 *
 * Either way the object committed is the one the CALLER was editing, read before the bind: a
 * `project.json` tab that appeared since the last commit is adopted here, and adopting it repoints
 * `projectState.projectConfig` at the tab's own parse of the file. Committing the document instead
 * would silently discard whatever the form had just written into the object it rendered from. The
 * two are one object again by the time this returns.
 *
 * A failed write leaves the document dirty and files a Problem (§16): it is about a named file and
 * it must be fixed, so it belongs in a list that keeps it rather than a toast that erases it. ⌘S on
 * the `project.json` tab is the retry, and it writes the same bytes this does. A commit that cannot
 * be applied at all — an edited configuration meeting a document with unsaved authoring of its own
 * — files the same kind of Problem and writes nothing, because picking a winner is what made the
 * loss silent in the first place.
 *
 * @param {Partial<ProjectConfig>} [patch]
 * @returns {Promise<ProjectConfigCommit>}
 */
export async function commitProjectConfig(
  patch?: Partial<ProjectConfig>,
): Promise<ProjectConfigCommit> {
  // Before the bind, not after it: adopting a `project.json` tab repoints `projectState` at the
  // Tab's own parse, and the caller has already mutated the object it rendered from.
  const live = liveConfig();
  const tab = projectConfigDocument();
  await seedCommitted();
  const current = toRaw(tab.doc.document) as unknown as ProjectConfig;
  const currentText = serializeProjectConfig(current);

  // Two objects that disagree — whichever one loses, an edit written into it is lost. Null when
  // There is one object, or two saying the same thing, which is every commit after the first.
  const rival =
    live && live !== current && serializeProjectConfig(live) !== currentText ? live : null;

  if (rival && tab.doc.dirty) {
    /* The document holds unsaved authoring of its own — the source editor's, since a successful
       commit always leaves it clean — and the live configuration holds an edit the document has
       never seen. Applying either one discards the other, so neither is applied: §16 files the
       write that cannot be applied, which is the one outcome silence is not allowed to be.
       `ai-project-tools.ts`'s `write_file` refuses a dirty tab on exactly these grounds. */
    const error = new Error(`${PROJECT_CONFIG_PATH} has unsaved changes in its editor tab`);
    notify.error(
      `Could not save ${PROJECT_CONFIG_PATH} — the file is open with unsaved changes. Save or ` +
        `revert that tab, then make the settings change again.`,
      { key: `save:${PROJECT_CONFIG_PATH}`, path: PROJECT_CONFIG_PATH, source: "Settings" },
    );
    return { error, ok: false };
  }

  const base = rival ?? current;
  const next = patch ? ({ ...base, ...patch } as ProjectConfig) : base;
  const text = serializeProjectConfig(next);

  // Nothing the file does not already say: no transaction, no write, and therefore no diff. The
  // Dirty conjunct is what makes a retry after a failed write always write; the rival conjunct is
  // What keeps the handover from being skipped when the file already agrees with the live config
  // But the DOCUMENT does not.
  if (!rival && !tab.doc.dirty && text === _committed) {
    return { ok: true };
  }

  const before = extensionsKey(current);
  transactDoc(tab, (t) => {
    const doc = t.doc.document as unknown as Record<string, unknown>;
    if (rival) {
      replaceContents(doc, rival);
    }
    for (const [key, value] of Object.entries(patch ?? {})) {
      doc[key] = value;
    }
  });

  // Serialised from what the transaction actually LANDED, not from the `next` computed above: a
  // Gate on `transactDoc` can refuse a mutation, and writing the value it refused would put the
  // File and the document into the one disagreement this module exists to make impossible.
  const config = toRaw(tab.doc.document) as unknown as ProjectConfig;
  const output = serializeProjectConfig(config);
  try {
    await getPlatform().writeFile(PROJECT_CONFIG_PATH, output);
  } catch (error) {
    notify.error(`Could not save ${PROJECT_CONFIG_PATH} — ${errorMessage(error)}`, {
      key: `save:${PROJECT_CONFIG_PATH}`,
      path: PROJECT_CONFIG_PATH,
      source: "Settings",
    });
    return { error, ok: false };
  }
  _committed = output;
  tab.doc.dirty = false;
  if (extensionsKey(config) !== before) {
    await refreshExtensionSurfaces();
  }
  return { ok: true };
}

/**
 * Adopt a configuration that is ALREADY on disk into the document.
 *
 * The other direction of the handover. `services/ai-project-tools.ts`'s `write_file` writes
 * `project.json` straight to the platform — it has to, the model authors the whole file as text —
 * and then has to tell the app what it wrote. Announcing it by constructing a fresh object and
 * assigning it to `projectState.projectConfig` is what left a rival beside the document: the next
 * settings commit read the document, which still held the PREVIOUS configuration, and persisted the
 * assistant's write back out of existence. Putting the bytes into the document instead keeps the
 * one-object rule true, and the state sync follows from the bind effect like every other change.
 *
 * `skipHistory`, because this is a RELOAD and not an edit: the file already says this, and
 * `write_file` tells the model in as many words that its disk writes are not undoable. A history
 * entry here would offer ⌘Z a change it could not take back from the file.
 *
 * @param {ProjectConfig} config The configuration as written — already past the schema gate.
 * @returns {Promise<void>}
 */
export async function adoptProjectConfig(config: ProjectConfig): Promise<void> {
  if (!requireProjectState()) {
    // No project state is no configuration document either ({@link projectConfigDocument} reads
    // One). The workspace copy is then the only thing there is to keep true.
    setWorkspaceProject(workspace.projectRoot, config);
    return;
  }
  const tab = projectConfigDocument();
  transactDoc(
    tab,
    (t) => replaceContents(t.doc.document as unknown as Record<string, unknown>, config),
    { skipHistory: true },
  );
  tab.doc.dirty = false;
  // Settle a read already in flight before saying what the file holds, or it would resolve after
  // This line with the PREVIOUS bytes and make the next real commit look like a no-op.
  await seedCommitted();
  _committed = serializeProjectConfig(config);
}
