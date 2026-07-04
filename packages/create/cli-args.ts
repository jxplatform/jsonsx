/** Argument parsing for the create-jxsuite CLI, split out so it can be unit-tested in isolation. */

export interface CliArgs {
  /** Destination directory (first non-flag argument). */
  dest?: string;
  /** Starter template id from `--template <id>` / `--template=<id>`. */
  template?: string;
}

/**
 * Parse the create-jxsuite argument list: the first non-flag token is the destination directory;
 * `--template <id>` or `--template=<id>` selects a starter template.
 *
 * @param {string[]} argv — arguments after the node/script path (i.e. process.argv.slice(2))
 * @returns {CliArgs}
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let template: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    // Safe: i < argv.length. The cast sheds `undefined` from noUncheckedIndexedAccess.
    const arg = argv[i] as string;
    if (arg === "--template") {
      template = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--template=")) {
      template = arg.slice("--template=".length);
    } else {
      positional.push(arg);
    }
  }
  return {
    ...(positional[0] !== undefined ? { dest: positional[0] } : {}),
    ...(template !== undefined ? { template } : {}),
  };
}
