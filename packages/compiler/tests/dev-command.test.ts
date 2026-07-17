/** Tests for src/site/dev-command.ts — `jx dev` resolution and spawn wiring. */

import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { resolveDevEntry, runDev } from "../src/site/dev-command.ts";

// The monorepo root has @jxsuite/server installed (workspace link) — a real resolution target.
const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Minimal ChildProcess stand-in: on/emit/kill, nothing more. */
function fakeChild(): ChildProcess & { emit: (event: string, arg?: unknown) => void } {
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  return {
    emit: (event: string, arg?: unknown) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(arg);
      }
    },
    kill: mock(() => true),
    on: (event: string, handler: (arg?: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ChildProcess & { emit: (event: string, arg?: unknown) => void };
}

describe("resolveDevEntry", () => {
  test("resolves @jxsuite/server/dev from a project with the dependency", () => {
    const entry = resolveDevEntry(REPO_ROOT);
    expect(entry).toContain("dev.ts");
  });

  test("throws an install hint when the package is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "jx-dev-"));
    try {
      mkdirSync(join(empty, "node_modules"), { recursive: true });
      writeFileSync(join(empty, "package.json"), "{}", "utf8");
      expect(() => resolveDevEntry(empty)).toThrow("Add it to devDependencies");
    } finally {
      rmSync(empty, { force: true, recursive: true });
    }
  });
});

describe("runDev", () => {
  test("spawns bun on the resolved entry with root and port args", () => {
    const child = fakeChild();
    const spawnImpl = mock(() => child);
    runDev(REPO_ROOT, 4000, spawnImpl as unknown as typeof spawn);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      { stdio: string },
    ];
    expect(cmd).toBe("bun");
    expect(args[0]).toContain("dev.ts");
    expect(args).toContain("--root");
    expect(args).toContain(REPO_ROOT);
    expect(args).toContain("--port");
    expect(args).toContain("4000");
    expect(opts.stdio).toBe("inherit");
  });

  test("omits --port when no port is given and mirrors the child exit code", () => {
    const child = fakeChild();
    const spawnImpl = mock(() => child);
    runDev(REPO_ROOT, undefined, spawnImpl as unknown as typeof spawn);

    const [, args] = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    expect(args).not.toContain("--port");

    const prevExitCode = process.exitCode;
    child.emit("exit", 3);
    expect(process.exitCode).toBe(3);
    process.exitCode = prevExitCode;
  });

  test("reports a Bun hint on ENOENT spawn errors", () => {
    const child = fakeChild();
    const spawnImpl = mock(() => child);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    const prevExitCode = process.exitCode;
    try {
      runDev(REPO_ROOT, undefined, spawnImpl as unknown as typeof spawn);
      const err = new Error("spawn bun ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      child.emit("error", err);
    } finally {
      console.error = origError;
    }
    expect(errors.some((e) => e.includes("bun.sh"))).toBe(true);
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExitCode;
  });
});
