/**
 * The app's live region: one element, one call site, everything the app says out loud.
 *
 * **Why this exists.** `notify.ts` is the app's only way to say what happened, and its default tier
 * routes **error ⇒ problem**. But the `role="status"` region lived on the _toast_ host, and the
 * Problems panel had none at all — so a **failure reached no live region whatsoever**. The app
 * would post "Save failed", show it in a panel, and a screen-reader user would be told nothing. A
 * panel-local region would not have fixed it either: the Problems list lives in the Bottom dock,
 * and a region inside a hidden tab announces nothing.
 *
 * So the announcer is not a panel's concern. It is called from {@link notify} itself — one call
 * site, so a record cannot be posted without being announced, and a future host gets announcements
 * for free rather than having to remember.
 *
 * **Two regions, because politeness is not a style choice** (WAI-ARIA §5.2.9). `assertive`
 * interrupts whatever the reader is listening to, which is right for a failure and rude for a save.
 * `polite` waits for a pause. Mixing both in one region does not work — the attribute is read when
 * the region is created, not when the text changes — so there are two, and the severity picks.
 *
 * **The text is cleared, then set on a later frame.** A live region announces a _change_; writing
 * the same string twice is not one, so a repeated failure would be silent. Clearing first makes
 * every post a change.
 *
 * @docs studio/interface/problems-and-progress
 */

/** How urgently a message interrupts. Errors interrupt; everything else waits for a pause. */
export type Politeness = "assertive" | "polite";

const REGION_ID: Readonly<Record<Politeness, string>> = {
  assertive: "jx-live-assertive",
  polite: "jx-live-polite",
};

/**
 * Find (or create) a live region.
 *
 * It is appended to `<body>` rather than to any panel, and it is visually hidden with the clip-rect
 * idiom rather than `display: none` — a display-none region is removed from the accessibility tree
 * entirely and announces nothing, which is the classic way to ship a live region that does not
 * work.
 */
function region(politeness: Politeness): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const id = REGION_ID[politeness];
  const existing = document.querySelector<HTMLElement>(`#${id}`);
  if (existing) {
    return existing;
  }
  const node = document.createElement("div");
  node.id = id;
  node.setAttribute("aria-live", politeness);
  /* `status` for polite and `alert` for assertive: the implicit roles, so an assistive technology
     that reads roles rather than the attribute agrees with one that does the opposite. */
  node.setAttribute("role", politeness === "assertive" ? "alert" : "status");
  node.setAttribute("aria-atomic", "true");
  node.style.cssText =
    "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;" +
    "clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0";
  document.body.append(node);
  return node;
}

/**
 * Say something out loud.
 *
 * @param {string} message What to announce. Empty strings are ignored — a live region that receives
 *   one announces nothing, so posting it only hides a caller's bug.
 * @param {Politeness} [politeness] Defaults to `polite`.
 */
export function announce(message: string, politeness: Politeness = "polite"): void {
  if (message === "") {
    return;
  }
  const node = region(politeness);
  if (!node) {
    return;
  }
  node.textContent = "";
  /* A live region announces a CHANGE. Writing the same string twice is not one, so a second
     identical failure would be silent without the clear-then-set on a later turn. */
  setTimeout(() => {
    node.textContent = message;
  }, 0);
}

/** Remove both regions. Tests only — a leaked region makes the next test's assertions ambiguous. */
export function resetAnnouncer(): void {
  if (typeof document === "undefined") {
    return;
  }
  for (const id of Object.values(REGION_ID)) {
    document.querySelector(`#${id}`)?.remove();
  }
}
