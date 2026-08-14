/**
 * Pushing a project-style edit to every live canvas — one definition site.
 *
 * Plan §9.4's promise is "tune a design token and watch the page change", and until now that was
 * true of exactly one kind of canvas. `postSiteStyleToLiveHosts` skips stylebook hosts by
 * construction ({@link file://../canvas/iframe-host.ts}: `host.ready && !host.stylebook`), because
 * a specimen canvas does not render the site sheet — it renders a GENERATED document whose root
 * carries the transposed effective style, and its live channel is `styleUpdate`, not
 * `siteStyleUpdate`. So a token edited in the token editor reached every page canvas immediately
 * and left the Project Styles canvas — the one the plan puts _beside_ the editor — showing the old
 * palette until something forced a full re-render.
 *
 * Two hosts, two messages, one event. Every surface that writes `projectConfig.style` calls this
 * instead of picking one of the two posts, which is the only arrangement in which the pair cannot
 * drift apart again.
 */

import { postSiteStyleToLiveHosts, postStyleUpdateToStylebookHosts } from "../canvas/iframe-host";
import { transposeStylebookStyle } from "../panels/stylebook-doc";
import { getEffectiveStyle } from "../site-context";
import { activeTab } from "../workspace/workspace";

/**
 * Re-apply the project's style to every live canvas, in place — no re-render.
 *
 * The stylebook post needs the EFFECTIVE style (site merged with the open document's), because a
 * specimen canvas opened on a component shows that component's `& <tag>` defaults too; posting the
 * site style alone would silently drop them until the next full render. That is the one thing here
 * that reads the focused document, and it reads it to refresh a document-level canvas, not to
 * source a project-level badge.
 */
export function pushProjectStylesToCanvas(): void {
  postSiteStyleToLiveHosts();
  const style = transposeStylebookStyle(getEffectiveStyle(activeTab.value?.doc.document?.style));
  postStyleUpdateToStylebookHosts(style as Record<string, unknown>);
}
