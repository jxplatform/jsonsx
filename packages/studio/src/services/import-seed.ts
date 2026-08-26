/**
 * Import-seed.ts — the New Project Import form's hand-off to the assistant.
 *
 * The wizard collects a URL, crawl options, a model and a brief, then closes; the assistant takes
 * the turn and runs the import as a tool call. This holds what the form gathered for the one turn
 * that consumes it.
 *
 * **Module state, and deliberately NOT a copy of `agent-seed.ts`.** That one uses localStorage keyed
 * by project root because the project it seeds opens in a NEW WINDOW, and the key is the
 * cross-window channel. Neither half of that applies here: the project does not exist yet at
 * hand-off time, so there is no root to key on, and the assistant taking the turn is in this window
 * — `import_site` is `no-project` tiered precisely because it runs before there is a project. A
 * localStorage clone would be a channel with nothing on the other end and a key that cannot be
 * computed.
 *
 * @license MIT
 */

/** What the wizard gathered, as the tool needs it. */
export interface ImportBrief {
  /** Absolute http(s) URL of the site to clone. */
  url: string;
  /** Human project name (the wizard prefills it from the hostname). */
  name: string;
  /** Absolute destination directory, already resolved from Location + folder name. */
  directory: string;
  depth: number;
  maxPages: number;
  aiComponents: boolean;
  /** Empty means "whatever the assistant would use" (`preferredModel()`). */
  model: string;
  /** What the user wants done with the site once it is cloned. May be empty. */
  prompt: string;
}

let _brief: ImportBrief | null = null;

/**
 * Store the brief the assistant's next turn will act on.
 *
 * @param {ImportBrief} brief
 */
export function setPendingImportBrief(brief: ImportBrief): void {
  _brief = brief;
}

/**
 * The brief without consuming it — what `import_site` reads to fill in a destination the model was
 * never told and must not invent.
 *
 * @returns {ImportBrief | null}
 */
export function pendingImportBrief(): ImportBrief | null {
  return _brief;
}

/**
 * Forget the brief.
 *
 * There is deliberately no consume-on-read here, unlike `agent-seed.ts`. TWO readers need the same
 * brief and they read at different moments: the panel, to compose the turn, and `import_site`, for
 * the destination — which is minutes later, after the model has decided to call it. A read that
 * cleared would leave the tool inventing a path the user never chose. The tool clears it once the
 * import has actually run.
 */
export function clearPendingImportBrief(): void {
  _brief = null;
}

// ─── The hand-off itself ────────────────────────────────────────────────────

/**
 * The assistant's side of the hand-off, registered at boot.
 *
 * A late-bound slot for the same reason `services/project-adoption.ts` is one: the New Project
 * wizard must not import `panels/ai-panel.ts`. That import is not just a layering preference — the
 * panel constructs a `DocumentAssistant` singleton at module load, so reaching for it from
 * `new-project/` drags a live assistant into every surface that opens the wizard.
 */
let _handoff: ((brief: ImportBrief) => Promise<void>) | null = null;

/**
 * Register the assistant's hand-off (studio.ts boot).
 *
 * @param {(brief: ImportBrief) => Promise<void>} fn
 */
export function setImportHandoff(fn: (brief: ImportBrief) => Promise<void>): void {
  _handoff = fn;
}

/**
 * Start the import as an assistant turn.
 *
 * A no-op with nothing registered — a reduced host (a test fixture, an embedder without the
 * assistant) would otherwise crash on a button the wizard should simply not have offered.
 *
 * @param {ImportBrief} brief
 */
export async function runImportHandoff(brief: ImportBrief): Promise<void> {
  await _handoff?.(brief);
}
