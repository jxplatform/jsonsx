/**
 * Timing.ts — Studio's latency vocabulary.
 *
 * Every user-visible delay in Studio expresses one of a small number of intents: "wait until the
 * user stops typing", "hold a message on screen long enough to read", "check the repo again". Each
 * call site used to pick its own number for its intent, so the same intent shipped as 350, 400 and
 * 600 ms in three different panels and a retune meant a grep. Name the intent once here, import the
 * name, and the retune is a single edit.
 *
 * All values are milliseconds. The two input debounces are contractual:
 * `specs/studio-ui-guidelines.md` §4.4 fixes 400 ms for text inputs and 500 ms for code/expression
 * textareas. Do not change either without releasing that spec section.
 */

/**
 * Text/style input debounce — the §4.4 standard. Long enough that a normal typing cadence produces
 * one commit per pause rather than one per keystroke, short enough that the canvas still feels
 * live.
 */
export const INPUT_DEBOUNCE = 400;

/**
 * Code and expression textareas — the §4.4 standard. Longer than {@link INPUT_DEBOUNCE} because
 * each commit re-parses source (or re-lints), and because half-typed code is usually invalid, so
 * committing eagerly just burns work on states the user is about to leave.
 */
export const CODE_DEBOUNCE = 500;

/**
 * Draft-layer live preview (ui/field-input.ts) — how long after a keystroke the in-progress draft
 * is pushed to the document so the canvas updates while the field stays focused. Deliberately below
 * {@link INPUT_DEBOUNCE}: this commit is provisional (the draft survives it, and blur/Enter commits
 * again), so it can afford to fire sooner than a committing input.
 */
export const LIVE_PREVIEW = 350;

/**
 * Status-bar message lifetime — how long a transient message stays before the bar reverts to the
 * selection breadcrumb. Roughly the time to read a short sentence without the bar feeling sticky.
 */
export const STATUS_MESSAGE = 3000;

/**
 * Git status poll while the Git panel is open. Deliberately coarse: it exists to notice changes
 * made outside Studio, and each tick shells out to git, so a faster cadence buys little and costs
 * I/O.
 */
export const POLL_GIT = 30_000;
