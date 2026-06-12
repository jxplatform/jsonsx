/**
 * _cli-harness.ts — Shared harness for in-process CLI entrypoint tests
 *
 * Bun records coverage only for the last evaluated instance of a module path within a process, so
 * each CLI scenario footprint lives in its own test file (run with --isolate); they all share this
 * harness. It stages process.argv, stubs process.exit with a throwing sentinel, captures console
 * output, and mocks the heavy collaborators (buildSite, runCli) via mock.module.
 */

import { mock, spyOn } from "bun:test";

export class ExitSentinelError extends Error {
  code: number | undefined;
  constructor(code?: number) {
    super(`process.exit(${code})`);
    this.name = "ExitSentinelError";
    this.code = code;
  }
}

export interface BuildResult {
  errors: string[];
  routes: number;
  files: number;
}

let buildSiteImpl: (root: string, opts: Record<string, unknown>) => Promise<BuildResult> = () =>
  Promise.resolve({ errors: [], files: 0, routes: 0 });

export const buildSiteCalls: { root: string; opts: Record<string, unknown> }[] = [];

export function setBuildSite(impl: typeof buildSiteImpl) {
  buildSiteImpl = impl;
}

mock.module("../src/site/site-build.ts", () => ({
  buildSite: (root: string, opts: Record<string, unknown>) => {
    buildSiteCalls.push({ opts, root });
    return buildSiteImpl(root, opts);
  },
}));

let runCliImpl: (src: string, out?: string) => Promise<void> = () => Promise.resolve();

export const runCliCalls: { src: string; out: string | undefined }[] = [];

export function setRunCli(impl: typeof runCliImpl) {
  runCliImpl = impl;
}

mock.module("../src/compiler.ts", () => ({
  runCli: (src: string, out?: string) => {
    runCliCalls.push({ out, src });
    return runCliImpl(src, out);
  },
}));

const originalArgv = process.argv;

/**
 * Import an entrypoint with staged argv; returns logs, errors, and the exit code (if any).
 *
 * Each entrypoint may be imported at most ONCE per process (modules are cached, and Bun records
 * coverage reliably only for plain single-instance imports), hence one scenario per test file.
 */
export async function runEntry(entry: "cli" | "compile-cli", args: string[]) {
  process.argv = ["bun", entry, ...args];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSentinelError(code);
  }) as never);

  let exitCode: number | undefined;
  let exited = false;
  try {
    await import(`../src/${entry}.ts`);
  } catch (error) {
    if (error instanceof ExitSentinelError) {
      exited = true;
      exitCode = error.code;
    } else {
      throw error;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.argv = originalArgv;
  }
  return { errors, exitCode, exited, logs };
}
