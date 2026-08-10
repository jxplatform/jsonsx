/**
 * Publish-commands.ts — the `Publish:` family (plan §9.5), defined beside the deploy it drives.
 *
 * Two unrelated operations were called "Publish" and neither was a command. `publishToGithub`
 * created a git repository; `openPublishPanel` connected Cloudflare Pages — and it had **zero call
 * sites in `src/`**, reachable only through the screenshot runner's seed, so the one flow that
 * ships a site was, in the shipped app, unreachable. The toolbar's Publish button had already gone
 * with the toolbar, and nothing replaced it.
 *
 * Three records, always reachable, each disabled with the one sentence that says why:
 *
 * | id                      | what it does                                              |
 * | ----------------------- | --------------------------------------------------------- |
 * | `publish.setUp`         | opens the provider connection flow                        |
 * | `publish.deploy`        | pushes the branch and asks Cloudflare what it did with it |
 * | `publish.openDashboard` | opens the connected Pages project on Cloudflare           |
 *
 * **`runDeploy` is an Activity, not a toast.** A deploy pushes a branch and then waits on a build
 * that is happening somewhere else; that is the definition of the long operation §7.3 gave the
 * Activity tab, and `fail()` raises the Problem so the failure outlives the run and carries a
 * Retry. The caller therefore never also notifies (§16).
 *
 * **No credential is read here.** Whether a provider is reachable is a capability question, and
 * whether one is connected is a `project.json` question; the token that proves it is read only by
 * `platforms/devserver.ts` on its way to the same-origin proxy (`studio.md` §15 rule 1).
 *
 * **The panel is imported lazily** so this module carries no DOM at import time: `commands/
 * app-commands.ts` is loaded by three CI checks in a bare Bun process, and a module that opens a
 * modal at import would break all three.
 */

import { getPlatform } from "../platform";
import { beginActivity } from "../panels/activity-panel";
import { currentDeploy, noteDeployment } from "./deploy-checklist";
import { errorMessage } from "@jxsuite/schema/parse";
import { latestDeployment, platformSupportsPublish } from "./pages-service";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/**
 * How long the deploy waits for Cloudflare to admit the push happened.
 *
 * Six attempts five seconds apart: a Pages build takes minutes, so this is not "wait for the build"
 * — it is "wait for the deployment RECORD", which appears within seconds of the push. The activity
 * says which of the two it is waiting for, because a progress line that implies the former and
 * delivers the latter is the dishonesty §7.3 exists to end.
 */
export const DEPLOY_POLL = { attempts: 6, delayMs: 5000 } as const;

/** Cloudflare's dashboard, for a connected project. */
export function dashboardUrl(accountId: string, projectName: string): string {
  return `https://dash.cloudflare.com/${accountId}/pages/view/${projectName}`;
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

/**
 * Push the current branch and report what Cloudflare made of it.
 *
 * @param options Poll shape, so a test does not wait 30 real seconds.
 * @returns Whether the push succeeded — NOT whether the build did, which is Cloudflare's to say.
 */
export async function runDeploy(
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const deploy = currentDeploy();
  let cancelled = false;
  const activity = beginActivity({
    cancel: () => {
      cancelled = true;
    },
    source: "Publish",
    status: "Starting…",
    steps: ["Push to the remote", "Ask Cloudflare for the deployment"],
    title: "Deploy",
  });

  activity.step("Push to the remote");
  try {
    await getPlatform().gitPush({ setUpstream: true });
    activity.log("Pushed the current branch.");
  } catch (error) {
    // Logged BEFORE the failure: `fail()` snapshots the log into the Problem's `detail`, so a line
    // Appended afterwards would be visible in the Activity row and absent from the report of it.
    activity.log(errorMessage(error));
    activity.fail("Could not push to the remote.", { action: "git.push" });
    return false;
  }

  if (!deploy) {
    // Reachable when `enablement` was true at click time and the config changed underneath — a
    // Push is still a real outcome, so this ends as a success that says exactly what it did.
    activity.done("Pushed. No provider is connected, so nothing was asked to build it.");
    return true;
  }

  activity.step("Ask Cloudflare for the deployment");
  const attempts = options.attempts ?? DEPLOY_POLL.attempts;
  const delayMs = options.delayMs ?? DEPLOY_POLL.delayMs;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (cancelled) {
      return false;
    }
    let info;
    try {
      info = await latestDeployment(deploy);
    } catch (error) {
      activity.log(errorMessage(error));
      activity.fail("Cloudflare did not answer.", { action: "publish.deploy" });
      return false;
    }
    if (info) {
      noteDeployment(info);
      activity.log(`${info.stage}: ${info.status} — ${info.url}`);
      activity.done(`${info.stage}: ${info.status}`);
      return true;
    }
    await sleep(delayMs);
  }
  if (cancelled) {
    return false;
  }
  noteDeployment(null);
  activity.done("Pushed. Cloudflare has not reported a deployment yet.");
  return true;
}

/**
 * The three records.
 *
 * `enablement` reads `platformSupportsPublish()` rather than a `capability.*` key because there is
 * no `publish` capability yet — adding one is a `commands/context.ts` + `commands/live-context.ts`
 * change, and §5.2 is explicit that PAL differences belong there. Until it exists this is the one
 * `if (platform.x)` the family carries, in the one place a reader looks for it.
 */
export function publishCommands(): AnyCommand[] {
  return [
    {
      category: "Publish",
      id: "publish.setUp",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "8_publish",
      /* THE CAPABILITY TERM BELONGS TO THE WHOLE FAMILY, not to its first member. All three of
         these reach Cloudflare, and only this one asked whether the host can: `currentDeploy()`
         reads config stored IN THE PROJECT, so a repository cloned or scaffolded with a deploy
         already configured carries it onto a host whose PAL has no `cfApi`. In that state Set Up
         Publishing was correctly disabled while Deploy was enabled and ran — pushing the branch,
         then failing at `latestDeployment` with "Cloudflare did not answer" after the push had
         already gone out. The refusal that was meant to protect the family guarded one third. */
      requires: "an open project on a platform that can reach the Cloudflare API",
      when: (ctx) => ctx.project.open,
      // `when` already asked about the project.
      enablement: () => platformSupportsPublish(),
      aiTool: {
        description:
          "Open the publishing set-up flow, which connects this project to a Cloudflare Pages " +
          "project that rebuilds on every push.",
        name: "set_up_publishing",
      },
      run: async () => {
        const { openPublishPanel } = await import("./publish-panel");
        openPublishPanel();
      },
      title: "Set Up Publishing",
    },
    {
      category: "Publish",
      id: "publish.deploy",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "8_publish",
      requires:
        "a repository with a remote and a connected deploy provider, on a platform that can " +
        "reach the Cloudflare API",
      when: (ctx) => ctx.project.open,
      enablement: (ctx) =>
        ctx.project.isRepo && currentDeploy() !== undefined && platformSupportsPublish(),
      aiTool: {
        description:
          "Push the current branch so the connected provider builds it, then report the " +
          "deployment. Does not commit — commit first if there are unsaved changes.",
        name: "deploy_site",
      },
      run: async () => {
        await runDeploy();
      },
      title: "Deploy",
    },
    {
      category: "Publish",
      id: "publish.openDashboard",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "8_publish",
      requires: "a connected deploy provider, on a platform that can reach the Cloudflare API",
      when: (ctx) => ctx.project.open,
      enablement: () => currentDeploy() !== undefined && platformSupportsPublish(),
      run: () => {
        const deploy = currentDeploy();
        if (deploy) {
          window.open(dashboardUrl(deploy.accountId, deploy.projectName), "_blank", "noopener");
        }
      },
      title: "Open Deployment Dashboard",
    },
  ];
}

/** Register the `Publish:` family. */
export function registerPublishCommands(registry: CommandRegistry): void {
  registry.registerAll(publishCommands());
}
