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
