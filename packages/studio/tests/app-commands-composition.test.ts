/**
 * Every command factory in `src/` is composed into `appCommandSet()`.
 *
 * Twice now a phase has defined command records, tested them, and shipped them unreachable. P4 left
 * `help.about` out; P7 left FOURTEEN out — `sourceControlCommands`, `publishCommands`,
 * `gridViewCommands` and `redirectsCommands` — so Push, Deploy, Save View and the whole Redirects
 * editor were absent from the palette with no other entry point, while their own unit tests passed
 * and `check-command-levels` reported a healthy number of the records it COULD see.
 *
 * It is a structural hazard, not carelessness: a record is registered in the module that owns it,
 * and `commands/app-commands.ts` is the one shared file no workstream owns. Nothing failed, because
 * a command that is never composed is simply absent — and absence is what every other check reads
 * as "fine".
 *
 * So the guard is mechanical. Any `export function …Commands(): AnyCommand[]` under `src/` is a
 * contribution point by construction, and must appear in the composition. Adding a factory and
 * forgetting to spread it now fails here, naming the factory and the file.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { appCommandSet } from "../src/commands/app-commands";

const SRC = resolve(import.meta.dir, "..", "src");
// `defaults.ts` counts as part of the projection because `app-commands.ts` spreads
// `...defaultCommands(...)`; a factory folded into the base set is projected through it.
const COMPOSITION =
  readFileSync(join(SRC, "commands", "app-commands.ts"), "utf8") +
  readFileSync(join(SRC, "commands", "defaults.ts"), "utf8");
const BOOTSTRAP = readFileSync(join(SRC, "studio.ts"), "utf8");

/**
 * Factories with no call site in `src/` on purpose, each with the reason.
 *
 * The list only ratchets down.
 */
const UNCALLED = new Map<string, string>();

/** Every `.ts` file under `src/`, excluding tests and type-only declarations. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * `export function fooCommands(): AnyCommand[]` — the contribution-point shape.
 *
 * The return type is part of the pattern on purpose. A `registerFooCommands(registry)` returns void
 * and contributes by a different mechanism (the bootstrap calls it); only a factory that HANDS BACK
 * records has to be spread into the composition, and only those can go silently missing from it.
 */
const FACTORY = /^export function (\w*Commands)\s*\([^)]*\)\s*:\s*(?:Any)?Command\[\]/gm;

describe("command composition", () => {
  test("every factory in appCommandSet() is also registered at boot", () => {
    // There are two roots and they are different code paths. `appCommandSet()` is what
    // `check-command-levels` counts and what `docs/studio/interface/commands.md` is generated from;
    // The RUNNING APP registers through `register*(commandRegistry)` calls in `studio.ts`. A record
    // In one and not the other is invisible exactly where it matters: P7 left four factories in
    // Neither (Push, Deploy, Save View and the whole Redirects editor absent from the palette), and
    // P4 put `help.about` in the projection alone — so CI counted a command the app could not run,
    // In the same change that deleted the button it replaced.
    const files = sourceFiles(SRC);
    const texts = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
    const unregistered: string[] = [];
    let found = 0;

    for (const [file, text] of texts) {
      for (const match of text.matchAll(FACTORY)) {
        const name = match[1]!;
        found += 1;
        if (UNCALLED.has(name) || !COMPOSITION.includes(`...${name}(`)) {
          continue;
        }
        // Three wired-up paths, and a factory needs one of them. What neither P7's four nor
        // P4's `help.about` had was ANY of them: their `register*` existed but the bootstrap never
        // Called it, or there was no register at all and only the projection spread — so CI counted
        // A command the app could not run.
        const registrars = [...text.matchAll(/^export function (register\w+)/gm)].map((m) => m[1]);
        const booted =
          BOOTSTRAP.includes(`${name}(`) ||
          registrars.some((r) => r !== undefined && BOOTSTRAP.includes(`${r}(`)) ||
          [...texts].some(
            ([other, body]) =>
              !other.endsWith(join("commands", "app-commands.ts")) &&
              new RegExp(`\\.\\.\\.${name}\\s*\\(|registerAll\\([^)]*${name}\\s*\\(`).test(body) &&
              (other !== file || new RegExp(`\\.\\.\\.${name}\\s*\\(`).test(body)),
          );
        if (!booted) {
          unregistered.push(`${name}() — ${relative(SRC, file)}`);
        }
      }
    }

    expect(found).toBeGreaterThan(10);
    expect(
      unregistered,
      "in appCommandSet() but never registered at boot — CI counts a command the app cannot run",
    ).toEqual([]);
  });

  test("every factory the BOOTSTRAP calls is also in the projection", () => {
    /* The mirror of the case above, and the one that had no guard.
     *
     * `studio.ts` composes the running registry; `appCommandSet()` is what CI reads. A factory in
     * the projection and not the bootstrap is a command CI counts and the app cannot run — that is
     * the test above. A factory in the BOOTSTRAP and not the projection is a command the app runs
     * and CI cannot see: its placements go unchecked by `check-command-levels`, it is missing from
     * the generated keyboard sheet, and its chord is invisible to every reader of the docs. Both
     * of those shipped. `formatCommands()` was the second kind for the length of one commit, and
     * the id-literal scan below could not see it because its ids are built from a template.
     */
    /* Factories the projection holds INDIRECTLY, each with the path. `viaRegistration()` builds a
       throwaway registry and reads it back, so anything a `register*` it calls contributes is in
       `appCommandSet()` under a name this text scan cannot see. The list only ratchets down, and an
       entry that stops being true fails the staleness case below. */
    const INDIRECT = new Map<string, string>([
      ["paneCommands", "spread into tabCommands(), which viaRegistration() registers"],
    ]);
    const bootstrapped = [...BOOTSTRAP.matchAll(/\b(\w*Commands)\s*\(/g)]
      .map((match) => match[1]!)
      .filter((name) => name.endsWith("Commands") && !name.startsWith("register"));
    const missing = [...new Set(bootstrapped)].filter(
      (name) => !COMPOSITION.includes(`...${name}(`) && !UNCALLED.has(name) && !INDIRECT.has(name),
    );
    expect(
      missing,
      "called by the bootstrap but absent from appCommandSet() — the app runs a command no check " +
        "can see",
    ).toEqual([]);
  });

  test("every command record written in src/ is IN the projection", () => {
    /* The other direction, and it had no guard at all.
     *
     * The test above catches a factory that is projected but never registered — CI counting a
     * command the app cannot run. The reverse is just as invisible and lasted just as long: TEN
     * records the app registers at boot (⌘C, ⌘X, ⌘V, Enter, the three structural arrows and the
     * three zoom chords, through `editor/shortcuts.ts`'s private `canvasCommands()`) were absent
     * from `appCommandSet()`, so `check-command-levels` never validated their placements and
     * `docs/studio/interface/shortcuts.md` — the sheet generated FROM this projection — did not
     * list Copy.
     *
     * The discriminator is the id shape the registry itself enforces: a command id is
     * `namespace.verb`, a panel id is a bare word. Pairing that with a `level:` field nearby is
     * what separates a record from an ordinary object with an `id` — the window is deliberately
     * generous, because a record is free to order its fields however it likes.
     */
    const ID = /^\s*id: "([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)",\s*$/;
    const LEVEL = /^\s*level: "(?:application|project|document|selection)",/m;
    const projected = new Set(appCommandSet().map((command) => command.id));
    const orphans: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        const match = ID.exec(line);
        if (!match) {
          continue;
        }
        const window = lines.slice(Math.max(0, index - 14), index + 14).join("\n");
        if (!LEVEL.test(window) || projected.has(match[1]!)) {
          continue;
        }
        orphans.push(`${match[1]} — ${relative(SRC, file)}:${index + 1}`);
      }
    }

    expect(
      orphans,
      "a command record src/ declares that appCommandSet() omits — the level check, the chrome " +
        "budget and the generated keyboard sheet are all blind to it",
    ).toEqual([]);
  });

  test("no two palette rows print the same sentence", () => {
    // A palette row IS a name. `inspector.focus.assistant` and `view.setAssistant` were both
    // "View: Show Assistant" with `menus: ["palette"]`, so the same sentence appeared in two level
    // Groups with two different chords — one document-level with ⌘⇧4, one application-level with
    // None. Nothing could see it: both records are legal, both are composed, both are registered,
    // And `check-command-levels` counts placements rather than reading titles.
    //
    // The rule is only about the PALETTE, deliberately. Two surfaces may legitimately render the
    // Same title (the status bar's warning count and the Bottom dock's tab both say "Problems"),
    // Because there the region disambiguates. In a flat, searchable list nothing does.
    const seen = new Map<string, string[]>();
    for (const command of appCommandSet()) {
      if (!(command.menus ?? []).includes("palette")) {
        continue;
      }
      const row = `${command.category}: ${command.title}`;
      seen.set(row, [...(seen.get(row) ?? []), command.id]);
    }
    const duplicates = [...seen]
      .filter(([, ids]) => ids.length > 1)
      .map(([row, ids]) => `"${row}" ← ${ids.join(", ")}`);
    expect(
      duplicates,
      'two palette rows with one name — give one of them `menus: ["never"]` or a distinct title',
    ).toEqual([]);
  });

  test("every exemption still names a real factory, so the list cannot go stale", () => {
    const all = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(FACTORY)) {
        all.add(match[1]!);
      }
    }
    for (const name of UNCALLED.keys()) {
      expect(all.has(name), `${name} is exempted but no longer exists — delete the entry`).toBe(
        true,
      );
    }
  });
});
