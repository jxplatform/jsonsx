import { registerPlatform } from "@jxsuite/studio/platform";
import { hydrateGithubToken } from "@jxsuite/studio/github-auth";
import { createDesktopPlatform } from "./platform";

// CreateDesktopPlatform reads ?token from the shell URL to authenticate its WS upgrade.
const platform = createDesktopPlatform();
registerPlatform(platform);

/* Ask the 0600 credential store whether a GitHub token exists, so the accounts pane can say so on
   the first frame. The answer is a boolean: the token itself stays out of the webview until a
   sign-in asks for it. */
try {
  const { stored } = await platform.githubAuth.status();
  hydrateGithubToken(stored);
} catch {
  // An unreachable store just means the accounts pane says "not signed in" until a sign-in runs.
}

// Strip ?token from the address bar after boot so it never leaks (e.g. via a Referer header or a
// Copy-pasted URL). The platform already captured it above; the loopback bind + only-our-HTML-at-
// Origin invariant is the real boundary. Best-effort: guarded for non-browser (test) environments.
try {
  const url = new URL(location.href);
  if (url.searchParams.has("token")) {
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
} catch {}
