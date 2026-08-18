import { registerPlatform } from "@jxsuite/studio/platform";
import { hydrateGithubToken } from "@jxsuite/studio/github-auth";
import { createDesktopPlatform } from "./platform";

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
