/**
 * The `Collaborate:` command family — the entry point and the exit co-editing has never had (§7.4).
 *
 * Collaboration in Studio has been a thing that HAPPENS to a document: a session attaches because
 * the platform said the file was shared, presence chips appear in the toolbar, and there is no verb
 * anywhere in the app for starting it, inviting anybody, following someone, or stopping. The
 * palette had no `Collaborate:` rows at all, and `CATEGORIES` has carried the name since P2 with
 * nothing filed under it.
 *
 * Five records, each registered here — in the module that owns the machinery, per P2's rule — and
 * composed by `commands/app-commands.ts`. Every one is idempotent or refuses with a `requires`
 * sentence, and none of them is a `toggle*` without a `set*` beside it: `collab.setEnabled` is the
 * setter, `collab.stop` is the same setter's `false` and exists because "stop sharing" is what a
 * person actually looks for in a palette.
 */

import { collabState } from "./collab-state";
import { isCollabEnabled, setCollabEnabled } from "./collab-session";
import { notify } from "../services/notify";
import { activeTab } from "../workspace/workspace";
import { booleanArg, booleanProperty, stringProperty } from "../commands/command-args";

import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { Tab } from "../tabs/tab";

/** The tab a Collaborate verb acts on. */
function tab(): Tab | null {
  return activeTab.value;
}

/** True while the active tab has a live session — what Stop and Follow require. */
function sessionLive(): boolean {
  const active = tab();
  return Boolean(active && collabState(active).active);
}

/**
 * A shareable reference to the current session.
 *
 * The document path IS the session key — `platform.collab(path)` is how every attach resolves — so
 * the link is derived, not minted. That is the whole reason this command can exist without a server
 * round trip, and the reason it cannot promise the recipient has access: it names a room, it does
 * not grant one.
 *
 * @param {Tab} active
 * @returns {string}
 */
export function sessionLink(active: Tab): string {
  const path = active.documentPath ?? "";
  return `jx://collab/${path.replace(/^\.?\//, "")}`;
}

/**
 * The Collaborate verbs.
 *
 * @returns {AnyCommand[]}
 */
export function collabCommands(): AnyCommand[] {
  return [
    {
      id: "collab.setEnabled",
      title: "Collaborate: Share this document",
      category: "Collaborate",
      level: "document",
      menus: ["palette"],
      group: "1_session",
      requires: "an open document",
      when: () => Boolean(tab()?.documentPath),
      args: {
        additionalProperties: false,
        properties: {
          enabled: booleanProperty("True to attach a live session, false to leave it."),
        },
        required: ["enabled"],
        type: "object",
      },
      run: (_ctx, args) => {
        const enabled = booleanArg("collab.setEnabled", args, "enabled");
        const active = tab();
        if (!active) {
          return;
        }
        if (isCollabEnabled(active) === enabled) {
          return;
        }
        setCollabEnabled(active, enabled);
        notify.info(
          enabled
            ? "Connecting this document to its collaboration session…"
            : "Left the collaboration session for this document.",
          { source: "Collaboration" },
        );
      },
    },
    {
      id: "collab.stop",
      title: "Collaborate: Stop sharing",
      category: "Collaborate",
      level: "document",
      menus: ["palette"],
      group: "1_session",
      requires: "a live collaboration session",
      when: () => Boolean(tab()?.documentPath),
      enablement: sessionLive,
      run: () => {
        /* The idempotent setter, said the way a person looks for it in a palette. `setEnabled
           false` and this are one behaviour with two names, which is what stops "Stop" from being
           a toggle with no setter beside it. */
        const active = tab();
        if (!active || !isCollabEnabled(active)) {
          return;
        }
        setCollabEnabled(active, false);
        notify.info("Left the collaboration session for this document.", {
          source: "Collaboration",
        });
      },
    },
    {
      id: "collab.copyLink",
      title: "Collaborate: Copy session link",
      category: "Collaborate",
      level: "document",
      menus: ["palette"],
      group: "2_invite",
      requires: "a live collaboration session",
      when: () => Boolean(tab()?.documentPath),
      enablement: sessionLive,
      run: async () => {
        const active = tab();
        if (!active) {
          return;
        }
        const link = sessionLink(active);
        try {
          await navigator.clipboard.writeText(link);
        } catch (error) {
          notify.error(
            `Could not copy the session link — ${error instanceof Error ? error.message : String(error)}`,
            { detail: link, source: "Collaboration" },
          );
          return;
        }
        notify.success("Session link copied. It names the room; it does not grant access to it.", {
          source: "Collaboration",
        });
      },
    },
    {
      id: "collab.follow",
      title: "Collaborate: Follow a collaborator",
      category: "Collaborate",
      level: "document",
      menus: ["palette"],
      group: "3_presence",
      requires: "another person in this session",
      when: () => Boolean(tab()?.documentPath),
      enablement: () => {
        const active = tab();
        return Boolean(active && collabState(active).peers.length > 0);
      },
      args: {
        additionalProperties: false,
        properties: {
          login: stringProperty("The collaborator's login, as shown on their presence chip."),
        },
        required: [],
        type: "object",
      },
      run: (_ctx, args) => {
        const active = tab();
        if (!active) {
          return;
        }
        const login = (args as { login?: string } | undefined)?.login;
        const { peers } = collabState(active);
        const peer = login ? peers.find((p) => p.state.user.login === login) : peers[0];
        if (!peer) {
          notify.warn(
            login ? `${login} is not in this session.` : "Nobody else is in this session.",
            { source: "Collaboration" },
          );
          return;
        }
        const where = peer.state.focusedPath;
        if (!where) {
          notify.info(`${peer.state.user.login} is not in a document right now.`, {
            source: "Collaboration",
          });
          return;
        }
        notify.info(`${peer.state.user.login} is in ${where}.`, {
          action: "file.open",
          actionArgs: { path: where },
          source: "Collaboration",
        });
      },
    },
    {
      id: "collab.showStatus",
      title: "Collaborate: What is happening in this document?",
      category: "Collaborate",
      level: "document",
      menus: ["palette"],
      group: "3_presence",
      requires: "an open document",
      when: () => Boolean(tab()),
      run: () => {
        const active = tab();
        if (!active) {
          return;
        }
        const state = collabState(active);
        /* This is the honesty command: every one of these states used to be either invisible or
           spelled "detached", and the freeze in particular looked exactly like a bug (§7.4). */
        const lines = [
          `Status: ${state.status}${state.attachError ? ` — ${state.attachError}` : ""}`,
          `People here: ${state.peers.length === 0 ? "just you" : state.peers.map((p) => p.state.user.login).join(", ")}`,
          state.readOnly
            ? "You have read access: your edits stay on this machine."
            : "You can publish edits to this session.",
          state.sourceCanonical
            ? "Someone holds the code view, so structural edits are paused. This is not an error."
            : "Structural editing is available.",
          "Undo only takes back your own edits, never a collaborator's.",
        ];
        notify.info(lines[0]!, { detail: lines.join("\n"), source: "Collaboration" });
      },
    },
  ];
}

/**
 * Register the Collaborate family.
 *
 * @param {CommandRegistry} registry
 */
export function registerCollabCommands(registry: CommandRegistry): void {
  registry.registerAll(collabCommands());
}
